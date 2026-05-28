import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companies } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('/api/tickers/[symbol]/holdings', () => {
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
        institutionalOwnership = vi.fn().mockResolvedValue([
          {
            ticker: 'AAPL',
            investor: 'BERKSHIRE HATHAWAY INC',
            cik: '0001067983',
            report_period: '2026-03-31',
            shares: 905_560_000,
            market_value: 263_012_040_000,
            price: 290.45,
            is_active: true,
            url: null,
            filing_date: '2026-05-14'
          }
        ]);
      }
    }));
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({ get: async () => 0, set: async () => undefined })
    }));
  });

  it('GET returns empty list + zero aggregate when no rows', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/holdings/route');
    const res = await GET(
      new Request('http://test.local/api/tickers/AAPL/holdings'),
      { params: { symbol: 'AAPL' } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.holdings).toEqual([]);
    expect(body.aggregate.totalHolders).toBe(0);
    expect(body.availablePeriods).toEqual([]);
  });

  it('POST refresh inserts holdings + returns summary', async () => {
    const { POST } = await import('@/app/api/tickers/[symbol]/holdings/route');
    const res = await POST(
      new Request('http://test.local/api/tickers/AAPL/holdings', { method: 'POST' }),
      { params: { symbol: 'AAPL' } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticker).toBe('AAPL');
    expect(body.fetched).toBe(1);
    expect(body.newRows).toBe(1);
  });

  it('GET after POST returns the inserted holding', async () => {
    const { POST, GET } = await import('@/app/api/tickers/[symbol]/holdings/route');
    await POST(
      new Request('http://test.local/api/tickers/AAPL/holdings', { method: 'POST' }),
      { params: { symbol: 'AAPL' } }
    );
    const res = await GET(
      new Request('http://test.local/api/tickers/AAPL/holdings'),
      { params: { symbol: 'AAPL' } }
    );
    const body = await res.json();
    expect(body.holdings).toHaveLength(1);
    expect(body.holdings[0].investorName).toBe('BERKSHIRE HATHAWAY INC');
    expect(body.availablePeriods).toEqual(['2026-03-31']);
  });

  it('GET returns 400 for invalid ticker', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/holdings/route');
    const res = await GET(
      new Request('http://test.local/api/tickers/x/holdings'),
      { params: { symbol: 'lowercase' } }
    );
    expect(res.status).toBe(400);
  });

  it('GET returns 400 for invalid period', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/holdings/route');
    const res = await GET(
      new Request('http://test.local/api/tickers/AAPL/holdings?period=not-a-date'),
      { params: { symbol: 'AAPL' } }
    );
    expect(res.status).toBe(400);
  });

  it('POST returns 429 when rate-limited', async () => {
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({ get: async () => 999, set: async () => undefined })
    }));
    vi.resetModules();
    const { POST } = await import('@/app/api/tickers/[symbol]/holdings/route');
    const res = await POST(
      new Request('http://test.local/api/tickers/AAPL/holdings', { method: 'POST' }),
      { params: { symbol: 'AAPL' } }
    );
    expect(res.status).toBe(429);
  });
});
