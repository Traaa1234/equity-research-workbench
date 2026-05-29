import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { companies, institutionalHoldings, refreshRuns } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type { ThirteenFInvestor } from '@/lib/providers/types';
import {
  computeHoldingsAggregate,
  joinHoldersWithDeltas,
  type HoldingsAggregate,
  type HoldingsRow,
  type HolderDelta
} from '@/lib/compute/holdings-aggregate';
import { matchSmartMoney, type SmartMoneyCategory, getReverseLookupCiks } from '@/lib/compute/smart-money';
import { tickerForCusip, watchlistCusips, CUSIP_BY_TICKER } from '@/lib/compute/cusip-map';
import { logger } from '@/lib/logger';

interface SecHoldingsProvider {
  thirteenFFilings(cik: string): Promise<ThirteenFInvestor>;
}

interface Deps {
  db: ServiceDb;
  secProvider: SecHoldingsProvider;
}

/**
 * One row returned by getList. Carries delta + smart-money fields
 * inline so the UI doesn't have to recompute or shim them.
 */
export interface EnrichedHolding {
  id: string;
  ticker: string;
  investorId: string;
  investorName: string;
  reportPeriod: string;
  shares: number;
  marketValue: number | null;
  sharesPctOfPortfolio: number | null;
  sharesPctOfShareholders: number | null;
  filingDate: string;
  delta: HolderDelta;
  sharesPrev: number | null;
  isSmartMoney: boolean;
  smartMoneyCategory: SmartMoneyCategory | null;
}

export interface TrackedInvestorRefreshSummary {
  investorsAttempted: number;
  investorsSucceeded: number;
  investorsFailed: number;
  newRows: number;
  prunedRows: number;
  durationMs: number;
}

const WINDOW_QUARTERS = 8;

function numToStr(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return String(n);
}

function quartersBefore(periodIso: string, n: number): string {
  const t = Date.parse(periodIso + 'T00:00:00Z');
  const cutoff = new Date(t - n * 90 * 24 * 60 * 60 * 1000);
  return cutoff.toISOString().slice(0, 10);
}

function classifyDeltaInline(currentShares: number, prevShares: number | null): HolderDelta {
  if (prevShares == null || prevShares === 0) return currentShares > 0 ? 'new' : 'unchanged';
  if (currentShares === 0) return 'sold-out';
  const pctChange = (currentShares - prevShares) / prevShares;
  if (pctChange > 0.05) return 'added';
  if (pctChange < -0.05) return 'reduced';
  return 'unchanged';
}

export class HoldingsService {
  constructor(private readonly deps: Deps) {}

  async getList(
    ticker: string,
    reportPeriod?: string,
    limit = 200
  ): Promise<EnrichedHolding[]> {
    const t = ticker.toUpperCase();
    const period = reportPeriod ?? (await this.latestPeriod(t));
    if (!period) return [];

    const periodsRows = await this.deps.db
      .selectDistinct({ p: institutionalHoldings.reportPeriod })
      .from(institutionalHoldings)
      .where(eq(institutionalHoldings.ticker, t))
      .orderBy(desc(institutionalHoldings.reportPeriod));
    const periods = periodsRows.map((r) => r.p);
    const periodIdx = periods.indexOf(period);
    const prevPeriod =
      periodIdx >= 0 && periodIdx < periods.length - 1 ? (periods[periodIdx + 1] ?? null) : null;

    const currentRowsRaw = await this.deps.db
      .select()
      .from(institutionalHoldings)
      .where(and(
        eq(institutionalHoldings.ticker, t),
        eq(institutionalHoldings.reportPeriod, period)
      ))
      .orderBy(desc(institutionalHoldings.shares))
      .limit(limit);

    const prevByInvestorId = new Map<string, number>();
    if (prevPeriod) {
      const prevRows = await this.deps.db
        .select({ id: institutionalHoldings.investorId, sh: institutionalHoldings.shares })
        .from(institutionalHoldings)
        .where(and(
          eq(institutionalHoldings.ticker, t),
          eq(institutionalHoldings.reportPeriod, prevPeriod)
        ));
      for (const r of prevRows) prevByInvestorId.set(r.id, Number(r.sh));
    }

    return currentRowsRaw.map((r) => {
      const shares = Number(r.shares);
      const prev = prevByInvestorId.get(r.investorId) ?? null;
      const delta = classifyDeltaInline(shares, prev);
      const sm = matchSmartMoney(r.investorId, r.investorName);
      return {
        id: String(r.id),
        ticker: r.ticker,
        investorId: r.investorId,
        investorName: r.investorName,
        reportPeriod: r.reportPeriod,
        shares,
        marketValue: r.marketValue == null ? null : Number(r.marketValue),
        sharesPctOfPortfolio: r.sharesPctOfPortfolio == null ? null : Number(r.sharesPctOfPortfolio),
        sharesPctOfShareholders: r.sharesPctOfShareholders == null ? null : Number(r.sharesPctOfShareholders),
        filingDate: r.filingDate,
        delta,
        sharesPrev: prev,
        isSmartMoney: sm !== null,
        smartMoneyCategory: sm?.category ?? null
      };
    });
  }

  async getAggregate(ticker: string): Promise<HoldingsAggregate> {
    const t = ticker.toUpperCase();
    const all = await this.deps.db
      .select({
        investorId: institutionalHoldings.investorId,
        investorName: institutionalHoldings.investorName,
        reportPeriod: institutionalHoldings.reportPeriod,
        shares: institutionalHoldings.shares,
        marketValue: institutionalHoldings.marketValue,
        sharesPctOfPortfolio: institutionalHoldings.sharesPctOfPortfolio
      })
      .from(institutionalHoldings)
      .where(eq(institutionalHoldings.ticker, t))
      .orderBy(desc(institutionalHoldings.reportPeriod), desc(institutionalHoldings.shares));

    const breadthMap = new Map<string, number>();
    for (const r of all) {
      breadthMap.set(r.reportPeriod, (breadthMap.get(r.reportPeriod) ?? 0) + 1);
    }
    const breadthTrend = Array.from(breadthMap.entries())
      .map(([period, holders]) => ({ period, holders }))
      .sort((a, b) => b.period.localeCompare(a.period))
      .slice(0, WINDOW_QUARTERS);

    if (breadthTrend.length === 0) {
      return computeHoldingsAggregate([], []);
    }

    const currentPeriod = breadthTrend[0]!.period;
    const previousPeriod = breadthTrend[1]?.period ?? null;

    const toHoldingsRow = (r: typeof all[number]): HoldingsRow => ({
      investorId: r.investorId,
      investorName: r.investorName,
      reportPeriod: r.reportPeriod,
      shares: Number(r.shares),
      marketValue: r.marketValue == null ? null : Number(r.marketValue),
      sharesPctOfPortfolio: r.sharesPctOfPortfolio == null ? null : Number(r.sharesPctOfPortfolio)
    });

    const current = all.filter((r) => r.reportPeriod === currentPeriod).map(toHoldingsRow);
    const previous = previousPeriod
      ? all.filter((r) => r.reportPeriod === previousPeriod).map(toHoldingsRow)
      : [];

    const joined = joinHoldersWithDeltas(current, previous);
    return computeHoldingsAggregate(joined, breadthTrend);
  }

  async listAvailablePeriods(ticker: string): Promise<string[]> {
    const t = ticker.toUpperCase();
    const rows = await this.deps.db
      .selectDistinct({ p: institutionalHoldings.reportPeriod })
      .from(institutionalHoldings)
      .where(eq(institutionalHoldings.ticker, t))
      .orderBy(desc(institutionalHoldings.reportPeriod));
    return rows.map((r) => r.p);
  }

  private async latestPeriod(ticker: string): Promise<string | null> {
    const rows = await this.deps.db
      .select({ p: institutionalHoldings.reportPeriod })
      .from(institutionalHoldings)
      .where(eq(institutionalHoldings.ticker, ticker))
      .orderBy(desc(institutionalHoldings.reportPeriod))
      .limit(1);
    return rows[0]?.p ?? null;
  }

  async refreshTrackedInvestors(): Promise<TrackedInvestorRefreshSummary> {
    const started = Date.now();
    const startedAt = new Date(started);
    const ciks = getReverseLookupCiks();
    const cusipSet = new Set(watchlistCusips().map((c) => c.toUpperCase()));
    const inserts: Array<typeof institutionalHoldings.$inferInsert> = [];
    let succeeded = 0, failed = 0;

    for (const cik of ciks) {
      try {
        const investor = await this.deps.secProvider.thirteenFFilings(cik);
        succeeded++;
        for (const filing of investor.filings) {
          for (const pos of filing.positions) {
            const cusipUpper = pos.cusip.toUpperCase();
            if (!cusipSet.has(cusipUpper)) continue;
            const ticker = tickerForCusip(cusipUpper);
            if (!ticker) continue;
            const sharesStr = numToStr(pos.shares);
            if (sharesStr == null) continue;
            inserts.push({
              ticker,
              investorId: cik.padStart(10, '0'),
              investorName: investor.investorName,
              reportPeriod: filing.reportPeriod,
              shares: sharesStr,
              marketValue: numToStr(pos.valueUsd),
              sharesPctOfPortfolio: null,
              sharesPctOfShareholders: null,
              filingDate: filing.filingDate
            });
          }
        }
      } catch (err) {
        failed++;
        logger.warn({ cik, err: String(err) }, 'refreshTrackedInvestors: investor fetch failed');
      }
    }

    let newRows = 0;
    if (inserts.length > 0) {
      const before = await this.countTotalRows();
      await this.deps.db.insert(institutionalHoldings).values(inserts).onConflictDoNothing();
      const after = await this.countTotalRows();
      newRows = after - before;
    }

    const prunedRows = await this.pruneAllTickersTo8Q();

    // Ensure the '*' sentinel companies row exists so the refresh_runs FK is satisfied.
    await this.deps.db
      .insert(companies)
      .values({ ticker: '*', name: 'Global refresh sentinel' })
      .onConflictDoNothing();

    await this.deps.db.insert(refreshRuns).values({
      ticker: '*',
      kind: 'holdings',
      startedAt,
      completedAt: new Date(),
      ok: true,
      sourceUsed: 'sec_edgar'
    });

    return {
      investorsAttempted: ciks.length,
      investorsSucceeded: succeeded,
      investorsFailed: failed,
      newRows,
      prunedRows,
      durationMs: Date.now() - started
    };
  }

  private async countTotalRows(): Promise<number> {
    const r = await this.deps.db
      .select({ c: sql<number>`count(*)::int` })
      .from(institutionalHoldings);
    return r[0]?.c ?? 0;
  }

  private async pruneAllTickersTo8Q(): Promise<number> {
    let total = 0;
    for (const ticker of Object.keys(CUSIP_BY_TICKER)) {
      const latest = await this.latestPeriod(ticker);
      if (!latest) continue;
      const cutoff = quartersBefore(latest, WINDOW_QUARTERS);
      const toDelete = await this.deps.db
        .select({ id: institutionalHoldings.id })
        .from(institutionalHoldings)
        .where(and(
          eq(institutionalHoldings.ticker, ticker),
          lt(institutionalHoldings.reportPeriod, cutoff)
        ));
      if (toDelete.length > 0) {
        await this.deps.db
          .delete(institutionalHoldings)
          .where(and(
            eq(institutionalHoldings.ticker, ticker),
            lt(institutionalHoldings.reportPeriod, cutoff)
          ));
        total += toDelete.length;
      }
    }
    return total;
  }
}
