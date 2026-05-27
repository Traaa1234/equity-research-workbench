// tests/integration/rag-service.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { MockLanguageModelV3 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companies, filings, filingChunks, chunkEmbeddings, watchlist, qaHistory } from '@/lib/db/schema';
import { SearchService, CURRENT_EMBED_MODEL } from '@/lib/services/search';
import { RagService, CURRENT_MODEL, CURRENT_PROMPT_VERSION } from '@/lib/services/rag';
import { ValidationError } from '@/lib/providers/types';

config({ path: '.env.local' });

// v6: LanguageModelV3Usage has nested shape for the doStream finish chunk
function makeV3Usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: { total: inputTokens, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: undefined, reasoning: undefined }
  };
}

function mockEmbeddingsProvider(queryVector?: number[]) {
  return {
    embed: vi.fn().mockImplementation(async () => ({
      vectors: [queryVector ?? Array(1024).fill(0.5)],
      inputTokens: 10
    }))
  };
}

function mockLanguageModel(
  chunks: string[],
  usage = { promptTokens: 4100, completionTokens: 200 }
) {
  // v6: text-delta chunk requires { type, id, delta } shape; finish requires LanguageModelV3Usage
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          ...chunks.map((delta, i) => ({
            type: 'text-delta' as const,
            id: `chunk-${i}`,
            delta
          })),
          {
            type: 'finish' as const,
            finishReason: 'stop' as const,
            usage: makeV3Usage(usage.promptTokens, usage.completionTokens)
          }
        ]
      }),
      rawCall: { rawPrompt: null, rawSettings: {} }
    })
  });
}

async function seedFilingWithEmbedding(
  db: any,
  ticker: string,
  accessionSuffix: string,
  vector: number[],
  sectionKey = 'item_1a_risk_factors'
) {
  await db.insert(companies).values({ ticker, name: `${ticker} Corp` }).onConflictDoNothing();
  const accession = `0000${ticker.slice(0, 4).padEnd(4, '0').toUpperCase()}-24-${accessionSuffix.padStart(6, '0')}`;
  await db.insert(filings).values({
    accessionNo: accession,
    ticker,
    cik: '0000000001',
    formType: '10-K',
    filingDate: '2024-11-01',
    primaryDocUrl: 'https://x'
  });
  await db.insert(filingChunks).values({
    filingId: accession,
    sectionKey,
    sectionTitle: 'Risk Factors',
    text: `${ticker} faces risks in ${sectionKey}`,
    charCount: 30
  });
  await db.insert(chunkEmbeddings).values({
    filingId: accession,
    sectionKey,
    subChunkIndex: 0,
    text: `${ticker} faces risks in ${sectionKey}`,
    embedding: vector,
    model: CURRENT_EMBED_MODEL,
    charOffsetStart: 0,
    charOffsetEnd: 30
  });
  return accession;
}

describe('RagService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  let userId: string;

  beforeAll(() => {
    dbH = makeTestServiceDb();
  });
  afterAll(async () => {
    await dbH.close();
  });
  beforeEach(async () => {
    await resetDb(dbH.db);
    userId = newUserId();
  });

  function buildService(modelChunks: string[] = ['Apple grew', ' 22% [1]', '.']) {
    const embProvider = mockEmbeddingsProvider();
    const searchSvc = new SearchService({ db: dbH.db, provider: embProvider as any });
    const model = mockLanguageModel(modelChunks);
    return new RagService({ db: dbH.db, searchService: searchSvc, model });
  }

  it('answer: cross-watchlist returns sources from multiple tickers', async () => {
    const vec = Array(1024).fill(0.5);
    await seedFilingWithEmbedding(dbH.db, 'AAPL', '1', vec);
    await seedFilingWithEmbedding(dbH.db, 'NVDA', '1', vec);
    await dbH.db
      .insert(watchlist)
      .values([{ userId, ticker: 'AAPL' }, { userId, ticker: 'NVDA' }]);

    const svc = buildService();
    const result = await svc.answer({ userId, query: 'tariffs', scope: { type: 'watchlist' } });

    expect(result.sources.length).toBeGreaterThanOrEqual(2);
    const tickers = new Set(result.sources.map((s) => s.ticker));
    expect(tickers.size).toBeGreaterThanOrEqual(2);
  });

  it('answer: ticker scope limits sources to one ticker', async () => {
    const vec = Array(1024).fill(0.5);
    await seedFilingWithEmbedding(dbH.db, 'AAPL', '1', vec);
    await seedFilingWithEmbedding(dbH.db, 'NVDA', '1', vec);
    await dbH.db
      .insert(watchlist)
      .values([{ userId, ticker: 'AAPL' }, { userId, ticker: 'NVDA' }]);

    const svc = buildService();
    const result = await svc.answer({ userId, query: 'risks', scope: { type: 'ticker', ticker: 'AAPL' } });

    expect(result.sources.every((s) => s.ticker === 'AAPL')).toBe(true);
  });

  it('answer: per-filing diversity caps at 3 chunks per filing', async () => {
    const vec = Array(1024).fill(0.5);
    // Seed one filing with 5 chunks all matching closely
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    const accession = '0000320193-24-000123';
    await dbH.db.insert(filings).values({
      accessionNo: accession,
      ticker: 'AAPL',
      cik: '0000320193',
      formType: '10-K',
      filingDate: '2024-11-01',
      primaryDocUrl: 'https://x'
    });
    for (let i = 0; i < 5; i++) {
      await dbH.db.insert(filingChunks).values({
        filingId: accession,
        sectionKey: `section_${i}`,
        sectionTitle: `S${i}`,
        text: `chunk ${i}`,
        charCount: 7
      });
      await dbH.db.insert(chunkEmbeddings).values({
        filingId: accession,
        sectionKey: `section_${i}`,
        subChunkIndex: 0,
        text: `chunk ${i}`,
        embedding: vec,
        model: CURRENT_EMBED_MODEL,
        charOffsetStart: 0,
        charOffsetEnd: 7
      });
    }
    // Seed a second filing with 5 also matching
    await dbH.db.insert(filings).values({
      accessionNo: '0000320193-24-000080',
      ticker: 'AAPL',
      cik: '0000320193',
      formType: '10-Q',
      filingDate: '2024-08-02',
      primaryDocUrl: 'https://y'
    });
    for (let i = 0; i < 5; i++) {
      await dbH.db.insert(filingChunks).values({
        filingId: '0000320193-24-000080',
        sectionKey: `section_q_${i}`,
        sectionTitle: `Q${i}`,
        text: `q chunk ${i}`,
        charCount: 9
      });
      await dbH.db.insert(chunkEmbeddings).values({
        filingId: '0000320193-24-000080',
        sectionKey: `section_q_${i}`,
        subChunkIndex: 0,
        text: `q chunk ${i}`,
        embedding: vec,
        model: CURRENT_EMBED_MODEL,
        charOffsetStart: 0,
        charOffsetEnd: 9
      });
    }
    await dbH.db.insert(watchlist).values({ userId, ticker: 'AAPL' });

    const svc = buildService();
    const result = await svc.answer({ userId, query: 'risks', scope: { type: 'watchlist' } });

    // Count chunks per filing
    const counts = result.sources.reduce<Record<string, number>>((acc, s) => {
      acc[s.accessionNo] = (acc[s.accessionNo] ?? 0) + 1;
      return acc;
    }, {});
    for (const [acc, count] of Object.entries(counts)) {
      expect(count, `filing ${acc} has too many chunks`).toBeLessThanOrEqual(3);
    }
  });

  it('answer: empty watchlist throws ValidationError', async () => {
    const svc = buildService();
    await expect(
      svc.answer({ userId, query: 'tariffs', scope: { type: 'watchlist' } })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('answer: empty retrieval short-circuits with apologetic stream and no model call', async () => {
    // User has watchlist but no embeddings exist
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await dbH.db.insert(watchlist).values({ userId, ticker: 'AAPL' });

    const embProvider = mockEmbeddingsProvider();
    const searchSvc = new SearchService({ db: dbH.db, provider: embProvider as any });
    const modelCallCount = { n: 0 };
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCallCount.n++;
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'finish' as const,
                finishReason: 'stop' as const,
                usage: makeV3Usage(0, 0)
              }
            ]
          }),
          rawCall: { rawPrompt: null, rawSettings: {} }
        };
      }
    });
    const svc = new RagService({ db: dbH.db, searchService: searchSvc, model });

    const result = await svc.answer({ userId, query: 'tariffs', scope: { type: 'watchlist' } });

    expect(result.sources).toHaveLength(0);
    expect(modelCallCount.n).toBe(0); // never called the LLM
    // The stream should still produce some apologetic text
    let accumulated = '';
    const reader = (await result.streamResult.toTextStreamResponse()).body!.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value);
    }
    expect(accumulated.toLowerCase()).toContain("don't");
  });

  it('finalize: persists qa_history row after successful stream', async () => {
    const vec = Array(1024).fill(0.5);
    await seedFilingWithEmbedding(dbH.db, 'AAPL', '1', vec);
    await dbH.db.insert(watchlist).values({ userId, ticker: 'AAPL' });

    const svc = buildService();
    const result = await svc.answer({ userId, query: 'tariffs', scope: { type: 'watchlist' } });

    // Simulate stream completion by calling finalize with the assembled answer
    await result.finalize('Apple grew 22% [1].', { input: 4100, output: 200 });

    const rows = await dbH.db.select().from(qaHistory).where(eq(qaHistory.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answerText).toBe('Apple grew 22% [1].');
    expect(rows[0]!.model).toBe(CURRENT_MODEL);
    expect(rows[0]!.promptVersion).toBe(CURRENT_PROMPT_VERSION);
    expect(rows[0]!.scopeType).toBe('watchlist');
    expect(rows[0]!.inputTokens).toBe(4100);
    expect(rows[0]!.outputTokens).toBe(200);
  });

  it('finalize: persists zero-citation answer with warning logged', async () => {
    const vec = Array(1024).fill(0.5);
    await seedFilingWithEmbedding(dbH.db, 'AAPL', '1', vec);
    await dbH.db.insert(watchlist).values({ userId, ticker: 'AAPL' });

    const svc = buildService();
    const result = await svc.answer({ userId, query: 'tariffs', scope: { type: 'watchlist' } });

    // Answer with no [N] markers
    await result.finalize('Apple is a company that does things.', { input: 4100, output: 100 });

    const rows = await dbH.db.select().from(qaHistory).where(eq(qaHistory.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answerText).toBe('Apple is a company that does things.');
  });

  it('finalize: DB write failure does not throw', async () => {
    const vec = Array(1024).fill(0.5);
    await seedFilingWithEmbedding(dbH.db, 'AAPL', '1', vec);
    await dbH.db.insert(watchlist).values({ userId, ticker: 'AAPL' });

    const svc = buildService();
    const result = await svc.answer({ userId, query: 'tariffs', scope: { type: 'watchlist' } });

    // Close the connection to force INSERT to fail
    await dbH.close();

    // finalize() should swallow the error, not throw
    await expect(
      result.finalize('Apple grew [1].', { input: 4100, output: 50 })
    ).resolves.toBeUndefined();

    // Reopen for cleanup
    dbH = makeTestServiceDb();
  });
});
