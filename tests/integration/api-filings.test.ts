import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companies, filings } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('/api/tickers/[symbol]/filings', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => newUserId(),
      getCurrentUserId: async () => newUserId(),
      UnauthorizedError: class extends Error {}
    }));
  });

  it('GET returns empty + needsIngest=true when no filings exist', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    const { GET } = await import('@/app/api/tickers/[symbol]/filings/route');
    const res = await GET(new Request('http://localhost/api/tickers/AAPL/filings'), { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filings).toEqual([]);
    expect(body.needsIngest).toBe(true);
  });

  it('GET returns populated list when filings exist', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await dbH.db.insert(filings).values({
      accessionNo: '0000320193-24-000123',
      ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01',
      primaryDocUrl: 'https://x'
    });
    const { GET } = await import('@/app/api/tickers/[symbol]/filings/route');
    const res = await GET(new Request('http://localhost/api/tickers/AAPL/filings'), { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filings).toHaveLength(1);
    expect(body.needsIngest).toBe(false);
  });

  it('GET 400 on invalid ticker', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/filings/route');
    const res = await GET(new Request('http://localhost/api/tickers/lower-case/filings'), { params: { symbol: 'lower-case' } });
    expect(res.status).toBe(400);
  });

  // POST tests intentionally don't fire a real ingest (would hit live SEC).
  it('POST 400 on invalid ticker', async () => {
    const { POST } = await import('@/app/api/tickers/[symbol]/filings/route');
    const res = await POST(new Request('http://localhost/api/tickers/bogus-1/filings', { method: 'POST' }), { params: { symbol: 'bogus-1' } });
    expect(res.status).toBe(400);
  });
});
