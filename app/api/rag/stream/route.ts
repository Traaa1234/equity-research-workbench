import { errorResponse } from '@/lib/api/errors';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { SearchService } from '@/lib/services/search';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';
import { RagService } from '@/lib/services/rag';
import { createGemini, GEMINI_MODEL } from '@/lib/providers/gemini';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface RagRequestBody {
  query?: unknown;
  scope?: unknown;
}

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const body = (await req.json().catch(() => ({}))) as RagRequestBody;

    if (typeof body.query !== 'string') {
      throw new ValidationError('query must be a string');
    }
    if (body.query.trim().length === 0) {
      throw new ValidationError('query is required');
    }
    if (body.query.length > 500) {
      throw new ValidationError('query exceeds 500 characters');
    }

    if (typeof body.scope !== 'object' || body.scope === null) {
      throw new ValidationError('scope is required');
    }
    const scope = body.scope as { type?: unknown; ticker?: unknown };
    if (scope.type !== 'watchlist' && scope.type !== 'ticker') {
      throw new ValidationError("scope.type must be 'watchlist' or 'ticker'");
    }
    if (scope.type === 'ticker') {
      if (typeof scope.ticker !== 'string' || !TICKER_RE.test(scope.ticker)) {
        throw new ValidationError('scope.ticker must be a valid ticker symbol');
      }
    }

    const db = getServiceDb();
    const searchService = new SearchService({
      db,
      provider: new EmbeddingsProviderImpl()
    });
    const gemini = createGemini();
    const model = gemini(GEMINI_MODEL);
    const rag = new RagService({ db, searchService, model });

    const result = await rag.answer({
      userId,
      query: body.query,
      scope: scope.type === 'ticker'
        ? { type: 'ticker', ticker: scope.ticker as string }
        : { type: 'watchlist' }
    });

    // AI SDK v6: StreamTextResult exposes toTextStreamResponse(init?: ResponseInit).
    // Sources are base64-encoded JSON in X-Rag-Sources header so the UI (T7.1)
    // can read them alongside the streamed text without a second round-trip.
    const sourcesHeader = Buffer.from(JSON.stringify(result.sources)).toString('base64');
    const response = result.streamResult.toTextStreamResponse({
      headers: {
        'X-Rag-Sources': sourcesHeader
      }
    });

    // After the stream is fully consumed, persist the Q&A record.
    // streamResult.text resolves to the complete text once the stream ends.
    result.streamResult.text.then(async (fullText) => {
      try {
        const usage = await result.streamResult.usage;
        await result.finalize(fullText, {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0
        });
      } catch {
        // finalize already logs; ignore here
      }
    });

    return response;
  } catch (err) {
    return errorResponse(err, { route: 'api/rag/stream POST' });
  }
}

export const maxDuration = 60;
