/**
 * Pure formatters turning per-service signal data into compact UI Cells.
 * No DB, no network, no React — just data-shape transformations.
 *
 * Each formatter handles null/empty inputs gracefully (returns the
 * '—' or '· quiet' Cell instead of throwing).
 */

export type CellColor = 'green' | 'red' | 'amber' | 'muted' | 'default';

export interface Cell {
  glyph: string;
  color: CellColor;
  tooltip?: string;
}

// -------- snapshot --------

export function snapshotToCell(
  snap: { price: number | null; changePct: number | null } | null
): Cell {
  if (snap == null || snap.price == null) {
    return { glyph: '—', color: 'muted' };
  }
  const priceStr = `$${snap.price.toFixed(2)}`;
  if (snap.changePct == null || snap.changePct === 0) {
    return { glyph: priceStr, color: 'muted' };
  }
  const pct = snap.changePct * 100;
  const sign = pct > 0 ? '+' : '';
  const color: CellColor = pct > 0 ? 'green' : 'red';
  return {
    glyph: `${priceStr}  ${sign}${pct.toFixed(1)}%`,
    color
  };
}

// -------- technical --------

export function technicalToCell(
  tech: { rsi: number | null; recentCross: 'golden' | 'death' | null }
): Cell {
  if (tech.rsi == null) {
    return { glyph: '—', color: 'muted' };
  }
  if (tech.rsi > 70) {
    return { glyph: 'OB', color: 'red', tooltip: `RSI ${tech.rsi.toFixed(0)} (overbought)` };
  }
  if (tech.rsi < 30) {
    return { glyph: 'OS', color: 'green', tooltip: `RSI ${tech.rsi.toFixed(0)} (oversold)` };
  }
  if (tech.recentCross === 'golden') {
    return { glyph: 'GC', color: 'green', tooltip: 'Golden cross within 10 days' };
  }
  if (tech.recentCross === 'death') {
    return { glyph: 'DC', color: 'red', tooltip: 'Death cross within 10 days' };
  }
  return { glyph: '●', color: 'muted', tooltip: `RSI ${tech.rsi.toFixed(0)}` };
}

// -------- news --------

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function newsToCell(
  articles: Array<{ publishedAt: Date; sentiment: 'bullish' | 'bearish' | 'neutral' | null }>
): Cell {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const recent = articles.filter((a) => a.publishedAt.getTime() >= cutoff);
  if (recent.length === 0) {
    return { glyph: '· quiet', color: 'muted' };
  }
  const bull = recent.filter((a) => a.sentiment === 'bullish').length;
  const bear = recent.filter((a) => a.sentiment === 'bearish').length;
  const neut = recent.length - bull - bear;
  const skew = bull - bear;
  let color: CellColor = 'muted';
  if (skew >= 2) color = 'green';
  else if (skew <= -2) color = 'red';
  return {
    glyph: `+${recent.length} art`,
    color,
    tooltip: `${bull} bullish · ${neut} neutral · ${bear} bearish (past 7d)`
  };
}

// -------- insiders --------

export function insidersToCell(
  agg: { hasClusterBuy: boolean; netShares: number; buyCount: number; sellCount: number } | null
): Cell {
  if (agg == null) return { glyph: '—', color: 'muted' };
  if (agg.hasClusterBuy) {
    return { glyph: '⚡ cluster', color: 'green', tooltip: 'Cluster-buy detected (Lakonishok-Lee)' };
  }
  if (agg.netShares > 0 && agg.buyCount > 0) {
    return { glyph: `+${agg.buyCount} buys`, color: 'green' };
  }
  if (agg.netShares < 0 && agg.sellCount > 0) {
    return { glyph: `-${agg.sellCount} sells`, color: 'red' };
  }
  return { glyph: '· quiet', color: 'muted' };
}

// -------- filings --------

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function filingsToCell(
  filing: { formType: string; filingDate: string } | null,
  asOf: Date = new Date()
): Cell {
  if (filing == null) return { glyph: '—', color: 'muted' };
  const filedMs = Date.parse(filing.filingDate + 'T00:00:00Z');
  const days = Number.isFinite(filedMs)
    ? Math.max(0, Math.floor((asOf.getTime() - filedMs) / ONE_DAY_MS))
    : null;
  if (days == null) return { glyph: filing.formType, color: 'muted' };
  const color: CellColor = days <= 7 ? 'amber' : 'default';
  return { glyph: `${filing.formType} · ${days}d`, color };
}
