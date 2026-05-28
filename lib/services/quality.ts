import { and, eq } from 'drizzle-orm';
import { fundamentals, snapshots } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import {
  computeQuality,
  type AnnualFinancials,
  type QualityResult
} from '@/lib/compute/quality';

/**
 * Pivot the row-wise `fundamentals` table into one `AnnualFinancials`
 * struct per period_end, then call `computeQuality`. Pulls current market
 * cap from `snapshots`.
 *
 * Lives in services, not compute, because it touches the DB.
 */
export async function loadQuality(
  db: ServiceDb,
  ticker: string
): Promise<QualityResult> {
  const t = ticker.toUpperCase();

  // Load all annual fundamentals for this ticker
  const rows = await db
    .select({
      periodEnd: fundamentals.periodEnd,
      statementType: fundamentals.statementType,
      lineItem: fundamentals.lineItem,
      value: fundamentals.value
    })
    .from(fundamentals)
    .where(and(eq(fundamentals.ticker, t), eq(fundamentals.periodType, 'annual')));

  // Group by periodEnd, building one AnnualFinancials per period
  const byPeriod = new Map<string, AnnualFinancials>();
  for (const r of rows) {
    if (!byPeriod.has(r.periodEnd)) {
      byPeriod.set(r.periodEnd, makeEmpty(r.periodEnd));
    }
    const f = byPeriod.get(r.periodEnd)!;
    const val = r.value == null ? null : Number(r.value);
    if (val == null || !Number.isFinite(val)) continue;
    applyLineItem(f, r.lineItem, val);
  }

  const annuals = Array.from(byPeriod.values()).sort((a, b) =>
    a.periodEnd.localeCompare(b.periodEnd)
  );

  // Current market cap from snapshots
  const snap = await db
    .select({ marketCap: snapshots.marketCap })
    .from(snapshots)
    .where(eq(snapshots.ticker, t))
    .limit(1);
  const marketCap = snap[0]?.marketCap != null ? Number(snap[0].marketCap) : 0;

  return computeQuality(t, annuals, marketCap);
}

function makeEmpty(periodEnd: string): AnnualFinancials {
  return {
    periodEnd,
    revenue: null, costOfRevenue: null, grossProfit: null, sga: null,
    depreciation: null, ebit: null, netIncome: null,
    cashAndEquivalents: null, receivables: null, currentAssets: null,
    ppe: null, totalAssets: null, currentLiabilities: null,
    longTermDebt: null, totalLiabilities: null, retainedEarnings: null,
    sharesOutstanding: null, operatingCashFlow: null
  };
}

// Maps from DB line_item strings → AnnualFinancials field. Mirror of the
// yfinance script's mapping side. Centralized here so the compute layer
// stays pure-functional and unaware of DB strings.
function applyLineItem(f: AnnualFinancials, lineItem: string, value: number): void {
  switch (lineItem) {
    case 'revenue':                       f.revenue = value; break;
    case 'cost_of_revenue':               f.costOfRevenue = value; break;
    case 'gross_profit':                  f.grossProfit = value; break;
    case 'selling_general_admin':         f.sga = value; break;
    case 'depreciation_amortization':     f.depreciation = value; break;
    case 'operating_income':              f.ebit = value; break;   // proxy for EBIT
    case 'net_income':                    f.netIncome = value; break;
    case 'cash_and_equivalents':          f.cashAndEquivalents = value; break;
    case 'accounts_receivable':           f.receivables = value; break;
    case 'current_assets':                f.currentAssets = value; break;
    case 'property_plant_equipment_net':  f.ppe = value; break;
    case 'total_assets':                  f.totalAssets = value; break;
    case 'current_liabilities':           f.currentLiabilities = value; break;
    case 'long_term_debt':                f.longTermDebt = value; break;
    case 'total_liabilities':             f.totalLiabilities = value; break;
    case 'retained_earnings':             f.retainedEarnings = value; break;
    case 'shares_outstanding':            f.sharesOutstanding = value; break;
    case 'operating_cash_flow':           f.operatingCashFlow = value; break;
    // Other line items (earnings_per_share, free_cash_flow, etc.) are
    // ignored — not needed by the three scores.
  }
}
