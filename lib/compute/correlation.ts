import type { Transform } from './correlation-registry';

export interface SeriesPoint { date: string; value: number }

export function dailyChange(series: SeriesPoint[], transform: Transform): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!.value, cur = series[i]!.value;
    const v = transform === 'return' ? (prev === 0 ? 0 : cur / prev - 1) : cur - prev;
    out.push({ date: series[i]!.date, value: v });
  }
  return out;
}

/** Align change-series on the intersection of their dates (ascending). Returns parallel value rows. */
export function alignByDate(seriesList: SeriesPoint[][]): { dates: string[]; values: number[][] } {
  if (seriesList.length === 0) return { dates: [], values: [] };
  const maps = seriesList.map((s) => new Map(s.map((p) => [p.date, p.value])));
  const dates = [...maps[0]!.keys()].filter((d) => maps.every((m) => m.has(d))).sort();
  const values = maps.map((m) => dates.map((d) => m.get(d)!));
  return { dates, values };
}

export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 10) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]!; sy += ys[i]!; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i]! - mx, dy = ys[i]! - my; cov += dx * dy; vx += dx * dx; vy += dy * dy; }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

/** N×N matrix of pairwise Pearson over the last `windowDays` aligned obs. Diagonal = 1. */
export function correlationMatrix(aligned: number[][], windowDays: number): (number | null)[][] {
  const windows = aligned.map((row) => row.slice(-windowDays));
  const n = aligned.length;
  const m: (number | null)[][] = [];
  for (let i = 0; i < n; i++) {
    m[i] = [];
    for (let j = 0; j < n; j++) m[i]![j] = i === j ? 1 : pearson(windows[i]!, windows[j]!);
  }
  return m;
}
