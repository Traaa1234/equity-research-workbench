import { and, desc, eq, lt } from 'drizzle-orm';
import { institutionalHoldings, refreshRuns } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type { HoldingsMeta } from '@/lib/providers/types';
import {
  computeHoldingsAggregate,
  joinHoldersWithDeltas,
  type HoldingsAggregate,
  type HoldingsRow
} from '@/lib/compute/holdings-aggregate';
import { normalizeInvestorName } from '@/lib/compute/smart-money';
import { logger } from '@/lib/logger';

interface FdHoldingsProvider {
  institutionalOwnership(
    ticker: string,
    opts?: { limit?: number; reportPeriodGte?: string; reportPeriodLte?: string }
  ): Promise<HoldingsMeta[]>;
}

interface Deps {
  db: ServiceDb;
  fdProvider: FdHoldingsProvider;
}

export interface InstitutionalHolding {
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
}

export interface HoldingsRefreshSummary {
  ticker: string;
  fetched: number;
  newRows: number;
  prunedRows: number;
  durationMs: number;
}

const REFRESH_FETCH_LIMIT = 500;
const WINDOW_QUARTERS = 8;

function numToStr(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return String(n);
}

function deriveInvestorId(meta: HoldingsMeta): string {
  if (meta.cik && /^\d+$/.test(meta.cik)) return meta.cik.padStart(10, '0');
  return normalizeInvestorName(meta.investor);
}

function quartersBefore(periodIso: string, n: number): string {
  const t = Date.parse(periodIso + 'T00:00:00Z');
  const cutoff = new Date(t - n * 90 * 24 * 60 * 60 * 1000);
  return cutoff.toISOString().slice(0, 10);
}

export class HoldingsService {
  constructor(private readonly deps: Deps) {}

  async getList(
    ticker: string,
    reportPeriod?: string,
    limit = 200
  ): Promise<InstitutionalHolding[]> {
    const t = ticker.toUpperCase();
    const period = reportPeriod ?? (await this.latestPeriod(t));
    if (!period) return [];
    const rows = await this.deps.db
      .select()
      .from(institutionalHoldings)
      .where(and(
        eq(institutionalHoldings.ticker, t),
        eq(institutionalHoldings.reportPeriod, period)
      ))
      .orderBy(desc(institutionalHoldings.shares))
      .limit(limit);
    return rows.map((r) => ({
      id: String(r.id),
      ticker: r.ticker,
      investorId: r.investorId,
      investorName: r.investorName,
      reportPeriod: r.reportPeriod,
      shares: Number(r.shares),
      marketValue: r.marketValue == null ? null : Number(r.marketValue),
      sharesPctOfPortfolio: r.sharesPctOfPortfolio == null ? null : Number(r.sharesPctOfPortfolio),
      sharesPctOfShareholders: r.sharesPctOfShareholders == null ? null : Number(r.sharesPctOfShareholders),
      filingDate: r.filingDate
    }));
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

  async refresh(ticker: string): Promise<HoldingsRefreshSummary> {
    const t = ticker.toUpperCase();
    const started = Date.now();
    const startedAt = new Date(started);
    let fetched = 0;
    let newRows = 0;
    let prunedRows = 0;

    try {
      const rawRows = await this.deps.fdProvider.institutionalOwnership(t, { limit: REFRESH_FETCH_LIMIT });
      fetched = rawRows.length;

      const validRows = rawRows.filter((meta) => {
        const sh = numToStr(meta.shares);
        if (sh == null) {
          logger.warn(
            { ticker: t, investor: meta.investor, reportPeriod: meta.report_period, rawShares: meta.shares },
            'holdings.refresh: skipping row with non-numeric shares'
          );
          return false;
        }
        return true;
      });

      if (validRows.length > 0) {
        const before = await this.deps.db
          .select({ id: institutionalHoldings.id })
          .from(institutionalHoldings)
          .where(eq(institutionalHoldings.ticker, t));
        const beforeCount = before.length;

        await this.deps.db
          .insert(institutionalHoldings)
          .values(
            validRows.map((meta) => ({
              ticker: t,
              investorId: deriveInvestorId(meta),
              investorName: meta.investor,
              reportPeriod: meta.report_period,
              shares: numToStr(meta.shares)!,
              marketValue: numToStr(meta.market_value),
              sharesPctOfPortfolio: numToStr(meta.shares_pct_of_portfolio ?? null),
              sharesPctOfShareholders: numToStr(meta.shares_pct_of_shareholders ?? null),
              filingDate: meta.filing_date ?? meta.report_period
            }))
          )
          .onConflictDoNothing();

        const after = await this.deps.db
          .select({ id: institutionalHoldings.id })
          .from(institutionalHoldings)
          .where(eq(institutionalHoldings.ticker, t));
        newRows = after.length - beforeCount;
      }

      // Prune: keep only the newest 8 quarters
      const latest = await this.latestPeriod(t);
      if (latest) {
        const cutoff = quartersBefore(latest, WINDOW_QUARTERS);
        const beforePrune = await this.deps.db
          .select({ id: institutionalHoldings.id })
          .from(institutionalHoldings)
          .where(and(
            eq(institutionalHoldings.ticker, t),
            lt(institutionalHoldings.reportPeriod, cutoff)
          ));
        if (beforePrune.length > 0) {
          await this.deps.db
            .delete(institutionalHoldings)
            .where(and(
              eq(institutionalHoldings.ticker, t),
              lt(institutionalHoldings.reportPeriod, cutoff)
            ));
          prunedRows = beforePrune.length;
        }
      }

      await this.deps.db.insert(refreshRuns).values({
        ticker: t,
        kind: 'holdings',
        startedAt,
        completedAt: new Date(),
        ok: true,
        sourceUsed: 'financial_datasets'
      });

      return { ticker: t, fetched, newRows, prunedRows, durationMs: Date.now() - started };
    } catch (err) {
      await this.deps.db.insert(refreshRuns).values({
        ticker: t,
        kind: 'holdings',
        startedAt,
        completedAt: new Date(),
        ok: false,
        sourceUsed: 'financial_datasets',
        error: String(err).slice(0, 1000)
      });
      logger.warn({ ticker: t, err: String(err) }, 'holdings.refresh failed');
      throw err;
    }
  }
}
