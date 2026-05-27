import { streamText, simulateReadableStream, type StreamTextResult, type LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { count, eq } from 'drizzle-orm';
import { qaHistory, watchlist } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import { ValidationError } from '@/lib/providers/types';
import { logger } from '@/lib/logger';
import { SearchService, type SearchResult } from './search';
import { GEMINI_MODEL } from '@/lib/providers/gemini';

export const CURRENT_MODEL = GEMINI_MODEL;
export const CURRENT_PROMPT_VERSION = 'v1';
const MAX_OUTPUT_TOKENS = 800;
const RAG_MAX_DISTANCE = 0.55;
const RETRIEVAL_RAW_K = 30;
const RETRIEVAL_FINAL_K = 8;
const MAX_PER_FILING = 3;
const MIN_QUERY_CHARS = 1;
const MAX_QUERY_CHARS = 500;

export interface RagScope {
  type: 'watchlist' | 'ticker';
  ticker?: string;
}

export interface RagSource {
  marker: number;
  ticker: string;
  companyName: string;
  accessionNo: string;
  formType: string;
  filingDate: string;
  sectionKey: string;
  sectionTitle: string;
  subChunkIndex: number;
  snippet: string;
  distance: number;
}

interface Deps {
  db: ServiceDb;
  searchService: SearchService;
  model: LanguageModel;
}

export interface RagAnswerResult {
  sources: RagSource[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  streamResult: StreamTextResult<Record<string, never>, any>;
  finalize: (fullAnswerText: string, tokenUsage?: { input: number; output: number }) => Promise<void>;
}

const SYSTEM_PROMPT = `You are a senior equity research analyst answering investor questions using SEC filing excerpts. Rules:

1. Only use facts from the numbered sources below. Do NOT use outside knowledge or guess. If the sources don't contain the answer, say "The provided filings don't directly answer this. The closest relevant content is: [briefly summarize what was retrieved]."

2. Cite every factual claim with a bracketed marker matching the source number, e.g. "Revenue grew 14% to $96B [1]".

3. Be concise. Aim for 3-6 sentences, plus optional bullet points when the question asks for a list.

4. Use exact numbers, dates, and named entities from the sources. Avoid hedging ("appears", "seems", "may").

5. Do not summarize the entire filing. Answer ONLY the question asked.`;

const APOLOGY_STREAM_TEXT =
  "The provided filings don't contain content relevant to your question. Try rephrasing, or load filings for more of your watched tickers.";

export class RagService {
  constructor(private readonly deps: Deps) {}

  async answer(opts: {
    userId: string;
    query: string;
    scope: RagScope;
  }): Promise<RagAnswerResult> {
    const trimmed = opts.query.trim();
    if (trimmed.length < MIN_QUERY_CHARS) {
      throw new ValidationError('Query too short');
    }
    if (trimmed.length > MAX_QUERY_CHARS) {
      throw new ValidationError(`Query exceeds ${MAX_QUERY_CHARS} characters`);
    }
    if (opts.scope.type === 'ticker' && !opts.scope.ticker) {
      throw new ValidationError('scope.ticker required when scope.type=ticker');
    }

    // Retrieve top-30 raw
    const raw = await this.deps.searchService.searchAcrossWatchlist({
      userId: opts.userId,
      query: trimmed,
      limit: RETRIEVAL_RAW_K,
      maxDistance: RAG_MAX_DISTANCE,
      ...(opts.scope.type === 'ticker' && opts.scope.ticker
        ? { tickerScope: opts.scope.ticker }
        : {})
    });

    // If empty: check watchlist itself to distinguish empty-watchlist vs no-relevant-chunks
    if (raw.length === 0) {
      const hasWatchlist = await this.checkWatchlistNonEmpty(opts.userId);
      if (!hasWatchlist) {
        throw new ValidationError(
          'Watchlist is empty. Add tickers to your watchlist to ask questions about them.'
        );
      }
      // No relevant chunks: short-circuit with apology — no model call
      return this.buildApologyResult(opts);
    }

    // Per-filing diversity
    const sources = this.applyDiversity(raw);

    // Build the user prompt with numbered chunks
    const userPrompt = this.buildUserPrompt(trimmed, sources);

    // Stream the answer via AI SDK
    const streamResult = streamText({
      model: this.deps.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxOutputTokens: MAX_OUTPUT_TOKENS // v6: maxOutputTokens (not maxTokens)
    });

    const finalize = async (
      fullAnswerText: string,
      tokenUsage?: { input: number; output: number }
    ) => {
      try {
        // Warn if no citations found in the answer
        if (!/\[\d+\]/.test(fullAnswerText)) {
          logger.warn({ userId: opts.userId }, 'rag: answer contains no citation markers');
        }

        await this.deps.db.insert(qaHistory).values({
          userId: opts.userId,
          scopeType: opts.scope.type,
          scopeTicker: opts.scope.type === 'ticker' ? (opts.scope.ticker ?? null) : null,
          query: trimmed,
          answerText: fullAnswerText,
          citations: sources.map((s) => ({
            marker: s.marker,
            accessionNo: s.accessionNo,
            ticker: s.ticker,
            formType: s.formType,
            filingDate: s.filingDate,
            sectionKey: s.sectionKey,
            subChunkIndex: s.subChunkIndex,
            distance: s.distance
          })),
          model: CURRENT_MODEL,
          promptVersion: CURRENT_PROMPT_VERSION,
          inputTokens: tokenUsage?.input ?? null,
          outputTokens: tokenUsage?.output ?? null
        });
      } catch (err) {
        // Best-effort persistence — don't fail the UX
        logger.warn(
          { userId: opts.userId, err: String(err) },
          'rag: finalize persistence failed'
        );
      }
    };

    return { sources, streamResult, finalize };
  }

  // --- internal ---

  private async checkWatchlistNonEmpty(userId: string): Promise<boolean> {
    const rows = await this.deps.db
      .select({ c: count() })
      .from(watchlist)
      .where(eq(watchlist.userId, userId));
    return (rows[0]?.c ?? 0) > 0;
  }

  private applyDiversity(raw: SearchResult[]): RagSource[] {
    const counts: Record<string, number> = {};
    const out: RagSource[] = [];
    let marker = 1;
    for (const r of raw) {
      const n = counts[r.accessionNo] ?? 0;
      if (n >= MAX_PER_FILING) continue;
      counts[r.accessionNo] = n + 1;
      out.push({ marker, ...r });
      marker++;
      if (out.length >= RETRIEVAL_FINAL_K) break;
    }
    return out;
  }

  private buildUserPrompt(query: string, sources: RagSource[]): string {
    const chunks = sources
      .map(
        (s) =>
          `[${s.marker}] ${s.ticker} · ${s.formType} · filed ${s.filingDate} · ${s.sectionTitle}\n${s.snippet}`
      )
      .join('\n\n');
    return `Question: ${query}

Sources (each numbered chunk is a passage from an SEC filing):

${chunks}

Answer the question using only these sources. Cite with [N] markers.`;
  }

  private buildApologyResult(_opts: {
    userId: string;
    query: string;
    scope: RagScope;
  }): RagAnswerResult {
    // v6: MockLanguageModelV3 (not V1); finish chunk uses LanguageModelV3Usage nested shape
    const apologyModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'text-delta' as const,
              id: 'apology-0',
              delta: APOLOGY_STREAM_TEXT
            },
            {
              type: 'finish' as const,
              finishReason: 'stop' as const,
              usage: {
                inputTokens: {
                  total: 0,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined
                },
                outputTokens: { total: 0, text: undefined, reasoning: undefined }
              }
            }
          ]
        }),
        rawCall: { rawPrompt: null, rawSettings: {} }
      })
    });

    const streamResult = streamText({
      model: apologyModel,
      messages: [{ role: 'user', content: 'unused' }]
    });

    return {
      sources: [],
      streamResult,
      finalize: async () => {
        // Skip persistence for empty-retrieval queries
      }
    };
  }
}
