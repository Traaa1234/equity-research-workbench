import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, fundamentals, prices, earnings } from '@/lib/db/schema';
import {
  upsertFundamentals,
  upsertPrices,
  upsertEarnings
} from '@/lib/cache/postgres';

config({ path: '.env.local' });

describe('cache/postgres bulk upserts', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
  });

  it('upsertFundamentals replaces by composite PK', async () => {
    const rows = [
      { ticker: 'AAPL', periodEnd: '2024-09-30', periodType: 'annual', statementType: 'income', lineItem: 'revenue', value: '383285000000', currency: 'USD', source: 'financial_datasets' },
      { ticker: 'AAPL', periodEnd: '2024-09-30', periodType: 'annual', statementType: 'income', lineItem: 'net_income', value: '99803000000', currency: 'USD', source: 'financial_datasets' }
    ];
    await upsertFundamentals(dbH.db, rows as any);

    await upsertFundamentals(dbH.db, [
      { ...rows[0]!, value: '999999999999' }
    ] as any);

    const all = await dbH.db.select().from(fundamentals);
    expect(all).toHaveLength(2);
    const rev = all.find((r) => r.lineItem === 'revenue')!;
    expect(rev.value).toBe('999999999999.00');
  });

  it('upsertPrices inserts daily rows', async () => {
    await upsertPrices(dbH.db, [
      { ticker: 'AAPL', date: '2025-05-23', close: '189.40', volume: BigInt(50000000), source: 'financial_datasets', open: '188.00', high: '190.50', low: '187.20', adjClose: '189.40' }
    ] as any);

    const rows = await dbH.db.select().from(prices);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.close).toBe('189.4000');
  });

  it('upsertEarnings replaces by composite PK', async () => {
    await upsertEarnings(dbH.db, [
      { ticker: 'AAPL', periodEnd: '2024-12-31', reportedDate: '2025-01-30', epsActual: '2.40', source: 'financial_datasets' }
    ] as any);

    await upsertEarnings(dbH.db, [
      { ticker: 'AAPL', periodEnd: '2024-12-31', reportedDate: '2025-01-30', epsActual: '2.50', source: 'yfinance' }
    ] as any);

    const rows = await dbH.db.select().from(earnings);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.epsActual).toBe('2.5000');
    expect(rows[0]!.source).toBe('yfinance');
  });
});
