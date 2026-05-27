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
