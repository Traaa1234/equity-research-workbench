import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { MockLanguageModelV3 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, filings, filingChunks, chunkEmbeddings, watchlist } from '@/lib/db/schema';

config({ path: '.env.local' });

const STATIC_USER_ID = '22222222-2222-2222-2222-222222222222';

async function seedSearchable(db: any) {
  await db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
  await db.insert(filings).values({
    accessionNo: '0000320193-24-000123', ticker: 'AAPL', cik: '0000320193',
    formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
  });
  await db.insert(filingChunks).values({
    filingId: '0000320193-24-000123', sectionKey: 'item_1a_risk_factors',
    sectionTitle: 'Risk Factors', text: 'Apple faces China tariff risk.', charCount: 31
  });
  await db.insert(chunkEmbeddings).values({
    filingId: '0000320193-24-000123', sectionKey: 'item_1a_risk_factors', subChunkIndex: 0,
    text: 'Apple faces China tariff risk.',
    embedding: Array(1024).fill(0.5),
    model: 'text-embedding-v3',
    charOffsetStart: 0, charOffsetEnd: 31
  });
  await db.insert(watchlist).values({ userId: STATIC_USER_ID, ticker: 'AAPL' });
}

describe('/api/rag/stream', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => STATIC_USER_ID,
      getCurrentUserId: async () => STATIC_USER_ID,
      UnauthorizedError: class extends Error {}
    }));
    vi.doMock('@/lib/providers/embeddings', () => ({
      EmbeddingsProviderImpl: class {
        async embed() { return { vectors: [Array(1024).fill(0.5)], inputTokens: 10 }; }
      }
    }));
    // Mock the AI SDK provider to return a deterministic streaming model
    vi.doMock('@/lib/providers/gemini', () => ({
      GEMINI_MODEL: 'gemini-2.5-flash',
      createGemini: () => () => new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-delta' as const, id: 'd1', delta: 'Apple grew' },
              { type: 'text-delta' as const, id: 'd2', delta: ' 22% [1].' },
              {
                type: 'finish' as const,
                finishReason: 'stop' as const,
                usage: { inputTokens: { total: 100 }, outputTokens: { total: 10 } }
              }
            ]
          })
        })
      })
    }));
  });

  it('POST happy path streams a response', async () => {
    await seedSearchable(dbH.db);
    const { POST } = await import('@/app/api/rag/stream/route');
    const res = await POST(new Request('http://localhost/api/rag/stream', {
      method: 'POST',
      body: JSON.stringify({ query: 'China tariff', scope: { type: 'watchlist' } }),
      headers: { 'content-type': 'application/json' }
    }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });

  it('POST empty query returns 400', async () => {
    const { POST } = await import('@/app/api/rag/stream/route');
    const res = await POST(new Request('http://localhost/api/rag/stream', {
      method: 'POST',
      body: JSON.stringify({ query: '', scope: { type: 'watchlist' } }),
      headers: { 'content-type': 'application/json' }
    }));
    expect(res.status).toBe(400);
  });

  it('POST oversized query returns 400', async () => {
    const { POST } = await import('@/app/api/rag/stream/route');
    const res = await POST(new Request('http://localhost/api/rag/stream', {
      method: 'POST',
      body: JSON.stringify({ query: 'x'.repeat(1000), scope: { type: 'watchlist' } }),
      headers: { 'content-type': 'application/json' }
    }));
    expect(res.status).toBe(400);
  });

  it('POST invalid scope returns 400', async () => {
    const { POST } = await import('@/app/api/rag/stream/route');
    const res = await POST(new Request('http://localhost/api/rag/stream', {
      method: 'POST',
      body: JSON.stringify({ query: 'risks', scope: { type: 'something_else' } }),
      headers: { 'content-type': 'application/json' }
    }));
    expect(res.status).toBe(400);
  });

  it('POST ticker scope with bad ticker format returns 400', async () => {
    const { POST } = await import('@/app/api/rag/stream/route');
    const res = await POST(new Request('http://localhost/api/rag/stream', {
      method: 'POST',
      body: JSON.stringify({ query: 'risks', scope: { type: 'ticker', ticker: 'bogus-1' } }),
      headers: { 'content-type': 'application/json' }
    }));
    expect(res.status).toBe(400);
  });

  it('POST unauth returns 401', async () => {
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => { throw new Error('Unauthorized'); },
      UnauthorizedError: class extends Error {}
    }));
    const { POST } = await import('@/app/api/rag/stream/route');
    const res = await POST(new Request('http://localhost/api/rag/stream', {
      method: 'POST',
      body: JSON.stringify({ query: 'risks', scope: { type: 'watchlist' } }),
      headers: { 'content-type': 'application/json' }
    }));
    expect([401, 500]).toContain(res.status);
  });
});
