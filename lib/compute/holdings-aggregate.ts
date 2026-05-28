/**
 * Pure compute over institutional holdings rows. No DB, no network.
 *
 * - classifyDelta: returns 'new' | 'added' | 'reduced' | 'sold-out' | 'unchanged'
 *   based on shares vs. prevShares, with a 5% threshold to filter rounding noise.
 * - joinHoldersWithDeltas: matches current-quarter rows against previous-quarter
 *   rows by investorId, emits one HolderWithDelta per fund (including funds that
 *   exited — represented as shares=0, delta='sold-out').
 * - computeHoldingsAggregate: rolls up totals, top-10 concentration, smart-money
 *   moves, breadth trend.
 *
 * The 5% threshold is industry-standard (WhaleWisdom and similar trackers use
 * the same cutoff) — filters position-noise from real investment intent.
 */

import { matchSmartMoney, type SmartMoneyCategory } from './smart-money';

export type HolderDelta = 'new' | 'added' | 'reduced' | 'sold-out' | 'unchanged';

export interface HoldingsRow {
  investorId: string;
  investorName: string;
  reportPeriod: string;          // ISO YYYY-MM-DD
  shares: number;
  marketValue: number | null;
  sharesPctOfPortfolio: number | null;
}

export interface HolderWithDelta {
  investorId: string;
  investorName: string;
  shares: number;
  marketValue: number | null;
  sharesPctOfPortfolio: number | null;
  delta: HolderDelta;
  sharesPrev: number | null;
  sharesChange: number;
  isSmartMoney: boolean;
  smartMoneyCategory: SmartMoneyCategory | null;
}

export interface HoldingsAggregate {
  currentPeriod: string | null;
  previousPeriod: string | null;
  totalHolders: number;
  totalSharesHeld: number;
  totalMarketValue: number;
  top10Concentration: number;
  breadthTrend: Array<{ period: string; holders: number }>;
  newPositions: number;
  exits: number;
  smartMoneyMoves: {
    additions: HolderWithDelta[];
    reductions: HolderWithDelta[];
  };
}

const ADDED_THRESHOLD = 0.05;
const REDUCED_THRESHOLD = -0.05;

export function classifyDelta(currentShares: number, prevShares: number | null): HolderDelta {
  if (prevShares == null || prevShares === 0) {
    return currentShares > 0 ? 'new' : 'unchanged';
  }
  if (currentShares === 0) return 'sold-out';
  const pctChange = (currentShares - prevShares) / prevShares;
  if (pctChange > ADDED_THRESHOLD) return 'added';
  if (pctChange < REDUCED_THRESHOLD) return 'reduced';
  return 'unchanged';
}

export function joinHoldersWithDeltas(
  currentRows: HoldingsRow[],
  previousRows: HoldingsRow[]
): HolderWithDelta[] {
  const prevById = new Map<string, HoldingsRow>(
    previousRows.map((r) => [r.investorId, r])
  );
  const currentIds = new Set<string>();
  const out: HolderWithDelta[] = [];

  for (const cur of currentRows) {
    currentIds.add(cur.investorId);
    const prev = prevById.get(cur.investorId) ?? null;
    const delta = classifyDelta(cur.shares, prev?.shares ?? null);
    const sm = matchSmartMoney(cur.investorId, cur.investorName);
    out.push({
      investorId: cur.investorId,
      investorName: cur.investorName,
      shares: cur.shares,
      marketValue: cur.marketValue,
      sharesPctOfPortfolio: cur.sharesPctOfPortfolio,
      delta,
      sharesPrev: prev?.shares ?? null,
      sharesChange: cur.shares - (prev?.shares ?? 0),
      isSmartMoney: sm !== null,
      smartMoneyCategory: sm?.category ?? null
    });
  }

  // Funds in previous but not in current = sold-out
  for (const prev of previousRows) {
    if (currentIds.has(prev.investorId)) continue;
    const sm = matchSmartMoney(prev.investorId, prev.investorName);
    out.push({
      investorId: prev.investorId,
      investorName: prev.investorName,
      shares: 0,
      marketValue: 0,
      sharesPctOfPortfolio: null,
      delta: 'sold-out',
      sharesPrev: prev.shares,
      sharesChange: -prev.shares,
      isSmartMoney: sm !== null,
      smartMoneyCategory: sm?.category ?? null
    });
  }

  return out;
}

export function computeHoldingsAggregate(
  joined: HolderWithDelta[],
  breadthTrend: Array<{ period: string; holders: number }>
): HoldingsAggregate {
  // Current-quarter participants only (exclude sold-out, which have shares=0).
  const current = joined.filter((h) => h.shares > 0);

  const totalSharesHeld = current.reduce((s, h) => s + h.shares, 0);
  const totalMarketValue = current.reduce((s, h) => s + (h.marketValue ?? 0), 0);

  // Top-10 concentration: sum of top 10 by shares / total
  const sortedDesc = [...current].sort((a, b) => b.shares - a.shares);
  const top10Sum = sortedDesc.slice(0, 10).reduce((s, h) => s + h.shares, 0);
  const top10Concentration = totalSharesHeld > 0 ? top10Sum / totalSharesHeld : 0;

  const newPositions = joined.filter((h) => h.delta === 'new').length;
  const exits = joined.filter((h) => h.delta === 'sold-out').length;

  const smartMoney = joined.filter((h) => h.isSmartMoney);
  const additions = smartMoney.filter((h) => h.delta === 'new' || h.delta === 'added');
  const reductions = smartMoney.filter((h) => h.delta === 'reduced' || h.delta === 'sold-out');

  return {
    currentPeriod: breadthTrend[0]?.period ?? null,
    previousPeriod: breadthTrend[1]?.period ?? null,
    totalHolders: current.length,
    totalSharesHeld,
    totalMarketValue,
    top10Concentration,
    breadthTrend,
    newPositions,
    exits,
    smartMoneyMoves: { additions, reductions }
  };
}
