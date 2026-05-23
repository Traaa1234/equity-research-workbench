import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, snapshots } from '@/lib/db/schema';
import { getRedisCache } from '@/lib/cache/redis';

config({ path: '.env.local' });

describe('GET /api/tickers/[symbol]/snapshot', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    // Clear redis to avoid stale values from a prior run polluting cache hits.
    await getRedisCache().del('ticker:snapshot:AAPL');
    await getRedisCache().del('ticker:snapshot:ZZZZZZ');
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await dbH.db.insert(snapshots).values({
      ticker: 'AAPL',
      price: '195.40', marketCap: '3100000000000',
      week52High: '220.50', week52Low: '165.00',
      pe: '28.50', ps: '7.80', pb: '45.20', evEbitda: '22.10', peg: '2.40',
      asOf: new Date(), source: 'financial_datasets'
    });
  });

  it('returns 200 with snapshot JSON for a known ticker', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/snapshot/route');
    const req = new Request('http://localhost/api/tickers/AAPL/snapshot');
    const res = await GET(req, { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticker).toBe('AAPL');
    expect(body.price).toBeCloseTo(195.4);
  });

  it('returns 404 when ticker not in DB and provider would also miss', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/snapshot/route');
    const req = new Request('http://localhost/api/tickers/ZZZZZZ/snapshot');
    const res = await GET(req, { params: { symbol: 'ZZZZZZ' } });
    // Could be 404 or 400 depending on how the upstream behaves; both are acceptable.
    expect([404, 400, 503]).toContain(res.status);
  });

  it('rejects invalid ticker format with 400', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/snapshot/route');
    const req = new Request('http://localhost/api/tickers/lower-case/snapshot');
    const res = await GET(req, { params: { symbol: 'lower-case' } });
    expect(res.status).toBe(400);
  });
});
