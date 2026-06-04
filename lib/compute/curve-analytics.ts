import { CURVE_MATURITIES, CURVE_SPREADS } from './curve-registry';

export interface SeriesPoint { date: string; value: number }
export type CurveShape = 'INVERTED' | 'PARTIALLY_INVERTED' | 'FLAT' | 'HUMPED' | 'NORMAL';
export type Momentum = 'steepening' | 'flattening' | 'stable';
export type RecessionLevel = 'ON' | 'CAUTION' | 'WATCH' | 'CLEAR';

function last(series: SeriesPoint[]): number | null { return series.length ? series[series.length - 1]!.value : null; }
function valueMonthsAgo(series: SeriesPoint[], months: number): number | null {
  if (series.length === 0) return null;
  const target = new Date(series[series.length - 1]!.date); target.setMonth(target.getMonth() - months);
  let best: SeriesPoint | null = null;
  for (const p of series) { if (new Date(p.date).getTime() <= target.getTime()) best = p; else break; }
  return best ? best.value : null;
}
export function changeOverMonths(series: SeriesPoint[], months: number): number | null {
  const l = last(series), past = valueMonthsAgo(series, months);
  return l == null || past == null ? null : l - past;
}
function monthsBetween(a: string, b: string): number {
  const d1 = new Date(a), d2 = new Date(b);
  return (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth());
}

export function spreadSeries(longH: SeriesPoint[], shortH: SeriesPoint[]): SeriesPoint[] {
  const shortMap = new Map(shortH.map((p) => [p.date, p.value]));
  const out: SeriesPoint[] = [];
  for (const p of longH) { const sv = shortMap.get(p.date); if (sv != null) out.push({ date: p.date, value: p.value - sv }); }
  return out;
}

export function classifyShape(y: Record<string, number | null | undefined>): CurveShape | null {
  const g3m = y.DGS3MO, g2 = y.DGS2, g5 = y.DGS5, g10 = y.DGS10, g30 = y.DGS30;
  if (g10 == null || g3m == null || g2 == null) return null;
  const m3m10y = g10 - g3m, m2s10s = g10 - g2;
  if (m3m10y < 0 && m2s10s < 0) return 'INVERTED';
  if ((m3m10y < 0) !== (m2s10s < 0)) return 'PARTIALLY_INVERTED';
  if (Math.abs(g10 - g3m) < 0.25) return 'FLAT';
  if (g5 != null && g30 != null && Math.max(g2, g5) > Math.max(g3m, g30) + 0.1) return 'HUMPED';
  return 'NORMAL';
}

export function momentumTag(s2s10s: SeriesPoint[]): Momentum {
  const chg = changeOverMonths(s2s10s, 3);
  if (chg == null) return 'stable';
  if (chg > 0.1) return 'steepening';
  if (chg < -0.1) return 'flattening';
  return 'stable';
}

export function spreadBadge(v: number | null): string {
  if (v == null) return 'N/A';
  if (v < 0) return 'INVERTED';
  if (v < 0.25) return 'FLAT';
  if (v > 0.5) return 'STEEP';
  return 'POSITIVE';
}

export function lastSignChangeMonths(s3m10y: SeriesPoint[]): { invertedNow: boolean; monthsInverted: number; monthsSinceInverted: number } {
  if (s3m10y.length === 0) return { invertedNow: false, monthsInverted: 0, monthsSinceInverted: 999 };
  const lp = s3m10y[s3m10y.length - 1]!;
  const invertedNow = lp.value < 0;
  if (invertedNow) {
    let streakStart = lp.date;
    for (let i = s3m10y.length - 1; i >= 0; i--) {
      if (s3m10y[i]!.value < 0) streakStart = s3m10y[i]!.date; else break;
    }
    return { invertedNow, monthsInverted: monthsBetween(streakStart, lp.date), monthsSinceInverted: 0 };
  }
  let lastNeg: string | null = null;
  for (let i = s3m10y.length - 1; i >= 0; i--) { if (s3m10y[i]!.value < 0) { lastNeg = s3m10y[i]!.date; break; } }
  return { invertedNow, monthsInverted: 0, monthsSinceInverted: lastNeg ? monthsBetween(lastNeg, lp.date) : 999 };
}

export function recessionSignal(s3m10y: SeriesPoint[], s2s10s: SeriesPoint[]): { level: RecessionLevel; label: string; durationMo: number } {
  const l3 = last(s3m10y), l2 = last(s2s10s);
  const inv3 = l3 != null && l3 < 0, inv2 = l2 != null && l2 < 0;
  const dur = lastSignChangeMonths(s3m10y);
  if (inv3 && inv2) return { level: 'ON', label: 'Both curves inverted', durationMo: dur.monthsInverted };
  if (inv3 || inv2) return { level: 'CAUTION', label: 'Front-end inverted', durationMo: dur.monthsInverted };
  if (!dur.invertedNow && dur.monthsSinceInverted <= 6) return { level: 'WATCH', label: 'Curve re-steepening (late-cycle window)', durationMo: dur.monthsSinceInverted };
  return { level: 'CLEAR', label: 'Positively sloped', durationMo: 0 };
}

export interface CurveResult {
  maturities: { seriesId: string; label: string; months: number; current: number | null; change1d: number | null; overlay: { m1: number | null; y1: number | null; y2: number | null } }[];
  spreads: { key: string; label: string; value: number | null; badge: string; durationMo?: number }[];
  read: { shape: CurveShape | null; momentum: Momentum; recession: { level: RecessionLevel; label: string; durationMo: number } };
}

export function buildCurve(histories: Record<string, SeriesPoint[]>): CurveResult {
  const h = (id: string) => histories[id] ?? [];
  const latestById: Record<string, number | null> = {};
  for (const m of CURVE_MATURITIES) latestById[m.seriesId] = last(h(m.seriesId));

  const maturities = CURVE_MATURITIES.map((m) => {
    const hist = h(m.seriesId);
    const n = hist.length;
    return {
      seriesId: m.seriesId, label: m.label, months: m.months,
      current: n ? hist[n - 1]!.value : null,
      change1d: n >= 2 ? hist[n - 1]!.value - hist[n - 2]!.value : null,
      overlay: { m1: valueMonthsAgo(hist, 1), y1: valueMonthsAgo(hist, 12), y2: valueMonthsAgo(hist, 24) },
    };
  });

  const seriesByKey: Record<string, SeriesPoint[]> = {};
  const spreads = CURVE_SPREADS.map((sp) => {
    const ss = spreadSeries(h(sp.long), h(sp.short));
    seriesByKey[sp.key] = ss;
    const v = last(ss);
    const out: CurveResult['spreads'][number] = { key: sp.key, label: sp.label, value: v, badge: spreadBadge(v) };
    if (sp.key === '3m10y') out.durationMo = lastSignChangeMonths(ss).monthsInverted;
    return out;
  });

  const read = {
    shape: classifyShape(latestById),
    momentum: momentumTag(seriesByKey['2s10s'] ?? []),
    recession: recessionSignal(seriesByKey['3m10y'] ?? [], seriesByKey['2s10s'] ?? []),
  };
  return { maturities, spreads, read };
}
