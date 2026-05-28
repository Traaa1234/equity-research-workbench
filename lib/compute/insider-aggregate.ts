/**
 * Pure compute over SEC Form 4 insider transactions. No DB, no network.
 *
 * Classification rules: open-market purchases and sales are the only
 * "conviction signals." Awards, option exercises, and other transaction
 * types are compensation/admin and excluded from headline metrics —
 * they still appear in the full transaction list (UI handles glyphs).
 *
 * Cluster-buy detection follows the Lakonishok-Lee (2001) convention:
 * 2+ distinct insiders making open-market purchases within a rolling
 * 30-day window is a strong directional signal.
 */

export type TransactionClass = 'buy' | 'sell' | 'award' | 'exercise' | 'other';

export interface InsiderTradeRow {
  insiderName: string;
  insiderTitle: string | null;
  transactionDate: string;     // ISO YYYY-MM-DD
  transactionType: string;
  shares: number;
  transactionValue: number | null;
}

export interface InsiderAggregate {
  windowDays: number;
  netShares: number;
  netDollarValue: number;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  largestBuy: { name: string; date: string; valueUsd: number } | null;
  largestSell: { name: string; date: string; valueUsd: number } | null;
  hasClusterBuy: boolean;
  clusterBuyDates: string[];
  lastTransactionDate: string | null;
}

/**
 * Classify a transaction type string into one of 5 buckets.
 * Case-insensitive substring match — handles FD's various phrasings.
 */
export function classifyTransaction(type: string): TransactionClass {
  const t = type.toLowerCase();
  if (t.includes('open market purchase') || t.includes('open market buy')) return 'buy';
  if (t.includes('open market sale') || t.includes('open market sell')) return 'sell';
  if (t.includes('award') || t.includes('grant')) return 'award';
  if (t.includes('exercise')) return 'exercise';
  return 'other';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute aggregate over rows. `rows` must be sorted newest-first.
 * `asOf` defaults to now; pass a fixed Date in tests for determinism.
 */
export function computeInsiderAggregate(
  rows: InsiderTradeRow[],
  windowDays = 90,
  asOf: Date = new Date()
): InsiderAggregate {
  const cutoffMs = asOf.getTime() - windowDays * DAY_MS;
  const inWindow = rows.filter((r) => {
    const ms = Date.parse(r.transactionDate + 'T00:00:00Z');
    return Number.isFinite(ms) && ms >= cutoffMs;
  });

  const buys = inWindow.filter((r) => classifyTransaction(r.transactionType) === 'buy');
  const sells = inWindow.filter((r) => classifyTransaction(r.transactionType) === 'sell');

  const buyShares = buys.reduce((s, r) => s + r.shares, 0);
  const sellShares = sells.reduce((s, r) => s + r.shares, 0);
  const buyValue = buys.reduce((s, r) => s + (r.transactionValue ?? 0), 0);
  const sellValue = sells.reduce((s, r) => s + (r.transactionValue ?? 0), 0);

  const uniqueBuyers = new Set(buys.map((r) => r.insiderName)).size;
  const uniqueSellers = new Set(sells.map((r) => r.insiderName)).size;

  function largest(arr: InsiderTradeRow[]): { name: string; date: string; valueUsd: number } | null {
    let best: InsiderTradeRow | null = null;
    for (const r of arr) {
      const v = r.transactionValue ?? 0;
      const bestV = best?.transactionValue ?? 0;
      if (best === null || v > bestV) best = r;
    }
    if (!best) return null;
    return {
      name: best.insiderName,
      date: best.transactionDate,
      valueUsd: best.transactionValue ?? 0
    };
  }

  // Cluster-buy detection: for each buy, look at all buys within +/- 30 days.
  // If the union of distinct names (including the anchor) is >= 2, mark a cluster
  // starting at that anchor's date. Then dedupe overlapping clusters by keeping
  // the earliest anchor per 30-day stretch.
  const clusterBuyDates: string[] = [];
  const buysAsc = [...buys].sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));
  let lastEmittedDate: string | null = null;
  for (let i = 0; i < buysAsc.length; i++) {
    const anchor = buysAsc[i]!;
    if (lastEmittedDate && daysBetween(anchor.transactionDate, lastEmittedDate) < 30) continue;
    const anchorMs = Date.parse(anchor.transactionDate + 'T00:00:00Z');
    const windowEnd = anchorMs + 30 * DAY_MS;
    const namesInWindow = new Set<string>();
    for (let j = i; j < buysAsc.length; j++) {
      const next = buysAsc[j]!;
      const nextMs = Date.parse(next.transactionDate + 'T00:00:00Z');
      if (nextMs > windowEnd) break;
      namesInWindow.add(next.insiderName);
    }
    if (namesInWindow.size >= 2) {
      clusterBuyDates.push(anchor.transactionDate);
      lastEmittedDate = anchor.transactionDate;
    }
  }

  const lastTransactionDate = inWindow.length > 0
    ? inWindow.map((r) => r.transactionDate).sort().pop()!
    : null;

  return {
    windowDays,
    netShares: buyShares - sellShares,
    netDollarValue: buyValue - sellValue,
    buyCount: buys.length,
    sellCount: sells.length,
    uniqueBuyers,
    uniqueSellers,
    largestBuy: largest(buys),
    largestSell: largest(sells),
    hasClusterBuy: clusterBuyDates.length > 0,
    clusterBuyDates,
    lastTransactionDate
  };
}

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(
    Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')
  );
  return ms / DAY_MS;
}
