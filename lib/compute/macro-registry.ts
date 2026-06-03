import {
  curveClassifier, classifyHySpread, classifyVix, classifyNfci, classifyCpiYoY,
  classifySahm, classifyCopperMomentum, percentileClassifier, bandClassifier,
  type Classifier,
} from './macro-signals';

export type AssetClass = 'rates' | 'credit' | 'inflation_growth' | 'dollar_fx' | 'commodities' | 'vol_conditions';
export type MacroSource = 'fred' | 'yfinance';

export interface MacroSeriesDef {
  seriesId: string;       // storage key = FRED id or yfinance symbol
  label: string;
  assetClass: AssetClass;
  source: MacroSource;
  unit: string;           // '%', '$', 'idx'
  decimals: number;
  role: 'vote' | 'context';
  derive?: 'yoy';
  classify: Classifier;
}

export const ASSET_CLASS_ORDER: AssetClass[] = [
  'rates', 'credit', 'inflation_growth', 'dollar_fx', 'commodities', 'vol_conditions',
];
export const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  rates: 'Rates & Curve',
  credit: 'Credit',
  inflation_growth: 'Inflation & Growth',
  dollar_fx: 'Dollar & FX',
  commodities: 'Commodities',
  vol_conditions: 'Volatility & Conditions',
};

export const MACRO_REGISTRY: MacroSeriesDef[] = [
  // Rates & Curve
  { seriesId: 'T10Y2Y', label: '2s10s Spread', assetClass: 'rates', source: 'fred', unit: '%', decimals: 2, role: 'vote', classify: curveClassifier(0.25) },
  { seriesId: 'T10Y3M', label: '3m10y Spread', assetClass: 'rates', source: 'fred', unit: '%', decimals: 2, role: 'context', classify: curveClassifier(0.5) },
  { seriesId: 'DGS10', label: '10Y Yield', assetClass: 'rates', source: 'fred', unit: '%', decimals: 2, role: 'context', classify: percentileClassifier(['LOW', 'NORMAL', 'ELEVATED']) },
  { seriesId: 'DFF', label: 'Fed Funds', assetClass: 'rates', source: 'fred', unit: '%', decimals: 2, role: 'context', classify: bandClassifier(2.5, 4, ['ACCOMMODATIVE', 'NEUTRAL', 'RESTRICTIVE']) },
  // Credit
  { seriesId: 'BAMLH0A0HYM2', label: 'HY OAS Spread', assetClass: 'credit', source: 'fred', unit: '%', decimals: 2, role: 'vote', classify: classifyHySpread },
  // Inflation & Growth
  { seriesId: 'CPIAUCSL', label: 'CPI (YoY)', assetClass: 'inflation_growth', source: 'fred', unit: '%', decimals: 1, role: 'vote', derive: 'yoy', classify: classifyCpiYoY },
  { seriesId: 'UNRATE', label: 'Unemployment', assetClass: 'inflation_growth', source: 'fred', unit: '%', decimals: 1, role: 'vote', classify: classifySahm },
  // Dollar & FX
  { seriesId: 'DTWEXBGS', label: 'Broad USD Index', assetClass: 'dollar_fx', source: 'fred', unit: 'idx', decimals: 1, role: 'context', classify: percentileClassifier(['WEAK', 'MID', 'STRONG']) },
  // Commodities
  { seriesId: 'GC=F', label: 'Gold', assetClass: 'commodities', source: 'yfinance', unit: '$', decimals: 0, role: 'context', classify: percentileClassifier(['LOW', 'FIRM', 'ELEVATED']) },
  { seriesId: 'CL=F', label: 'WTI Crude', assetClass: 'commodities', source: 'yfinance', unit: '$', decimals: 1, role: 'context', classify: percentileClassifier(['CHEAP', 'RANGE', 'RICH']) },
  { seriesId: 'HG=F', label: 'Copper (Dr.)', assetClass: 'commodities', source: 'yfinance', unit: '$', decimals: 2, role: 'vote', classify: classifyCopperMomentum },
  // Volatility & Conditions
  { seriesId: '^VIX', label: 'VIX', assetClass: 'vol_conditions', source: 'yfinance', unit: '', decimals: 1, role: 'vote', classify: classifyVix },
  { seriesId: 'NFCI', label: 'Chicago Fed NFCI', assetClass: 'vol_conditions', source: 'fred', unit: '', decimals: 2, role: 'vote', classify: classifyNfci },
];
