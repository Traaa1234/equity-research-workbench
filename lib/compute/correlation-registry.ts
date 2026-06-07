export type Transform = 'return' | 'diff';
export interface CorrAsset { seriesId: string; label: string; transform: Transform }

export const CORR_ASSETS: CorrAsset[] = [
  { seriesId: 'SPY', label: 'EQ', transform: 'return' },
  { seriesId: 'DGS10', label: '10Y', transform: 'diff' },
  { seriesId: 'GC=F', label: 'GOLD', transform: 'return' },
  { seriesId: 'DTWEXBGS', label: 'USD', transform: 'diff' },
  { seriesId: 'BAMLH0A0HYM2', label: 'HY', transform: 'diff' },
  { seriesId: 'CL=F', label: 'OIL', transform: 'return' },
  { seriesId: '^VIX', label: 'VIX', transform: 'diff' },
];

export function corrSeriesIds(): string[] { return CORR_ASSETS.map((a) => a.seriesId); }
