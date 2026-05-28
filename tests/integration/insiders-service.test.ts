import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, insiderTrades, refreshRuns } from '@/lib/db/schema';
import { InsidersService } from '@/lib/services/insiders';
import type { InsiderTradeMeta } from '@/lib/providers/types';

config({ path: '.env.local' });

function mockFdProvider(trades: InsiderTradeMeta[]) {
  return {
    insiderTrades: vi.fn().mockResolvedValue(trades)
  };
}

const SAMPLE_TRADES: InsiderTradeMeta[] = [
  {
    ticker: 'AAPL', issuer: 'Apple Inc.', name: 'Alice',
    title: 'CFO', is_board_director: false,
    transaction_date: '2026-05-20', transaction_type: 'Open market purchase',
    transaction_shares: 1000, transaction_price_per_share: 290, transaction_value: 290000,
    shares_owned_before_transaction: 5000, shares_owned_after_transaction: 6000,
    security_title: 'Common Stock', filing_date: '2026-05-21'
  },
  {
    ticker: 'AAPL', issuer: 'Apple Inc.', name: 'Bob',
    title: null, is_board_director: true,
    transaction_date: '2026-05-15', transaction_type: 'Open market sale',
    transaction_shares: 500, transaction_price_per_share: 285, transaction_value: 142500,
    shares_owned_before_transaction: 10000, shares_owned_after_transaction: 9500,
    security_title: 'Common Stock', filing_date: '2026-05-16'
  }
];

describe('InsidersService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.', cik: null });
  });

  it('refresh: fetches, inserts, writes refresh_run', async () => {
    const fd = mockFdProvider(SAMPLE_TRADES);
    const svc = new InsidersService({ db: dbH.db, fdProvider: fd as any });

    const summary = await svc.refresh('AAPL');

    expect(summary.fetched).toBe(2);
    expect(summary.newRows).toBe(2);

    const rows = await dbH.db.select().from(insiderTrades).where(eq(insiderTrades.ticker, 'AAPL'));
    expect(rows).toHaveLength(2);

    const runs = await dbH.db.select().from(refreshRuns).where(eq(refreshRuns.ticker, 'AAPL'));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(true);
    expect(runs[0]!.kind).toBe('insiders');
  });

  it('refresh: idempotent — second call dedupes by composite key', async () => {
    const fd = mockFdProvider(SAMPLE_TRADES);
    const svc = new InsidersService({ db: dbH.db, fdProvider: fd as any });

    await svc.refresh('AAPL');
    const second = await svc.refresh('AAPL');

    expect(second.newRows).toBe(0);

    const rows = await dbH.db.select().from(insiderTrades).where(eq(insiderTrades.ticker, 'AAPL'));
    expect(rows).toHaveLength(2);
  });

  it('refresh: records ok=false when FD throws', async () => {
    const fd = { insiderTrades: vi.fn().mockRejectedValue(new Error('FD down')) };
    const svc = new InsidersService({ db: dbH.db, fdProvider: fd as any });

    await expect(svc.refresh('AAPL')).rejects.toThrow();

    const runs = await dbH.db.select().from(refreshRuns).where(eq(refreshRuns.ticker, 'AAPL'));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(false);
  });

  it('getList: returns newest first, limit honored', async () => {
    const fd = mockFdProvider(SAMPLE_TRADES);
    const svc = new InsidersService({ db: dbH.db, fdProvider: fd as any });

    await svc.refresh('AAPL');
    const list = await svc.getList('AAPL', 1);

    expect(list).toHaveLength(1);
    expect(list[0]!.transactionDate).toBe('2026-05-20');   // newest
  });

  it('getAggregate: delegates to pure compute over DB rows', async () => {
    const fd = mockFdProvider(SAMPLE_TRADES);
    const svc = new InsidersService({ db: dbH.db, fdProvider: fd as any });

    await svc.refresh('AAPL');
    // The 2 sample trades are within the last 90 days of the test execution time,
    // so they should appear in the aggregate. (Tests run with real Date.now;
    // the dates are 2026-05-15/20, which should be within 90 days as of test run.)
    const agg = await svc.getAggregate('AAPL', 999);   // huge window to be safe

    expect(agg.buyCount).toBe(1);
    expect(agg.sellCount).toBe(1);
    expect(agg.uniqueBuyers).toBe(1);
    expect(agg.uniqueSellers).toBe(1);
  });
});
