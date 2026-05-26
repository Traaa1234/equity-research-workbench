import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { SearchService } from '@/lib/services/search';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';

const ALLOWED_FORM_TYPES = new Set(['10-K', '10-Q']);

let svc: SearchService | null = null;
function service() {
  if (svc) return svc;
  svc = new SearchService({
    db: getServiceDb(),
    provider: new EmbeddingsProviderImpl()
  });
  return svc;
}

export async function GET(req: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(req.url);
    const q = url.searchParams.get('q');
    if (!q || q.trim().length === 0) {
      throw new ValidationError('Query parameter "q" is required');
    }
    if (q.length > 500) {
      throw new ValidationError('Query exceeds 500 characters');
    }
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw ? Math.max(1, Math.min(50, Number(limitRaw) || 10)) : undefined;

    const formTypesRaw = url.searchParams.get('form_types');
    let formTypes: string[] | undefined;
    if (formTypesRaw) {
      formTypes = formTypesRaw.split(',').map((s) => s.trim()).filter(Boolean);
      for (const ft of formTypes) {
        if (!ALLOWED_FORM_TYPES.has(ft)) {
          throw new ValidationError(`Unsupported form_type: ${ft}`);
        }
      }
    }

    const startedAt = Date.now();
    const results = await service().searchAcrossWatchlist({
      userId,
      query: q,
      ...(limit !== undefined ? { limit } : {}),
      ...(formTypes ? { formTypes } : {})
    });
    const elapsedMs = Date.now() - startedAt;

    let reason: string | null = null;
    if (results.length === 0) {
      reason = 'no_relevant_matches';
    }

    return ok({ results, elapsedMs, reason });
  } catch (err) {
    return errorResponse(err, { route: 'api/search GET' });
  }
}

export const maxDuration = 30;
