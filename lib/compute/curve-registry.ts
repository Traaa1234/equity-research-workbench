export interface MaturityDef { seriesId: string; label: string; months: number }

export const CURVE_MATURITIES: MaturityDef[] = [
  { seriesId: 'DGS3MO', label: '3M', months: 3 },
  { seriesId: 'DGS6MO', label: '6M', months: 6 },
  { seriesId: 'DGS1', label: '1Y', months: 12 },
  { seriesId: 'DGS2', label: '2Y', months: 24 },
  { seriesId: 'DGS5', label: '5Y', months: 60 },
  { seriesId: 'DGS7', label: '7Y', months: 84 },
  { seriesId: 'DGS10', label: '10Y', months: 120 },
  { seriesId: 'DGS20', label: '20Y', months: 240 },
  { seriesId: 'DGS30', label: '30Y', months: 360 },
];

export interface SpreadDef { key: string; label: string; long: string; short: string }
export const CURVE_SPREADS: SpreadDef[] = [
  { key: '2s10s', label: '2s10s', long: 'DGS10', short: 'DGS2' },
  { key: '3m10y', label: '3m10y', long: 'DGS10', short: 'DGS3MO' },
  { key: '5s30s', label: '5s30s', long: 'DGS30', short: 'DGS5' },
];

export function curveSeriesIds(): string[] { return CURVE_MATURITIES.map((m) => m.seriesId); }
