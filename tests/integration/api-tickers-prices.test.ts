import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, prices } from '@/lib/db/schema';
import { getRedisCache } from '@/lib/cache/redis';

config({ path: '.env.local' });

describe('GET /api/tickers/[symbol]/prices', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await getRedisCache().del('ticker:prices:AAPL:1Y');
    await getRedisCache().del('ticker:prices:AAPL:5Y');
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await dbH.db.insert(prices).values([
      { ticker: 'AAPL', date: '2025-05-23', close: '189.40', volume: BigInt(50000000), source: 'financial_datasets' }
    ]);
  });

  it('returns 200 with 1Y prices by default', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/prices/route');
    const req = new Request('http://localhost/api/tickers/AAPL/prices');
    const res = await GET(req, { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('accepts range=5Y', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/prices/route');
    const req = new Request('http://localhost/api/tickers/AAPL/prices?range=5Y');
    const res = await GET(req, { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
  });

  it('rejects invalid range with 400', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/prices/route');
    const req = new Request('http://localhost/api/tickers/AAPL/prices?range=bogus');
    const res = await GET(req, { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(400);
  });
});
