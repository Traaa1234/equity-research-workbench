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
