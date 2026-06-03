export interface SeriesPoint { date: string; value: number }
export type Direction = 'higher' | 'lower';

export interface CountryInput {
  code: string; name: string; flag: string;
  series: { cli: SeriesPoint[]; unemployment: SeriesPoint[]; longRate: SeriesPoint[]; cpi: SeriesPoint[]; etf: SeriesPoint[] };
}
export interface RankedRow {
  code: string; name: string; flag: string; composite: number; rank: number;
  dims: { growth: number; inflation: number; rates: number; labor: number; equity: number };
}

export function percentile(values: number[], v: number): number {
  if (values.length === 0) return 50;
  return (values.filter((x) => x <= v).length / values.length) * 100;
}
export function orientedPercentile(values: number[], v: number, dir: Direction): number {
  const p = percentile(values, v);
  return dir === 'lower' ? 100 - p : p;
}
function last(series: SeriesPoint[]): number | null { return series.length ? series[series.length - 1]!.value : null; }
function valueMonthsAgo(series: SeriesPoint[], months: number): number | null {
  if (series.length === 0) return null;
  const target = new Date(series[series.length - 1]!.date); target.setMonth(target.getMonth() - months);
  let best: SeriesPoint | null = null;
  for (const p of series) { if (new Date(p.date).getTime() <= target.getTime()) best = p; else break; }
  return best ? best.value : series[0]!.value;
}
export function changeOverMonths(series: SeriesPoint[], months: number): number | null {
  const l = last(series), past = valueMonthsAgo(series, months);
  return l == null || past == null ? null : l - past;
}
export function pctReturnOverMonths(series: SeriesPoint[], months: number): number | null {
  const l = last(series), past = valueMonthsAgo(series, months);
  return l == null || past == null || past === 0 ? null : ((l - past) / past) * 100;
}
export function pctVsMA(series: SeriesPoint[], days: number): number | null {
  if (series.length < Math.min(days, 20)) return null;
  const window = series.slice(-days);
  const ma = window.reduce((a, b) => a + b.value, 0) / window.length;
  const l = last(series);
  return l == null || ma === 0 ? null : ((l - ma) / ma) * 100;
}
function yoyLatest(series: SeriesPoint[]): number | null {
  const l = last(series), prior = valueMonthsAgo(series, 12);
  return l == null || prior == null || prior === 0 ? null : ((l - prior) / prior) * 100;
}
function yoySeries(series: SeriesPoint[]): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (let i = 12; i < series.length; i++) {
    const prior = valueMonthsAgo(series.slice(0, i + 1), 12);
    if (prior != null && prior !== 0) out.push({ date: series[i]!.date, value: ((series[i]!.value - prior) / prior) * 100 });
  }
  return out;
}

type MetricKey =
  | 'growthLevel' | 'growthMom' | 'inflLevel' | 'inflMom' | 'ratesLevel' | 'ratesMom'
  | 'laborLevel' | 'laborMom' | 'equityLevel' | 'equityMom';

const DIRECTION: Record<MetricKey, Direction> = {
  growthLevel: 'higher', growthMom: 'higher',
  inflLevel: 'lower', inflMom: 'lower',
  ratesLevel: 'lower', ratesMom: 'lower',
  laborLevel: 'lower', laborMom: 'lower',
  equityLevel: 'higher', equityMom: 'higher',
};
const DIMS: Record<keyof RankedRow['dims'], [MetricKey, MetricKey]> = {
  growth: ['growthLevel', 'growthMom'],
  inflation: ['inflLevel', 'inflMom'],
  rates: ['ratesLevel', 'ratesMom'],
  labor: ['laborLevel', 'laborMom'],
  equity: ['equityLevel', 'equityMom'],
};

function rawMetrics(c: CountryInput): Record<MetricKey, number | null> {
  const infl = yoySeries(c.series.cpi);
  return {
    growthLevel: last(c.series.cli),
    growthMom: changeOverMonths(c.series.cli, 6),
    inflLevel: yoyLatest(c.series.cpi),
    inflMom: changeOverMonths(infl, 6),
    ratesLevel: last(c.series.longRate),
    ratesMom: changeOverMonths(c.series.longRate, 6),
    laborLevel: last(c.series.unemployment),
    laborMom: changeOverMonths(c.series.unemployment, 12),
    equityLevel: pctReturnOverMonths(c.series.etf, 6),
    equityMom: pctVsMA(c.series.etf, 200),
  };
}

export function scoreCountries(countries: CountryInput[]): RankedRow[] {
  const raw = countries.map((c) => ({ c, m: rawMetrics(c) }));
  const pools = {} as Record<MetricKey, number[]>;
  (Object.keys(DIRECTION) as MetricKey[]).forEach((k) => {
    pools[k] = raw.map((r) => r.m[k]).filter((v): v is number => v != null);
  });
  const rows: RankedRow[] = raw.map(({ c, m }) => {
    const metricPct = (k: MetricKey): number => (m[k] == null ? 50 : orientedPercentile(pools[k], m[k]!, DIRECTION[k]));
    const dims = {} as RankedRow['dims'];
    (Object.keys(DIMS) as (keyof RankedRow['dims'])[]).forEach((d) => {
      const [lv, mo] = DIMS[d];
      dims[d] = Math.round((metricPct(lv) + metricPct(mo)) / 2);
    });
    const composite = Math.round((dims.growth + dims.inflation + dims.rates + dims.labor + dims.equity) / 5);
    return { code: c.code, name: c.name, flag: c.flag, composite, rank: 0, dims };
  });
  rows.sort((a, b) => b.composite - a.composite || a.code.localeCompare(b.code));
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}
