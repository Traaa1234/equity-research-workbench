import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companies, institutionalHoldings } from '@/lib/db/schema';

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
    vi.doMock('@/lib/providers/sec-edgar', () => ({
      SecEdgarProviderImpl: class {
        thirteenFFilings = vi.fn(async (cik: string) => ({
          cik: cik.padStart(10, '0'),
          investorName: 'UNUSED',
          filings: []
        }));
      }
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

  it('GET with data returns the inserted holding', async () => {
    await dbH.db.insert(institutionalHoldings).values({
      ticker: 'AAPL',
      investorId: '0001067983',
      investorName: 'BERKSHIRE HATHAWAY INC',
      reportPeriod: '2026-03-31',
      shares: '905560000',
      filingDate: '2026-03-31',
      marketValue: '263012040000'
    });
    const { GET } = await import('@/app/api/tickers/[symbol]/holdings/route');
    const res = await GET(
      new Request('http://test.local/api/tickers/AAPL/holdings'),
      { params: { symbol: 'AAPL' } }
    );
    expect(res.status).toBe(200);
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
});
