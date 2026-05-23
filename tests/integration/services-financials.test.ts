import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { and, eq } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, fundamentals } from '@/lib/db/schema';
import { FinancialsService } from '@/lib/services/financials';
import { StatementBundle, RateLimitError } from '@/lib/providers/types';

config({ path: '.env.local' });

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK' as const;
    }),
    del: vi.fn(async (k: string) => {
      store.delete(k);
      return 1;
    }),
    _store: store
  };
}

const aaplIncomeBundle: StatementBundle = {
  ticker: 'AAPL',
  statementType: 'income',
  periodType: 'annual',
  rows: [
    { periodEnd: '2024-09-30', lineItem: 'revenue', value: 383285000000, currency: 'USD' },
    { periodEnd: '2024-09-30', lineItem: 'net_income', value: 99803000000, currency: 'USD' },
    { periodEnd: '2023-09-30', lineItem: 'revenue', value: 394328000000, currency: 'USD' }
  ]
};

describe('FinancialsService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => {
    dbH = makeTestServiceDb();
  });
  afterAll(async () => {
    await dbH.close();
  });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
  });

  it('refresh: persists rows to Postgres and Redis', async () => {
    const fd = {
      name: 'financial_datasets',
      statements: vi.fn().mockResolvedValue(aaplIncomeBundle)
    };
    const yf = { name: 'yfinance', statements: vi.fn() };
    const svc = new FinancialsService({
      db: dbH.db,
      primary: fd as any,
      fallback: yf as any,
      redis: fakeRedis() as any
    });

    const result = await svc.refresh('AAPL', 'income', 'annual');
    expect(result.rows).toHaveLength(3);

    const rows = await dbH.db
      .select()
      .from(fundamentals)
      .where(
        and(
          eq(fundamentals.ticker, 'AAPL'),
          eq(fundamentals.statementType, 'income')
        )
      );
    expect(rows).toHaveLength(3);
  });

  it('refresh: FD rate limited + yfinance throws -> service throws (yfinance has no statements)', async () => {
    const fd = {
      name: 'financial_datasets',
      statements: vi.fn().mockRejectedValue(new RateLimitError('429'))
    };
    const yf = {
      name: 'yfinance',
      statements: vi
        .fn()
        .mockRejectedValue(new Error('yfinance does not provide structured statements'))
    };
    const svc = new FinancialsService({
      db: dbH.db,
      primary: fd as any,
      fallback: yf as any,
      redis: fakeRedis() as any
    });

    await expect(svc.refresh('AAPL', 'income', 'annual')).rejects.toThrow();
  });

  it('get: reads from cache/DB after refresh, no second provider call', async () => {
    const fd = {
      name: 'financial_datasets',
      statements: vi.fn().mockResolvedValue(aaplIncomeBundle)
    };
    const svc = new FinancialsService({
      db: dbH.db,
      primary: fd as any,
      fallback: { name: 'yfinance', statements: vi.fn() } as any,
      redis: fakeRedis() as any
    });
    await svc.refresh('AAPL', 'income', 'annual');

    fd.statements.mockClear();
    const out = await svc.get('AAPL', 'income', 'annual');
    expect(out.rows.length).toBe(3);
    expect(fd.statements).not.toHaveBeenCalled();
  });
});
