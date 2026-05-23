import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, fundamentals } from '@/lib/db/schema';
import { getRedisCache } from '@/lib/cache/redis';

config({ path: '.env.local' });

describe('GET /api/tickers/[symbol]/financials', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await getRedisCache().del('ticker:financials:AAPL:income:annual');
    await getRedisCache().del('ticker:financials:AAPL:balance:annual');
    await getRedisCache().del('ticker:financials:AAPL:cash_flow:annual');
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await dbH.db.insert(fundamentals).values([
      { ticker: 'AAPL', periodEnd: '2024-09-30', periodType: 'annual', statementType: 'income', lineItem: 'revenue', value: '383285000000', currency: 'USD', source: 'financial_datasets' },
      { ticker: 'AAPL', periodEnd: '2024-09-30', periodType: 'annual', statementType: 'income', lineItem: 'net_income', value: '99803000000', currency: 'USD', source: 'financial_datasets' }
    ]);
  });

  it('returns 200 with income annual data', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/financials/route');
    const req = new Request('http://localhost/api/tickers/AAPL/financials?type=income&period=annual');
    const res = await GET(req, { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.statementType).toBe('income');
    expect(body.periodType).toBe('annual');
  });

  it('defaults type=income and period=annual when params missing', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/financials/route');
    const req = new Request('http://localhost/api/tickers/AAPL/financials');
    const res = await GET(req, { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statementType).toBe('income');
  });

  it('rejects invalid type with 400', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/financials/route');
    const req = new Request('http://localhost/api/tickers/AAPL/financials?type=bogus');
    const res = await GET(req, { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(400);
  });
});
