import { desc, eq } from 'drizzle-orm';
import { insiderTrades, refreshRuns } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type { InsiderTradeMeta } from '@/lib/providers/types';
import {
  computeInsiderAggregate,
  type InsiderAggregate,
  type InsiderTradeRow
} from '@/lib/compute/insider-aggregate';
import { logger } from '@/lib/logger';

interface FdInsidersProvider {
  insiderTrades(ticker: string, opts?: { limit?: number }): Promise<InsiderTradeMeta[]>;
}

interface Deps {
  db: ServiceDb;
  fdProvider: FdInsidersProvider;
}

export interface InsiderTrade {
  id: string;
  ticker: string;
  insiderName: string;
  insiderTitle: string | null;
  isBoardDirector: boolean;
  transactionDate: string;
  transactionType: string;
  shares: number;
  pricePerShare: number | null;
  transactionValue: number | null;
  sharesOwnedBefore: number | null;
  sharesOwnedAfter: number | null;
  securityTitle: string | null;
  filingDate: string;
}

export interface InsiderRefreshSummary {
  ticker: string;
  fetched: number;
  newRows: number;
  durationMs: number;
}

const REFRESH_FETCH_LIMIT = 500;

export class InsidersService {
  constructor(private readonly deps: Deps) {}

  async getList(ticker: string, limit = 100): Promise<InsiderTrade[]> {
    const t = ticker.toUpperCase();
    const rows = await this.deps.db
      .select()
      .from(insiderTrades)
      .where(eq(insiderTrades.ticker, t))
      .orderBy(desc(insiderTrades.transactionDate))
      .limit(limit);
    return rows.map((r) => ({
      id: String(r.id),
      ticker: r.ticker,
      insiderName: r.insiderName,
      insiderTitle: r.insiderTitle,
      isBoardDirector: r.isBoardDirector,
      transactionDate: r.transactionDate,
      transactionType: r.transactionType,
      shares: Number(r.shares),
      pricePerShare: r.pricePerShare == null ? null : Number(r.pricePerShare),
      transactionValue: r.transactionValue == null ? null : Number(r.transactionValue),
      sharesOwnedBefore: r.sharesOwnedBefore == null ? null : Number(r.sharesOwnedBefore),
      sharesOwnedAfter: r.sharesOwnedAfter == null ? null : Number(r.sharesOwnedAfter),
      securityTitle: r.securityTitle,
      filingDate: r.filingDate
    }));
  }

  async getAggregate(ticker: string, windowDays = 90): Promise<InsiderAggregate> {
    const t = ticker.toUpperCase();
    const rows = await this.deps.db
      .select({
        insiderName: insiderTrades.insiderName,
        insiderTitle: insiderTrades.insiderTitle,
        transactionDate: insiderTrades.transactionDate,
        transactionType: insiderTrades.transactionType,
        shares: insiderTrades.shares,
        transactionValue: insiderTrades.transactionValue
      })
      .from(insiderTrades)
      .where(eq(insiderTrades.ticker, t))
      .orderBy(desc(insiderTrades.transactionDate));

    const computeRows: InsiderTradeRow[] = rows.map((r) => ({
      insiderName: r.insiderName,
      insiderTitle: r.insiderTitle,
      transactionDate: r.transactionDate,
      transactionType: r.transactionType,
      shares: Number(r.shares),
      transactionValue: r.transactionValue == null ? null : Number(r.transactionValue)
    }));

    return computeInsiderAggregate(computeRows, windowDays);
  }

  async refresh(ticker: string): Promise<InsiderRefreshSummary> {
    const t = ticker.toUpperCase();
    const started = Date.now();
    const startedAt = new Date(started);
    let fetched = 0;
    let newRows = 0;

    try {
      const trades = await this.deps.fdProvider.insiderTrades(t, { limit: REFRESH_FETCH_LIMIT });
      fetched = trades.length;

      if (trades.length > 0) {
        const beforeRows = await this.deps.db
          .select({ id: insiderTrades.id })
          .from(insiderTrades)
          .where(eq(insiderTrades.ticker, t));
        const beforeCount = beforeRows.length;

        await this.deps.db
          .insert(insiderTrades)
          .values(
            trades.map((meta) => ({
              ticker: t,
              insiderName: meta.name,
              insiderTitle: meta.title,
              isBoardDirector: meta.is_board_director,
              transactionDate: meta.transaction_date,
              transactionType: meta.transaction_type,
              shares: String(meta.transaction_shares),
              pricePerShare: meta.transaction_price_per_share == null
                ? null
                : String(meta.transaction_price_per_share),
              transactionValue: meta.transaction_value == null
                ? null
                : String(meta.transaction_value),
              sharesOwnedBefore: meta.shares_owned_before_transaction == null
                ? null
                : String(meta.shares_owned_before_transaction),
              sharesOwnedAfter: meta.shares_owned_after_transaction == null
                ? null
                : String(meta.shares_owned_after_transaction),
              securityTitle: meta.security_title,
              filingDate: meta.filing_date
            }))
          )
          .onConflictDoNothing();

        const afterRows = await this.deps.db
          .select({ id: insiderTrades.id })
          .from(insiderTrades)
          .where(eq(insiderTrades.ticker, t));
        newRows = afterRows.length - beforeCount;
      }

      await this.deps.db.insert(refreshRuns).values({
        ticker: t,
        kind: 'insiders',
        startedAt,
        completedAt: new Date(),
        ok: true,
        sourceUsed: 'financial_datasets'
      });

      return { ticker: t, fetched, newRows, durationMs: Date.now() - started };
    } catch (err) {
      await this.deps.db.insert(refreshRuns).values({
        ticker: t,
        kind: 'insiders',
        startedAt,
        completedAt: new Date(),
        ok: false,
        sourceUsed: 'financial_datasets',
        error: String(err).slice(0, 1000)
      });
      logger.warn({ ticker: t, err: String(err) }, 'insiders.refresh failed');
      throw err;
    }
  }
}
