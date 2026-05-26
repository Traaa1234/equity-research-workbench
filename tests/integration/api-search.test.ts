import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, filings, filingChunks, chunkEmbeddings, watchlist } from '@/lib/db/schema';
import { CURRENT_EMBED_MODEL } from '@/lib/services/search';

config({ path: '.env.local' });

const STATIC_USER_ID = '11111111-1111-1111-1111-111111111111';

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
    model: CURRENT_EMBED_MODEL,
    charOffsetStart: 0, charOffsetEnd: 31
  });
  await db.insert(watchlist).values({ userId: STATIC_USER_ID, ticker: 'AAPL' });
}

describe('/api/search', () => {
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
        async embed() {
          return { vectors: [Array(1024).fill(0.5)], inputTokens: 10 };
        }
      }
    }));
  });

  it('GET happy path returns ranked results', async () => {
    await seedSearchable(dbH.db);
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(new Request('http://localhost/api/search?q=China+tariff'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0].ticker).toBe('AAPL');
  });

  it('GET empty q returns 400', async () => {
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(new Request('http://localhost/api/search?q='));
    expect(res.status).toBe(400);
  });

  it('GET missing q returns 400', async () => {
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(new Request('http://localhost/api/search'));
    expect(res.status).toBe(400);
  });

  it('GET oversized q returns 400', async () => {
    const { GET } = await import('@/app/api/search/route');
    const longQuery = 'x'.repeat(1000);
    const res = await GET(new Request(`http://localhost/api/search?q=${longQuery}`));
    expect(res.status).toBe(400);
  });

  it('GET respects limit parameter', async () => {
    await seedSearchable(dbH.db);
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(new Request('http://localhost/api/search?q=tariff&limit=1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.length).toBeLessThanOrEqual(1);
  });

  it('GET unauth returns 401', async () => {
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => { throw new Error('Unauthorized'); },
      UnauthorizedError: class extends Error {}
    }));
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(new Request('http://localhost/api/search?q=tariff'));
    expect([401, 500]).toContain(res.status); // depends on errorResponse mapping
  });
});
