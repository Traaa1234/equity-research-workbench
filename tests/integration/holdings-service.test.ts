import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, institutionalHoldings, refreshRuns } from '@/lib/db/schema';
import { HoldingsService } from '@/lib/services/holdings';
import type { ThirteenFInvestor } from '@/lib/providers/types';

config({ path: '.env.local' });

/**
 * Build a per-CIK lookup table from a flat array of ThirteenFInvestor.
 * The mock returns the matching investor (or an empty-filings stub) for
 * any CIK the service requests.
 */
function mockSecProvider(investors: ThirteenFInvestor[]) {
  const byCik = new Map<string, ThirteenFInvestor>(investors.map((i) => [i.cik, i]));
  return {
    thirteenFFilings: vi.fn(async (cik: string): Promise<ThirteenFInvestor> => {
      const padded = cik.padStart(10, '0');
      return byCik.get(padded) ?? { cik: padded, investorName: 'UNKNOWN', filings: [] };
    })
  };
}

function position(cusip: string, issuerName: string, shares: number, valueUsd: number) {
  return {
    cusip,
    issuerName,
    classTitle: 'COM',
    valueUsd,
    shares,
    sharesType: 'SH'
  };
}

function filing(reportPeriod: string, positions: ReturnType<typeof position>[]) {
  return {
    accession: `acc-${reportPeriod}`,
    filingDate: reportPeriod,
    reportPeriod,
    formType: '13F-HR',
    positions
  };
}

function berkshire(filings: ReturnType<typeof filing>[]): ThirteenFInvestor {
  return { cik: '0001067983', investorName: 'BERKSHIRE HATHAWAY INC', filings };
}

function vanguard(filings: ReturnType<typeof filing>[]): ThirteenFInvestor {
  return { cik: '0000102909', investorName: 'VANGUARD GROUP', filings };
}

describe('HoldingsService.refreshTrackedInvestors', () => {
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
  });

  it('happy path: fetches all CIKs, filters to watchlist CUSIPs, inserts rows, writes refresh_runs', async () => {
    const sec = mockSecProvider([
      berkshire([
        filing('2026-03-31', [
          position('037833100', 'APPLE INC', 905_560_000, 263_012_040_000),
          position('060505104', 'BANK OF AMERICA CORP', 700_000_000, 30_000_000_000)   // NOT watchlist
        ])
      ]),
      vanguard([
        filing('2026-03-31', [
          position('037833100', 'APPLE INC', 1_377_000_000, 400_000_000_000),
          position('594918104', 'MICROSOFT CORP', 890_000_000, 360_000_000_000)
        ])
      ])
    ]);
    const svc = new HoldingsService({ db: dbH.db, secProvider: sec as any });

    const summary = await svc.refreshTrackedInvestors();

    expect(summary.investorsAttempted).toBeGreaterThanOrEqual(2);
    expect(summary.investorsSucceeded).toBeGreaterThanOrEqual(2);
    expect(summary.newRows).toBe(3);   // Berkshire AAPL + Vanguard AAPL + Vanguard MSFT (BAC filtered)

    const aaplRows = await dbH.db.select().from(institutionalHoldings).where(eq(institutionalHoldings.ticker, 'AAPL'));
    expect(aaplRows).toHaveLength(2);
    const msftRows = await dbH.db.select().from(institutionalHoldings).where(eq(institutionalHoldings.ticker, 'MSFT'));
    expect(msftRows).toHaveLength(1);

    const runs = await dbH.db.select().from(refreshRuns);
    const holdingsRuns = runs.filter((r) => r.kind === 'holdings');
    expect(holdingsRuns).toHaveLength(1);
    expect(holdingsRuns[0]!.ticker).toBe('*');
    expect(holdingsRuns[0]!.ok).toBe(true);
  });

  it('idempotent: second call inserts zero new rows', async () => {
    const sec = mockSecProvider([
      berkshire([filing('2026-03-31', [position('037833100', 'APPLE INC', 905_560_000, 263_012_040_000)])])
    ]);
    const svc = new HoldingsService({ db: dbH.db, secProvider: sec as any });

    await svc.refreshTrackedInvestors();
    const second = await svc.refreshTrackedInvestors();

    expect(second.newRows).toBe(0);
    const all = await dbH.db.select().from(institutionalHoldings);
    expect(all).toHaveLength(1);
  });

  it('prunes rows older than 8 quarters per ticker', async () => {
    const periods = [
      '2026-03-31','2025-12-31','2025-09-30','2025-06-30',
      '2025-03-31','2024-12-31','2024-09-30','2024-06-30',
      '2024-03-31','2023-12-31'    // last 2 should be pruned
    ];
    const sec = mockSecProvider([
      berkshire(periods.map((p) => filing(p, [position('037833100', 'APPLE INC', 100, 100_000_000)])))
    ]);
    const svc = new HoldingsService({ db: dbH.db, secProvider: sec as any });

    await svc.refreshTrackedInvestors();

    const rows = await dbH.db.select({ p: institutionalHoldings.reportPeriod })
      .from(institutionalHoldings).where(eq(institutionalHoldings.ticker, 'AAPL'));
    const remaining = new Set(rows.map((r) => r.p));
    expect(remaining.size).toBe(8);
    expect(remaining.has('2024-03-31')).toBe(false);
    expect(remaining.has('2023-12-31')).toBe(false);
  });

  it('skips positions for CUSIPs not on the watchlist', async () => {
    const sec = mockSecProvider([
      berkshire([
        filing('2026-03-31', [
          position('999999999', 'UNKNOWN CORP', 1000, 1_000_000),
          position('888888888', 'ANOTHER CORP', 2000, 2_000_000)
        ])
      ])
    ]);
    const svc = new HoldingsService({ db: dbH.db, secProvider: sec as any });

    const summary = await svc.refreshTrackedInvestors();

    expect(summary.newRows).toBe(0);
    const all = await dbH.db.select().from(institutionalHoldings);
    expect(all).toHaveLength(0);
  });

  it('partial failure: one investor throws, others continue', async () => {
    const failingCik = '0001067983';   // Berkshire
    const sec = {
      thirteenFFilings: vi.fn(async (cik: string) => {
        const padded = cik.padStart(10, '0');
        if (padded === failingCik) throw new Error('SEC 500');
        if (padded === '0000102909') {
          return vanguard([filing('2026-03-31', [position('037833100', 'APPLE INC', 100, 100_000_000)])]);
        }
        return { cik: padded, investorName: 'UNKNOWN', filings: [] };
      })
    };
    const svc = new HoldingsService({ db: dbH.db, secProvider: sec as any });

    const summary = await svc.refreshTrackedInvestors();

    expect(summary.investorsFailed).toBeGreaterThanOrEqual(1);
    expect(summary.investorsSucceeded).toBeGreaterThanOrEqual(1);
    expect(summary.newRows).toBe(1);
  });

  it('getList: returns enriched rows with delta info computed against the previous quarter', async () => {
    const sec = mockSecProvider([
      berkshire([
        filing('2026-03-31', [position('037833100', 'APPLE INC', 110_000_000, 32_000_000_000)]),
        filing('2025-12-31', [position('037833100', 'APPLE INC', 100_000_000, 29_000_000_000)])
      ])
    ]);
    const svc = new HoldingsService({ db: dbH.db, secProvider: sec as any });
    await svc.refreshTrackedInvestors();

    const list = await svc.getList('AAPL', '2026-03-31', 100);
    expect(list).toHaveLength(1);
    expect(list[0]!.delta).toBe('added');
    expect(list[0]!.sharesPrev).toBe(100_000_000);
    expect(list[0]!.isSmartMoney).toBe(true);
    expect(list[0]!.smartMoneyCategory).toBe('value');
  });
});
