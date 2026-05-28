import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, institutionalHoldings, refreshRuns } from '@/lib/db/schema';
import { HoldingsService } from '@/lib/services/holdings';
import type { HoldingsMeta } from '@/lib/providers/types';

config({ path: '.env.local' });

function mockFdProvider(rows: HoldingsMeta[]) {
  return {
    institutionalOwnership: vi.fn().mockResolvedValue(rows)
  };
}

function meta(
  investor: string,
  reportPeriod: string,
  shares: number,
  cik: string | null = null
): HoldingsMeta {
  return {
    ticker: 'AAPL',
    investor,
    report_period: reportPeriod,
    shares,
    market_value: shares * 290,
    price: 290,
    is_active: true,
    url: null,
    ...(cik ? { cik } : {})
  };
}

describe('HoldingsService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.', cik: null });
  });

  it('refresh: fetches, inserts, writes refresh_run with kind=holdings', async () => {
    const fd = mockFdProvider([
      meta('BERKSHIRE HATHAWAY INC', '2026-03-31', 905_560_000, '0001067983'),
      meta('VANGUARD GROUP INC', '2026-03-31', 1_377_000_000)
    ]);
    const svc = new HoldingsService({ db: dbH.db, fdProvider: fd as any });

    const summary = await svc.refresh('AAPL');

    expect(summary.fetched).toBe(2);
    expect(summary.newRows).toBe(2);

    const rows = await dbH.db.select().from(institutionalHoldings).where(eq(institutionalHoldings.ticker, 'AAPL'));
    expect(rows).toHaveLength(2);

    const runs = await dbH.db.select().from(refreshRuns).where(eq(refreshRuns.ticker, 'AAPL'));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(true);
    expect(runs[0]!.kind).toBe('holdings');
  });

  it('refresh: idempotent — second call dedupes by composite key', async () => {
    const fd = mockFdProvider([
      meta('BERKSHIRE HATHAWAY INC', '2026-03-31', 905_560_000, '0001067983')
    ]);
    const svc = new HoldingsService({ db: dbH.db, fdProvider: fd as any });

    await svc.refresh('AAPL');
    const second = await svc.refresh('AAPL');

    expect(second.newRows).toBe(0);
    const rows = await dbH.db.select().from(institutionalHoldings).where(eq(institutionalHoldings.ticker, 'AAPL'));
    expect(rows).toHaveLength(1);
  });

  it('refresh: prunes rows older than 8 quarters', async () => {
    const periods = [
      '2026-03-31','2025-12-31','2025-09-30','2025-06-30',
      '2025-03-31','2024-12-31','2024-09-30','2024-06-30',
      '2024-03-31','2023-12-31'
    ];
    const fd = mockFdProvider(
      periods.map((p, i) => meta('FUND ' + i, p, 1000 * (i + 1)))
    );
    const svc = new HoldingsService({ db: dbH.db, fdProvider: fd as any });

    await svc.refresh('AAPL');

    const rows = await dbH.db.select({ p: institutionalHoldings.reportPeriod })
      .from(institutionalHoldings).where(eq(institutionalHoldings.ticker, 'AAPL'));
    const remaining = new Set(rows.map((r) => r.p));
    expect(remaining.size).toBe(8);
    expect(remaining.has('2024-03-31')).toBe(false);
    expect(remaining.has('2023-12-31')).toBe(false);
    expect(remaining.has('2026-03-31')).toBe(true);
  });

  it('refresh: skips invalid-numeric rows with warn log', async () => {
    const fd = {
      institutionalOwnership: vi.fn().mockResolvedValue([
        meta('VALID FUND', '2026-03-31', 1000),
        { ...meta('BAD FUND', '2026-03-31', NaN), shares: null as any }
      ])
    };
    const svc = new HoldingsService({ db: dbH.db, fdProvider: fd as any });
    const summary = await svc.refresh('AAPL');

    expect(summary.fetched).toBe(2);
    expect(summary.newRows).toBe(1);
    const rows = await dbH.db.select().from(institutionalHoldings).where(eq(institutionalHoldings.ticker, 'AAPL'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.investorName).toBe('VALID FUND');
  });

  it('refresh: records ok=false when FD throws', async () => {
    const fd = { institutionalOwnership: vi.fn().mockRejectedValue(new Error('FD down')) };
    const svc = new HoldingsService({ db: dbH.db, fdProvider: fd as any });

    await expect(svc.refresh('AAPL')).rejects.toThrow();

    const runs = await dbH.db.select().from(refreshRuns).where(eq(refreshRuns.ticker, 'AAPL'));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(false);
  });

  it('getList: returns largest holders first for a given period', async () => {
    const fd = mockFdProvider([
      meta('SMALL FUND', '2026-03-31', 1000),
      meta('BIG FUND', '2026-03-31', 1_000_000),
      meta('MEDIUM FUND', '2026-03-31', 10_000)
    ]);
    const svc = new HoldingsService({ db: dbH.db, fdProvider: fd as any });
    await svc.refresh('AAPL');

    const list = await svc.getList('AAPL', '2026-03-31');
    expect(list).toHaveLength(3);
    expect(list[0]!.investorName).toBe('BIG FUND');
    expect(list[2]!.investorName).toBe('SMALL FUND');
  });

  it('getAggregate: delegates to compute over current + previous period', async () => {
    const fd = mockFdProvider([
      // current quarter
      meta('BERKSHIRE HATHAWAY INC', '2026-03-31', 110_000_000, '0001067983'),
      meta('VANGUARD GROUP INC', '2026-03-31', 1_377_000_000),
      // previous quarter — Berkshire smaller, Vanguard same
      meta('BERKSHIRE HATHAWAY INC', '2025-12-31', 100_000_000, '0001067983'),
      meta('VANGUARD GROUP INC', '2025-12-31', 1_377_000_000)
    ]);
    const svc = new HoldingsService({ db: dbH.db, fdProvider: fd as any });
    await svc.refresh('AAPL');

    const agg = await svc.getAggregate('AAPL');
    expect(agg.currentPeriod).toBe('2026-03-31');
    expect(agg.previousPeriod).toBe('2025-12-31');
    expect(agg.totalHolders).toBe(2);
    expect(agg.smartMoneyMoves.additions).toHaveLength(1);   // Berkshire +10% added
    expect(agg.smartMoneyMoves.additions[0]!.investorName).toBe('BERKSHIRE HATHAWAY INC');
    expect(agg.breadthTrend[0]!.period).toBe('2026-03-31');
    expect(agg.breadthTrend[0]!.holders).toBe(2);
  });

  it('listAvailablePeriods: returns distinct periods newest-first', async () => {
    const fd = mockFdProvider([
      meta('A', '2025-12-31', 100),
      meta('B', '2025-12-31', 200),
      meta('A', '2026-03-31', 150)
    ]);
    const svc = new HoldingsService({ db: dbH.db, fdProvider: fd as any });
    await svc.refresh('AAPL');

    const periods = await svc.listAvailablePeriods('AAPL');
    expect(periods).toEqual(['2026-03-31', '2025-12-31']);
  });
});
