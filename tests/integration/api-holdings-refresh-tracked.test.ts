import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companies } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('POST /api/holdings/refresh-tracked', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values([
      { ticker: 'AAPL',  name: 'Apple',     cik: null },
      { ticker: 'NVDA',  name: 'NVIDIA',    cik: null },
      { ticker: 'MSFT',  name: 'Microsoft', cik: null },
      { ticker: 'GOOGL', name: 'Alphabet',  cik: null },
      { ticker: 'TSLA',  name: 'Tesla',     cik: null },
      { ticker: 'JD',    name: 'JD.com',    cik: null }
    ]);
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => newUserId(),
      getCurrentUserId: async () => newUserId(),
      UnauthorizedError: class extends Error {}
    }));
    vi.doMock('@/lib/db/client', () => ({ getServiceDb: () => dbH.db }));
    vi.doMock('@/lib/providers/sec-edgar', () => ({
      SecEdgarProviderImpl: class {
        thirteenFFilings = vi.fn(async (cik: string) => {
          const padded = cik.padStart(10, '0');
          if (padded === '0001067983') {
            return {
              cik: '0001067983',
              investorName: 'BERKSHIRE HATHAWAY INC',
              filings: [{
                accession: 'acc-2026-03-31',
                filingDate: '2026-03-31',
                reportPeriod: '2026-03-31',
                formType: '13F-HR',
                positions: [{
                  cusip: '037833100',
                  issuerName: 'APPLE INC',
                  classTitle: 'COM',
                  valueUsd: 263_012_040_000,
                  shares: 905_560_000,
                  sharesType: 'SH'
                }]
              }]
            };
          }
          return { cik: padded, investorName: 'OTHER', filings: [] };
        });
      }
    }));
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({ get: async () => 0, set: async () => undefined })
    }));
  });

  it('POST happy path: inserts holdings and returns summary', async () => {
    const { POST } = await import('@/app/api/holdings/refresh-tracked/route');
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.investorsAttempted).toBeGreaterThan(0);
    expect(body.investorsSucceeded).toBeGreaterThan(0);
    expect(body.newRows).toBe(1);   // 1 Berkshire AAPL row
  });

  it('POST returns 429 when rate-limited', async () => {
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({ get: async () => 999, set: async () => undefined })
    }));
    vi.resetModules();
    const { POST } = await import('@/app/api/holdings/refresh-tracked/route');
    const res = await POST();
    expect(res.status).toBe(429);
  });
});
