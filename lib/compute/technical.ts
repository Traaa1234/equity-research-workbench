import type { PricePoint } from '@/lib/providers/types';

/**
 * Simple Moving Average.
 *
 * Returns an array of the same length as `values`. For indices [0, period-2]
 * the output is NaN (not enough data to fill the window).
 */
export function sma(values: number[], period: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0 || period > n) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential Moving Average — seeded with SMA(period) at index period-1,
 * then recursive: ema[i] = price[i] * k + ema[i-1] * (1 - k) where k = 2/(period+1).
 * Returns NaN for indices [0, period-2].
 */
export function ema(values: number[], period: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0 || period > n) return out;
  // Seed: SMA of the first `period` values, placed at index period-1
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  out[period - 1] = seed / period;
  const k = 2 / (period + 1);
  for (let i = period; i < n; i++) {
    out[i] = values[i]! * k + out[i - 1]! * (1 - k);
  }
  return out;
}

/**
 * Relative Strength Index using Wilder's smoothing.
 *
 *   RSI = 100 - 100 / (1 + RS)
 *   RS  = avgGain / avgLoss
 *
 * The first `period` values are NaN (need `period` returns to seed).
 * First RSI is at index `period`. Subsequent values use Wilder's smoothing:
 *   avgGain[i] = (avgGain[i-1] * (period - 1) + gain[i]) / period
 *
 * When avgLoss is 0 (no losses in window), returns 100 (convention).
 */
export function rsi(closes: number[], period = 14): number[] {
  const n = closes.length;
  const out = new Array<number>(n).fill(NaN);
  if (n <= period) return out;

  // Sum the first `period` gains and losses (over indices 1..period)
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change > 0) gainSum += change;
    else lossSum += -change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Wilder smoothing for the rest
  for (let i = period + 1; i < n; i++) {
    const change = closes[i]! - closes[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdResult {
  line: number[];      // EMA(fast) - EMA(slow); NaN where either is NaN
  signal: number[];    // EMA(line, signal-period)
  histogram: number[]; // line - signal
}

/**
 * Moving Average Convergence Divergence.
 *
 * line       = EMA(closes, fast) - EMA(closes, slow)
 * signal     = EMA(line, signalPeriod)         — only over the non-NaN portion of line
 * histogram  = line - signal
 *
 * NaN propagates: line[i] is NaN where either EMA is NaN; signal[i] needs
 * `signalPeriod` consecutive non-NaN line values to seed.
 */
export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): MacdResult {
  const n = closes.length;
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(fastEma[i]!) && !Number.isNaN(slowEma[i]!)) {
      line[i] = fastEma[i]! - slowEma[i]!;
    }
  }
  // Compute signal as EMA of `line`, but only after `line` has values.
  // Find first non-NaN index in line.
  const firstLineIdx = line.findIndex((v) => !Number.isNaN(v));
  const signal = new Array<number>(n).fill(NaN);
  if (firstLineIdx >= 0 && n - firstLineIdx >= signalPeriod) {
    const lineSlice = line.slice(firstLineIdx);
    const sigSlice = ema(lineSlice, signalPeriod);
    for (let i = 0; i < sigSlice.length; i++) {
      signal[firstLineIdx + i] = sigSlice[i]!;
    }
  }
  const histogram = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(line[i]!) && !Number.isNaN(signal[i]!)) {
      histogram[i] = line[i]! - signal[i]!;
    }
  }
  return { line, signal, histogram };
}

export type SignalKind =
  | 'golden_cross'
  | 'death_cross'
  | 'macd_bullish'
  | 'macd_bearish'
  | 'rsi_overbought'
  | 'rsi_oversold';

export interface Signal {
  date: string;       // ISO YYYY-MM-DD
  kind: SignalKind;
  desc: string;
  value?: number;
}

export interface TechnicalResult {
  sma20: number[];
  sma50: number[];
  sma200: number[];
  rsi: number[];
  macdLine: number[];
  macdSignal: number[];
  macdHistogram: number[];
  signals: Signal[];                                     // newest first
  current: {
    price: number;
    sma20: number | null;
    sma50: number | null;
    sma200: number | null;
    rsi: number | null;
    macdHistogram: number | null;
  };
}

function lastFinite(arr: number[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (Number.isFinite(arr[i]!)) return arr[i]!;
  }
  return null;
}

/**
 * Walk indicator arrays day-by-day, emit one Signal per state transition.
 * Returns oldest-first (sorted newest-first by the caller).
 */
export function detectSignals(
  prices: PricePoint[],
  sma50Arr: number[],
  sma200Arr: number[],
  rsiArr: number[],
  macdLineArr: number[],
  macdSignalArr: number[]
): Signal[] {
  const out: Signal[] = [];
  const n = prices.length;

  for (let i = 1; i < n; i++) {
    const date = prices[i]!.date;

    // Golden / death cross (50 vs 200 SMA)
    const s50p = sma50Arr[i - 1]!, s50c = sma50Arr[i]!;
    const s200p = sma200Arr[i - 1]!, s200c = sma200Arr[i]!;
    if (Number.isFinite(s50p) && Number.isFinite(s50c) && Number.isFinite(s200p) && Number.isFinite(s200c)) {
      if (s50p <= s200p && s50c > s200c) {
        out.push({ date, kind: 'golden_cross', desc: 'Golden cross (50d SMA crossed above 200d SMA)' });
      } else if (s50p >= s200p && s50c < s200c) {
        out.push({ date, kind: 'death_cross', desc: 'Death cross (50d SMA crossed below 200d SMA)' });
      }
    }

    // MACD line vs signal line crossover
    const mlP = macdLineArr[i - 1]!, mlC = macdLineArr[i]!;
    const msP = macdSignalArr[i - 1]!, msC = macdSignalArr[i]!;
    if (Number.isFinite(mlP) && Number.isFinite(mlC) && Number.isFinite(msP) && Number.isFinite(msC)) {
      if (mlP <= msP && mlC > msC) {
        out.push({ date, kind: 'macd_bullish', desc: 'MACD bullish crossover (line crossed above signal)' });
      } else if (mlP >= msP && mlC < msC) {
        out.push({ date, kind: 'macd_bearish', desc: 'MACD bearish crossover (line crossed below signal)' });
      }
    }

    // RSI overbought / oversold — transition only (avoid spam while RSI stays above/below)
    // Treat NaN→finite as a state entry (so the seed boundary counts as a transition).
    const rP = rsiArr[i - 1]!, rC = rsiArr[i]!;
    if (Number.isFinite(rC)) {
      const prevAboveOB = Number.isFinite(rP) && rP > 70;
      const prevBelowOS = Number.isFinite(rP) && rP < 30;
      if (!prevAboveOB && rC > 70) {
        out.push({ date, kind: 'rsi_overbought', desc: `RSI overbought (${rC.toFixed(1)})`, value: rC });
      } else if (!prevBelowOS && rC < 30) {
        out.push({ date, kind: 'rsi_oversold', desc: `RSI oversold (${rC.toFixed(1)})`, value: rC });
      }
    }
  }
  return out;
}

/**
 * Compute all indicators + signals for a price series. Pure function.
 * `prices` MUST be sorted ascending by date.
 */
export function computeTechnical(prices: PricePoint[]): TechnicalResult {
  const closes = prices.map((p) => p.close);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const rsiArr = rsi(closes, 14);
  const macdR = macd(closes, 12, 26, 9);

  const signalsAsc = detectSignals(prices, sma50, sma200, rsiArr, macdR.line, macdR.signal);
  const signals = [...signalsAsc].reverse(); // newest first

  const lastPrice = prices.length > 0 ? prices[prices.length - 1]!.close : NaN;
  return {
    sma20, sma50, sma200,
    rsi: rsiArr,
    macdLine: macdR.line,
    macdSignal: macdR.signal,
    macdHistogram: macdR.histogram,
    signals,
    current: {
      price: lastPrice,
      sma20: lastFinite(sma20),
      sma50: lastFinite(sma50),
      sma200: lastFinite(sma200),
      rsi: lastFinite(rsiArr),
      macdHistogram: lastFinite(macdR.histogram)
    }
  };
}
