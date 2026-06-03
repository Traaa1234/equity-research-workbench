export type SignalLevel = -1 | 0 | 1;
export interface SeriesPoint { date: string; value: number }
export interface ClassifyInput { value: number; series: SeriesPoint[] }
export interface SignalResult { badge: string; level: SignalLevel; explain: string }
export type Classifier = (input: ClassifyInput) => SignalResult;

const f = (n: number, d = 2) => n.toFixed(d);

// ---- helpers ----

export function percentileRank(values: number[], v: number): number {
  if (values.length === 0) return 0.5;
  const below = values.filter((x) => x <= v).length;
  return below / values.length;
}

export function valueMonthsAgo(series: SeriesPoint[], months: number): number | null {
  if (series.length === 0) return null;
  const last = series[series.length - 1]!;
  const target = new Date(last.date);
  target.setMonth(target.getMonth() - months);
  let best: SeriesPoint | null = null;
  for (const p of series) {
    if (new Date(p.date).getTime() <= target.getTime()) best = p;
    else break;
  }
  return best ? best.value : series[0]!.value;
}

export function pctChangeOverMonths(series: SeriesPoint[], months: number): number {
  if (series.length === 0) return 0;
  const last = series[series.length - 1]!.value;
  const past = valueMonthsAgo(series, months);
  if (past == null || past === 0) return 0;
  return ((last - past) / past) * 100;
}

export function sahmGap(values: number[]): number {
  const last3 = values.slice(-3);
  const avg3 = last3.reduce((a, b) => a + b, 0) / Math.max(1, last3.length);
  const min12 = Math.min(...values.slice(-12));
  return avg3 - min12;
}

export function yoySeries(series: SeriesPoint[]): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (let i = 0; i < series.length; i++) {
    const prior = valueMonthsAgo(series.slice(0, i + 1), 12);
    if (prior != null && prior !== 0) {
      out.push({ date: series[i]!.date, value: ((series[i]!.value - prior) / prior) * 100 });
    }
  }
  return out;
}

// ---- voting classifiers ----

export function curveClassifier(flatUpper: number): Classifier {
  return ({ value }) => {
    if (value < 0) return { level: -1, badge: 'INVERTED', explain: `Spread ${f(value)} < 0 — inverted (recession signal).` };
    if (value <= flatUpper) return { level: 0, badge: 'FLAT', explain: `Spread ${f(value)} in [0, ${flatUpper}] — flat.` };
    return { level: 1, badge: 'POSITIVE', explain: `Spread ${f(value)} > ${flatUpper} — positively sloped.` };
  };
}

export const classifyHySpread: Classifier = ({ value }) => {
  if (value > 5) return { level: -1, badge: 'STRESSED', explain: `HY OAS ${f(value)}% > 5 — credit stress.` };
  if (value < 3.5) return { level: 1, badge: 'TIGHT', explain: `HY OAS ${f(value)}% < 3.5 — tight spreads.` };
  return { level: 0, badge: 'NORMAL', explain: `HY OAS ${f(value)}% in [3.5, 5].` };
};

export const classifyVix: Classifier = ({ value }) => {
  if (value > 24) return { level: -1, badge: 'STRESSED', explain: `VIX ${f(value)} > 24 — elevated fear.` };
  if (value < 16) return { level: 1, badge: 'CALM', explain: `VIX ${f(value)} < 16 — calm.` };
  return { level: 0, badge: 'NORMAL', explain: `VIX ${f(value)} in [16, 24].` };
};

export const classifyNfci: Classifier = ({ value }) => {
  if (value > 0.2) return { level: -1, badge: 'TIGHT', explain: `NFCI ${f(value)} > 0.2 — tight financial conditions.` };
  if (value < -0.2) return { level: 1, badge: 'LOOSE', explain: `NFCI ${f(value)} < -0.2 — loose conditions.` };
  return { level: 0, badge: 'NEUTRAL', explain: `NFCI ${f(value)} near 0.` };
};

export const classifyCpiYoY: Classifier = ({ value }) => {
  if (value > 4) return { level: -1, badge: 'HOT', explain: `CPI ${f(value, 1)}% YoY > 4 — hot.` };
  if (value <= 2.5) return { level: 1, badge: 'ON TARGET', explain: `CPI ${f(value, 1)}% YoY ≤ 2.5 — on target.` };
  return { level: 0, badge: 'ELEVATED', explain: `CPI ${f(value, 1)}% YoY in (2.5, 4].` };
};

export const classifySahm: Classifier = ({ series }) => {
  const gap = sahmGap(series.map((p) => p.value));
  if (gap >= 0.5) return { level: -1, badge: 'TRIGGER', explain: `Sahm gap ${f(gap, 2)} ≥ 0.5 — recession trigger.` };
  if (gap >= 0.2) return { level: 0, badge: 'TICKING UP', explain: `Sahm gap ${f(gap, 2)} in [0.2, 0.5).` };
  return { level: 1, badge: 'STABLE', explain: `Sahm gap ${f(gap, 2)} < 0.2 — labor stable.` };
};

export const classifyCopperMomentum: Classifier = ({ series }) => {
  const chg = pctChangeOverMonths(series, 3);
  if (chg > 5) return { level: 1, badge: 'FIRM', explain: `Copper +${f(chg, 1)}% over 3mo — firm (growth).` };
  if (chg < -5) return { level: -1, badge: 'SOFT', explain: `Copper ${f(chg, 1)}% over 3mo — soft (growth).` };
  return { level: 0, badge: 'STEADY', explain: `Copper ${f(chg, 1)}% over 3mo — steady.` };
};

// ---- context classifiers (level used for tile accent only) ----

export function percentileClassifier(labels: [string, string, string]): Classifier {
  return ({ value, series }) => {
    const p = percentileRank(series.map((s) => s.value), value);
    if (p < 1 / 3) return { level: -1, badge: labels[0], explain: `${Math.round(p * 100)}th pct over window (bottom third).` };
    if (p < 2 / 3) return { level: 0, badge: labels[1], explain: `${Math.round(p * 100)}th pct (middle third).` };
    return { level: 1, badge: labels[2], explain: `${Math.round(p * 100)}th pct (top third).` };
  };
}

export function bandClassifier(loUpper: number, hiLower: number, labels: [string, string, string]): Classifier {
  return ({ value }) => {
    if (value < loUpper) return { level: 1, badge: labels[0], explain: `${f(value)} < ${loUpper}.` };
    if (value <= hiLower) return { level: 0, badge: labels[1], explain: `${f(value)} in [${loUpper}, ${hiLower}].` };
    return { level: -1, badge: labels[2], explain: `${f(value)} > ${hiLower}.` };
  };
}

// ---- weather aggregation ----

export interface WeatherVerdict {
  score: number; label: string; icon: string;
}

export function weatherFromVotes(votes: SignalLevel[]): WeatherVerdict {
  const score = votes.reduce<number>((a, b) => a + b, 0);
  if (score >= 4) return { score, label: 'SUNNY', icon: '☀' };
  if (score >= 2) return { score, label: 'FAIR', icon: '🌤' };
  if (score >= -1) return { score, label: 'MIXED', icon: '⛅' };
  if (score >= -3) return { score, label: 'CLOUDY', icon: '☁' };
  return { score, label: 'STORMY', icon: '⛈' };
}
