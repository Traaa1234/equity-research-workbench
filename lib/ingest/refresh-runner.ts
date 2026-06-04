import { sql } from 'drizzle-orm';
import { refreshRuns } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type { SnapshotService } from '@/lib/services/snapshot';
import type { FinancialsService } from '@/lib/services/financials';
import type { PricesService } from '@/lib/services/prices';
import type { MacroService } from '@/lib/services/macro';
import type { CountryScorecardService } from '@/lib/services/country-scorecard';
import type { YieldCurveService } from '@/lib/services/yield-curve';
import type { PeriodType, StatementType } from '@/lib/providers/types';
import { logger } from '@/lib/logger';

export type RefreshKind = 'snapshot' | 'fundamentals' | 'prices' | 'earnings' | 'macro' | 'countries' | 'curve';

interface Deps {
  db: ServiceDb;
  kind: RefreshKind;
  snapshotSvc: SnapshotService;
  financialsSvc: FinancialsService;
  pricesSvc: PricesService;
  macroSvc?: MacroService;
  countrySvc?: CountryScorecardService;
  curveSvc?: YieldCurveService;
  /** Time budget in milliseconds. Vercel Cron Hobby max is 60s; default to 50s. */
  budgetMs?: number;
}

export interface RefreshSummary {
  kind: RefreshKind;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

/**
 * Compute the set of tickers we should refresh:
 *   seed tickers (is_seed=true) ∪ any ticker on any user's watchlist.
 * Deduplicated.
 */
async function getRefreshTickers(db: ServiceDb): Promise<string[]> {
  const rows = await db.execute<{ ticker: string }>(sql`
    select distinct ticker from companies where is_seed = true
    union
    select distinct ticker from watchlist
  `);
  return rows.map((r) => r.ticker);
}

async function recordRun(
  db: ServiceDb,
  ticker: string,
  kind: string,
  startedAt: Date,
  ok: boolean,
  err: unknown
): Promise<void> {
  await db.insert(refreshRuns).values({
    ticker,
    kind,
    startedAt,
    completedAt: new Date(),
    ok,
    sourceUsed: null,
    error: ok ? null : String(err).slice(0, 1000)
  });
}

export async function runRefresh(deps: Deps): Promise<RefreshSummary> {
  const started = Date.now();
  const budget = deps.budgetMs ?? 50_000;

  const summary: RefreshSummary = {
    kind: deps.kind,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0
  };

  if (deps.kind === 'macro') {
    if (!deps.macroSvc) throw new Error('macroSvc required for macro refresh');
    const r = await deps.macroSvc.refreshAll('daily');
    summary.attempted = r.attempted;
    summary.succeeded = r.ok;
    summary.failed = r.failed;
    summary.durationMs = Date.now() - started;
    logger.info(summary, 'refresh-runner: macro done');
    return summary;
  }

  if (deps.kind === 'countries') {
    if (!deps.countrySvc) throw new Error('countrySvc required for countries refresh');
    const r = await deps.countrySvc.refreshAll('daily');
    summary.attempted = r.fredOk + r.fredFailed + r.etfOk;
    summary.succeeded = r.fredOk + r.etfOk;
    summary.failed = r.fredFailed;
    summary.durationMs = Date.now() - started;
    logger.info(summary, 'refresh-runner: countries done');
    return summary;
  }

  if (deps.kind === 'curve') {
    if (!deps.curveSvc) throw new Error('curveSvc required for curve refresh');
    const r = await deps.curveSvc.refreshAll('daily');
    summary.attempted = r.ok + r.failed;
    summary.succeeded = r.ok;
    summary.failed = r.failed;
    summary.durationMs = Date.now() - started;
    logger.info(summary, 'refresh-runner: curve done');
    return summary;
  }

  const tickers = await getRefreshTickers(deps.db);

  for (const ticker of tickers) {
    if (Date.now() - started > budget) {
      summary.skipped += tickers.length - summary.attempted;
      break;
    }

    if (deps.kind === 'snapshot') {
      summary.attempted++;
      const t0 = new Date();
      try {
        await deps.snapshotSvc.refresh(ticker);
        await recordRun(deps.db, ticker, 'snapshot', t0, true, null);
        summary.succeeded++;
      } catch (err) {
        await recordRun(deps.db, ticker, 'snapshot', t0, false, err);
        summary.failed++;
      }
    } else if (deps.kind === 'prices') {
      summary.attempted++;
      const t0 = new Date();
      try {
        await deps.pricesSvc.refresh(ticker, '1Y');
        await recordRun(deps.db, ticker, 'prices', t0, true, null);
        summary.succeeded++;
      } catch (err) {
        await recordRun(deps.db, ticker, 'prices', t0, false, err);
        summary.failed++;
      }
    } else if (deps.kind === 'fundamentals') {
      const statements: Array<[StatementType, PeriodType]> = [
        ['income', 'annual'],
        ['balance', 'annual'],
        ['cash_flow', 'annual']
      ];
      for (const [type, period] of statements) {
        summary.attempted++;
        const t0 = new Date();
        try {
          await deps.financialsSvc.refresh(ticker, type, period);
          await recordRun(deps.db, ticker, `fundamentals:${type}:${period}`, t0, true, null);
          summary.succeeded++;
        } catch (err) {
          await recordRun(deps.db, ticker, `fundamentals:${type}:${period}`, t0, false, err);
          summary.failed++;
        }
      }
    } else if (deps.kind === 'earnings') {
      // EarningsService not wired in Slice 1; cron kind is reserved.
      logger.warn({ ticker }, 'refresh-runner: earnings kind not yet wired');
      summary.skipped++;
    }
  }

  summary.durationMs = Date.now() - started;
  logger.info(summary, 'refresh-runner: done');
  return summary;
}
