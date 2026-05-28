import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, fundamentals, snapshots } from '@/lib/db/schema';
import { loadQuality } from '@/lib/services/quality';

config({ path: '.env.local' });

const TICKER = 'AAPL';

function seed(db: any, periodEnd: string, vals: Record<string, number>) {
  const stmtType: Record<string, string> = {
    revenue: 'income', cost_of_revenue: 'income', gross_profit: 'income',
    selling_general_admin: 'income', depreciation_amortization: 'income',
    operating_income: 'income', net_income: 'income',
    cash_and_equivalents: 'balance', accounts_receivable: 'balance',
    current_assets: 'balance', property_plant_equipment_net: 'balance',
    total_assets: 'balance', current_liabilities: 'balance',
    long_term_debt: 'balance', total_liabilities: 'balance',
    retained_earnings: 'balance', shares_outstanding: 'balance',
    operating_cash_flow: 'cash_flow'
  };
  return db.insert(fundamentals).values(
    Object.entries(vals).map(([lineItem, value]) => ({
      ticker: TICKER,
      periodEnd,
      periodType: 'annual',
      statementType: stmtType[lineItem] ?? 'income',
      lineItem,
      value: String(value),
      currency: 'USD',
      source: 'test'
    }))
  );
}

describe('loadQuality (integration)', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: TICKER, name: 'Apple Inc.' });
    await dbH.db.insert(snapshots).values({
      ticker: TICKER, price: '200.00', marketCap: '3000000000000',
      asOf: new Date(), source: 'test'
    });
  });

  it('pivots fundamentals rows and computes all three scores', async () => {
    // Seed 2 years of complete fundamentals
    await seed(dbH.db, '2024-09-28', {
      revenue: 1000, cost_of_revenue: 600, gross_profit: 400,
      selling_general_admin: 100, depreciation_amortization: 50,
      operating_income: 200, net_income: 180,
      operating_cash_flow: 200, accounts_receivable: 100,
      current_assets: 300, property_plant_equipment_net: 500,
      total_assets: 1000, current_liabilities: 200,
      long_term_debt: 300, total_liabilities: 400,
      retained_earnings: 200, shares_outstanding: 100
    });
    await seed(dbH.db, '2025-09-27', {
      revenue: 1100, cost_of_revenue: 650, gross_profit: 450,
      selling_general_admin: 105, depreciation_amortization: 52,
      operating_income: 220, net_income: 200,
      operating_cash_flow: 220, accounts_receivable: 105,
      current_assets: 320, property_plant_equipment_net: 525,
      total_assets: 1100, current_liabilities: 200,
      long_term_debt: 270, total_liabilities: 420,
      retained_earnings: 280, shares_outstanding: 100
    });

    const r = await loadQuality(dbH.db, 'AAPL');
    expect(r.current.piotroskiF).not.toBeNull();
    expect(r.current.altmanZ).not.toBeNull();
    expect(r.current.beneishM).not.toBeNull();
    expect(r.trend.length).toBeGreaterThan(0);
  });

  it('returns nulls when no data exists for a ticker', async () => {
    const r = await loadQuality(dbH.db, 'NOTHERE');
    expect(r.current.piotroskiF).toBeNull();
    expect(r.current.altmanZ).toBeNull();
    expect(r.current.beneishM).toBeNull();
  });
});
