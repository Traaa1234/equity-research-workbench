import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companies } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('/api/tickers/[symbol]/insiders', () => {
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
        insiderTrades = vi.fn().mockResolvedValue([
          {
            ticker: 'AAPL', issuer: 'Apple Inc.', name: 'Alice',
            title: 'CFO', is_board_director: false,
            transaction_date: '2026-05-20', transaction_type: 'Open market purchase',
            transaction_shares: 1000, transaction_price_per_share: 290, transaction_value: 290000,
            shares_owned_before_transaction: 5000, shares_owned_after_transaction: 6000,
            security_title: 'Common Stock', filing_date: '2026-05-21'
          }
        ]);
      }
    }));
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({
        get: async () => 0,
        set: async () => undefined
      })
    }));
  });

  it('GET returns empty list + zero aggregate when no transactions', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/insiders/route');
    const res = await GET(
      new Request('http://test.local/api/tickers/AAPL/insiders'),
      { params: { symbol: 'AAPL' } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toEqual([]);
    expect(body.aggregate.buyCount).toBe(0);
    expect(body.aggregate.sellCount).toBe(0);
  });

  it('POST refresh inserts transactions + returns summary', async () => {
    const { POST } = await import('@/app/api/tickers/[symbol]/insiders/route');
    const res = await POST(
      new Request('http://test.local/api/tickers/AAPL/insiders', { method: 'POST' }),
      { params: { symbol: 'AAPL' } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticker).toBe('AAPL');
    expect(body.fetched).toBe(1);
    expect(body.newRows).toBe(1);
  });

  it('GET after POST returns the inserted transaction', async () => {
    const { POST, GET } = await import('@/app/api/tickers/[symbol]/insiders/route');
    await POST(
      new Request('http://test.local/api/tickers/AAPL/insiders', { method: 'POST' }),
      { params: { symbol: 'AAPL' } }
    );
    const res = await GET(
      new Request('http://test.local/api/tickers/AAPL/insiders'),
      { params: { symbol: 'AAPL' } }
    );
    const body = await res.json();
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0].insiderName).toBe('Alice');
  });

  it('GET returns 400 for invalid ticker', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/insiders/route');
    const res = await GET(
      new Request('http://test.local/api/tickers/x/insiders'),
      { params: { symbol: 'lowercase' } }
    );
    expect(res.status).toBe(400);
  });

  it('POST returns 429 when rate-limited', async () => {
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({
        get: async () => 999,
        set: async () => undefined
      })
    }));
    vi.resetModules();
    const { POST } = await import('@/app/api/tickers/[symbol]/insiders/route');
    const res = await POST(
      new Request('http://test.local/api/tickers/AAPL/insiders', { method: 'POST' }),
      { params: { symbol: 'AAPL' } }
    );
    expect(res.status).toBe(429);
  });
});
