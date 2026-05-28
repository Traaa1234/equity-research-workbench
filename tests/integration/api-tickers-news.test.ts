import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companies } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('/api/tickers/[symbol]/news', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => newUserId(),
      getCurrentUserId: async () => newUserId(),
      UnauthorizedError: class extends Error {}
    }));
    vi.doMock('@/lib/db/client', () => ({
      getServiceDb: () => dbH.db
    }));
    vi.doMock('@/lib/providers/financial-datasets', () => ({
      FinancialDatasetsProvider: class {
        news = vi.fn().mockResolvedValue([
          { ticker: 'AAPL', title: 'Test bullish headline', source: 'CNBC', date: '2026-05-26T12:00:00+00:00', url: 'https://example.com/a' }
        ]);
      }
    }));
    vi.doMock('@/lib/providers/qwen', () => ({
      QwenProviderImpl: class {
        sentimentBatch = vi.fn().mockResolvedValue([{ sentiment: 'bullish', confidence: 0.85 }]);
      }
    }));
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({
        get: async () => 0,
        set: async () => undefined
      })
    }));
  });

  it('GET returns empty list + zero aggregate when no articles', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/news/route');
    const res = await GET(new Request('http://test.local/api/tickers/AAPL/news'), { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.articles).toEqual([]);
    expect(body.aggregate.totalScored).toBe(0);
  });

  it('POST refresh inserts + scores articles, returns summary', async () => {
    const { POST } = await import('@/app/api/tickers/[symbol]/news/route');
    const res = await POST(new Request('http://test.local/api/tickers/AAPL/news', { method: 'POST' }), { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticker).toBe('AAPL');
    expect(body.fetched).toBe(1);
    expect(body.newArticles).toBe(1);
    expect(body.scored).toBe(1);
  });

  it('GET after POST returns the scored article', async () => {
    const { POST, GET } = await import('@/app/api/tickers/[symbol]/news/route');
    await POST(new Request('http://test.local/api/tickers/AAPL/news', { method: 'POST' }), { params: { symbol: 'AAPL' } });
    const res = await GET(new Request('http://test.local/api/tickers/AAPL/news'), { params: { symbol: 'AAPL' } });
    const body = await res.json();
    expect(body.articles).toHaveLength(1);
    expect(body.articles[0].sentiment).toBe('bullish');
    expect(body.aggregate.totalScored).toBe(1);
    expect(body.aggregate.bullish).toBe(1);
  });

  it('GET returns 400 for invalid ticker', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/news/route');
    const res = await GET(new Request('http://test.local/api/tickers/x/news'), { params: { symbol: 'lowercase' } });
    expect(res.status).toBe(400);
  });

  it('POST returns 429 when rate-limited', async () => {
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({
        get: async () => 999,    // already over the limit
        set: async () => undefined
      })
    }));
    vi.resetModules();
    const { POST } = await import('@/app/api/tickers/[symbol]/news/route');
    const res = await POST(new Request('http://test.local/api/tickers/AAPL/news', { method: 'POST' }), { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(429);
  });
});
