# Slice 5A: Technical Analysis Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/stock/[ticker]/technical` tab showing price chart with SMA overlays, RSI and MACD panels, and a list of detected crossover signals.

**Architecture:** Pure server-side compute over the existing `prices` table using new functions in `lib/compute/technical.ts`. Recharts on the client renders 3 panels. No schema, no APIs, no recurring cost.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Vitest, Recharts (already installed), Tailwind, shadcn `Tabs`.

**Spec:** `docs/superpowers/specs/2026-05-27-slice-5a-technical-analysis-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `lib/compute/technical.ts` | Create | `sma`, `ema`, `rsi`, `macd`, `detectSignals`, `computeTechnical` |
| `tests/compute/technical.test.ts` | Create | Unit + integration tests for all the above |
| `app/(app)/stock/[ticker]/technical/page.tsx` | Create | Server component — fetch prices, compute, render view |
| `app/(app)/stock/[ticker]/technical/_components/technical-view.tsx` | Create | Client wrapper — header strip + 3 panels + signals list |
| `app/(app)/stock/[ticker]/technical/_components/price-chart-with-smas.tsx` | Create | Recharts LineChart with 4 lines + signal markers |
| `app/(app)/stock/[ticker]/technical/_components/rsi-panel.tsx` | Create | Recharts LineChart + ReferenceLine at 30 and 70 |
| `app/(app)/stock/[ticker]/technical/_components/macd-panel.tsx` | Create | Recharts ComposedChart — histogram Bar + line + signal |
| `app/(app)/stock/[ticker]/technical/_components/signals-list.tsx` | Create | Simple `<ul>` of signal events |
| `app/(app)/stock/[ticker]/page.tsx` | Modify | Add "Technical" `<TabsTrigger>` to nav |
| `app/(app)/stock/[ticker]/financials/page.tsx` | Modify | Same |
| `app/(app)/stock/[ticker]/filings/page.tsx` | Modify | Same |
| `app/(app)/stock/[ticker]/ask/page.tsx` | Modify | Same |

Five tab-nav modifications including the new `technical/page.tsx` which also needs the nav block.

---

## Task 1: Primitive indicators — `sma`, `ema`

**Files:**
- Create: `lib/compute/technical.ts`
- Create: `tests/compute/technical.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `tests/compute/technical.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sma, ema } from '@/lib/compute/technical';

describe('sma', () => {
  it('returns rolling mean with NaN padding before period', () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(out[2]).toBeCloseTo(2);
    expect(out[3]).toBeCloseTo(3);
    expect(out[4]).toBeCloseTo(4);
  });

  it('returns all-NaN when series shorter than period', () => {
    const out = sma([1, 2], 5);
    expect(out).toHaveLength(2);
    expect(out.every((v) => Number.isNaN(v))).toBe(true);
  });

  it('handles period=1 as identity', () => {
    expect(sma([1, 2, 3], 1)).toEqual([1, 2, 3]);
  });
});

describe('ema', () => {
  it('seeds at index period-1 with SMA, then recurses', () => {
    // Period=3, k = 2/(3+1) = 0.5
    // Seed at index 2 = mean(1,2,3) = 2
    // ema[3] = 4*0.5 + 2*0.5 = 3
    // ema[4] = 5*0.5 + 3*0.5 = 4
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(out[2]).toBeCloseTo(2);
    expect(out[3]).toBeCloseTo(3);
    expect(out[4]).toBeCloseTo(4);
  });

  it('returns all-NaN when series shorter than period', () => {
    const out = ema([1, 2], 5);
    expect(out.every((v) => Number.isNaN(v))).toBe(true);
  });
});
```

- [ ] **Step 1.2: Run the test — confirm it fails**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test -- tests/compute/technical.test.ts
```

Expected: FAIL with `Cannot find module '@/lib/compute/technical'`.

- [ ] **Step 1.3: Implement `sma` and `ema`**

Create `lib/compute/technical.ts`:

```ts
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
```

- [ ] **Step 1.4: Run the test — confirm it passes**

```bash
pnpm test -- tests/compute/technical.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add lib/compute/technical.ts tests/compute/technical.test.ts
git commit -m "feat(compute): sma + ema for slice 5a

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: RSI

**Files:**
- Modify: `lib/compute/technical.ts` (add `rsi`)
- Modify: `tests/compute/technical.test.ts` (add `rsi` tests)

- [ ] **Step 2.1: Write the failing test**

Append to `tests/compute/technical.test.ts`:

```ts
import { rsi } from '@/lib/compute/technical';

describe('rsi (Wilder smoothing)', () => {
  // Wilder 1978: 14 closes (period=14). First RSI value is at index 14.
  // Source: Welles Wilder, "New Concepts in Technical Trading Systems" (1978), pp. 65-66
  // Closes: 44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
  //         45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00
  // First two RSI values (positions 14 and 15) are ~70.46 and ~66.50
  it('matches Wilder 1978 reference fixture', () => {
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
      45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00
    ];
    const out = rsi(closes, 14);
    expect(out).toHaveLength(closes.length);
    // First 14 values are NaN (need 14 returns to seed)
    for (let i = 0; i < 14; i++) {
      expect(Number.isNaN(out[i])).toBe(true);
    }
    // Index 14: first computed RSI
    expect(out[14]).toBeCloseTo(70.46, 1);
    expect(out[15]).toBeCloseTo(66.50, 1);
  });

  it('returns all-NaN when series too short', () => {
    const out = rsi([1, 2, 3], 14);
    expect(out.every((v) => Number.isNaN(v))).toBe(true);
  });

  it('handles flat series (no gains, no losses)', () => {
    // RSI is undefined when avgLoss === 0. Implementation choice: return 100
    // (matches Wilder + most charting platforms).
    const out = rsi([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10], 14);
    expect(out[14]).toBe(100);
  });
});
```

- [ ] **Step 2.2: Run the test — confirm it fails**

```bash
pnpm test -- tests/compute/technical.test.ts
```

Expected: 3 new tests fail with import error or undefined `rsi`.

- [ ] **Step 2.3: Implement `rsi`**

Append to `lib/compute/technical.ts`:

```ts
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
```

- [ ] **Step 2.4: Run the test — confirm it passes**

```bash
pnpm test -- tests/compute/technical.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add lib/compute/technical.ts tests/compute/technical.test.ts
git commit -m "feat(compute): rsi with Wilder smoothing for slice 5a

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: MACD

**Files:**
- Modify: `lib/compute/technical.ts` (add `macd`)
- Modify: `tests/compute/technical.test.ts` (add `macd` tests)

- [ ] **Step 3.1: Write the failing test**

Append to `tests/compute/technical.test.ts`:

```ts
import { macd } from '@/lib/compute/technical';

describe('macd', () => {
  it('returns three parallel arrays of equal length', () => {
    // Need at least fast(12) + slow(26) - 1 + signal(9) - 1 = 35 datapoints
    // to get the first non-NaN signal/histogram values.
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i); // monotonically increasing
    const r = macd(closes, 12, 26, 9);
    expect(r.line).toHaveLength(40);
    expect(r.signal).toHaveLength(40);
    expect(r.histogram).toHaveLength(40);
  });

  it('produces NaN line[] before slow EMA seeds (index < slow-1)', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
    const r = macd(closes, 12, 26, 9);
    for (let i = 0; i < 25; i++) {
      expect(Number.isNaN(r.line[i])).toBe(true);
    }
    // line is defined from index 25 onward (slow-1 = 25)
    expect(Number.isNaN(r.line[25])).toBe(false);
  });

  it('histogram equals line minus signal where both defined', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const r = macd(closes, 12, 26, 9);
    for (let i = 33; i < 50; i++) {
      if (!Number.isNaN(r.line[i]!) && !Number.isNaN(r.signal[i]!)) {
        expect(r.histogram[i]).toBeCloseTo(r.line[i]! - r.signal[i]!, 5);
      }
    }
  });

  it('returns all-NaN when series too short', () => {
    const r = macd([1, 2, 3, 4, 5], 12, 26, 9);
    expect(r.line.every((v) => Number.isNaN(v))).toBe(true);
    expect(r.signal.every((v) => Number.isNaN(v))).toBe(true);
    expect(r.histogram.every((v) => Number.isNaN(v))).toBe(true);
  });
});
```

- [ ] **Step 3.2: Run the test — confirm it fails**

```bash
pnpm test -- tests/compute/technical.test.ts
```

Expected: 4 new tests fail (undefined `macd`).

- [ ] **Step 3.3: Implement `macd`**

Append to `lib/compute/technical.ts`:

```ts
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
```

- [ ] **Step 3.4: Run the test — confirm it passes**

```bash
pnpm test -- tests/compute/technical.test.ts
```

Expected: all 12 tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add lib/compute/technical.ts tests/compute/technical.test.ts
git commit -m "feat(compute): macd for slice 5a

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `detectSignals` + `computeTechnical` wrapper

**Files:**
- Modify: `lib/compute/technical.ts`
- Modify: `tests/compute/technical.test.ts`

- [ ] **Step 4.1: Write the failing test**

Append to `tests/compute/technical.test.ts`:

```ts
import { detectSignals, computeTechnical } from '@/lib/compute/technical';
import type { PricePoint } from '@/lib/providers/types';

function fakePrices(closes: number[]): PricePoint[] {
  // Generate dates 2025-01-01 onward (calendar days, not trading days — fine for tests)
  return closes.map((close, i) => {
    const d = new Date(2025, 0, 1 + i);
    const date = d.toISOString().slice(0, 10);
    return { date, open: close, high: close, low: close, close, adjClose: close, volume: 1000 };
  });
}

describe('detectSignals', () => {
  it('detects golden cross when 50-SMA crosses above 200-SMA', () => {
    // Construct a series where SMAs definitely cross at a known index.
    // Easier than computing by hand: rely on computeTechnical's own arrays.
    // Down for 250 days, then up for 100 — guarantees the 50-SMA dives below 200,
    // then the 50-SMA recovers and crosses back above.
    const closes = [
      ...Array.from({ length: 250 }, (_, i) => 200 - i * 0.5),  // 200 → 75
      ...Array.from({ length: 100 }, (_, i) => 75 + i * 2)       // 75 → 273
    ];
    const prices = fakePrices(closes);
    const computed = computeTechnical(prices);
    const goldens = computed.signals.filter((s) => s.kind === 'golden_cross');
    expect(goldens.length).toBeGreaterThanOrEqual(1);
  });

  it('detects rsi_overbought as a transition only, not while staying above 70', () => {
    // Strongly trending up to push RSI > 70 and keep it there
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i * 2);
    const prices = fakePrices(closes);
    const computed = computeTechnical(prices);
    const overboughts = computed.signals.filter((s) => s.kind === 'rsi_overbought');
    // Should be exactly ONE event (the transition), not many
    expect(overboughts.length).toBe(1);
  });

  it('returns signals sorted by date descending', () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 10) * 50);
    const prices = fakePrices(closes);
    const computed = computeTechnical(prices);
    for (let i = 1; i < computed.signals.length; i++) {
      expect(computed.signals[i - 1]!.date >= computed.signals[i]!.date).toBe(true);
    }
  });
});

describe('computeTechnical (integration)', () => {
  it('handles short series gracefully (no NaN crash)', () => {
    const prices = fakePrices([100, 101, 102, 99, 98]);
    const r = computeTechnical(prices);
    expect(r.sma20).toHaveLength(5);
    expect(r.current.sma20).toBeNull();
    expect(r.current.sma50).toBeNull();
    expect(r.current.sma200).toBeNull();
    expect(r.current.rsi).toBeNull();
    expect(r.current.price).toBe(98);
    expect(r.signals).toEqual([]);
  });

  it('produces current readings for a full-1Y series', () => {
    // 251 trading days at constant 100 then trending up — guarantees SMAs and RSI populate
    const closes = [
      ...Array.from({ length: 200 }, () => 100),
      ...Array.from({ length: 51 }, (_, i) => 100 + i)
    ];
    const prices = fakePrices(closes);
    const r = computeTechnical(prices);
    expect(r.current.sma20).not.toBeNull();
    expect(r.current.sma50).not.toBeNull();
    expect(r.current.sma200).not.toBeNull();
    expect(r.current.rsi).not.toBeNull();
    expect(r.current.macdHistogram).not.toBeNull();
    expect(r.current.price).toBe(150);
  });
});
```

- [ ] **Step 4.2: Run the test — confirm it fails**

```bash
pnpm test -- tests/compute/technical.test.ts
```

Expected: 5 new tests fail (undefined `detectSignals`, `computeTechnical`).

- [ ] **Step 4.3: Implement `detectSignals` and `computeTechnical`**

Append to `lib/compute/technical.ts`:

```ts
import type { PricePoint } from '@/lib/providers/types';

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
    const rP = rsiArr[i - 1]!, rC = rsiArr[i]!;
    if (Number.isFinite(rP) && Number.isFinite(rC)) {
      if (rP <= 70 && rC > 70) {
        out.push({ date, kind: 'rsi_overbought', desc: `RSI overbought (${rC.toFixed(1)})`, value: rC });
      } else if (rP >= 30 && rC < 30) {
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
```

- [ ] **Step 4.4: Run the test — confirm it passes**

```bash
pnpm test -- tests/compute/technical.test.ts
```

Expected: all 17 tests pass.

- [ ] **Step 4.5: Commit**

```bash
git add lib/compute/technical.ts tests/compute/technical.test.ts
git commit -m "feat(compute): detectSignals + computeTechnical wrapper for slice 5a

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Server route — `/stock/[ticker]/technical/page.tsx`

**Files:**
- Create: `app/(app)/stock/[ticker]/technical/page.tsx`
- Create: `app/(app)/stock/[ticker]/technical/_components/technical-view.tsx` (stub for now)

- [ ] **Step 5.1: Create a placeholder `technical-view.tsx` so the page compiles**

Create `app/(app)/stock/[ticker]/technical/_components/technical-view.tsx`:

```tsx
'use client';

import type { TechnicalResult } from '@/lib/compute/technical';

interface Props {
  ticker: string;
  prices: { date: string; close: number }[];
  result: TechnicalResult;
}

export function TechnicalView({ ticker, prices, result }: Props) {
  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        {ticker} · {prices.length} datapoints · {result.signals.length} signals · price {result.current.price}
      </div>
      <pre className="text-xs font-mono text-muted-foreground overflow-auto max-h-64 rounded border p-2">
        {JSON.stringify({ current: result.current, signals: result.signals.slice(0, 5) }, null, 2)}
      </pre>
    </div>
  );
}
```

This stub renders just enough to verify the data path works. Real chart components come in later tasks.

- [ ] **Step 5.2: Create the server page**

Create `app/(app)/stock/[ticker]/technical/page.tsx`:

```tsx
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { PricesService } from '@/lib/services/prices';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';
import { computeTechnical } from '@/lib/compute/technical';
import { TechnicalView } from './_components/technical-view';

interface PageProps {
  params: { ticker: string };
}

export default async function TechnicalPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  const env = loadServerEnv();
  const yf = new YFinanceProvider();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const pricesSvc = new PricesService({
    db: getServiceDb(),
    primary: yf,
    fallback: fd,
    redis: getRedisCache()
  });

  const prices = await pricesSvc.get(ticker, '1Y');
  const result = computeTechnical(prices);

  return (
    <div className="container py-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{ticker}</h1>
        <Tabs value="technical" className="hidden sm:block">
          <TabsList>
            <TabsTrigger value="overview" asChild>
              <Link href={`/stock/${ticker}`}>Overview</Link>
            </TabsTrigger>
            <TabsTrigger value="financials" asChild>
              <Link href={`/stock/${ticker}/financials`}>Financials</Link>
            </TabsTrigger>
            <TabsTrigger value="technical" asChild>
              <Link href={`/stock/${ticker}/technical`}>Technical</Link>
            </TabsTrigger>
            <TabsTrigger value="filings" asChild>
              <Link href={`/stock/${ticker}/filings`}>Filings</Link>
            </TabsTrigger>
            <TabsTrigger value="ask" asChild>
              <Link href={`/stock/${ticker}/ask`}>Ask</Link>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <Card>
        <CardHeader><CardTitle>Technical Analysis</CardTitle></CardHeader>
        <CardContent>
          <TechnicalView
            ticker={ticker}
            prices={prices.map(({ date, close }) => ({ date, close }))}
            result={result}
          />
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 5.3: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 5.4: Manual smoke (dev server)**

Run `pnpm dev` in another terminal (skip if already running). Visit http://localhost:3000/stock/AAPL/technical.

Expected: page renders, shows ticker label, summary line (~251 datapoints, N signals, price), and a JSON dump of current readings + first 5 signals. No 500 errors in console.

(This is a manual step — no automated assertion. The agent should run typecheck only.)

- [ ] **Step 5.5: Commit**

```bash
git add "app/(app)/stock/[ticker]/technical/page.tsx" \
        "app/(app)/stock/[ticker]/technical/_components/technical-view.tsx"
git commit -m "feat(technical): server route + stub view for slice 5a

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Price chart with SMAs

**Files:**
- Create: `app/(app)/stock/[ticker]/technical/_components/price-chart-with-smas.tsx`

- [ ] **Step 6.1: Create the chart component**

Create `app/(app)/stock/[ticker]/technical/_components/price-chart-with-smas.tsx`:

```tsx
'use client';

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ReferenceDot
} from 'recharts';
import type { Signal } from '@/lib/compute/technical';

interface DataPoint {
  date: string;
  close: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
}

interface Props {
  data: DataPoint[];
  signals: Signal[];
}

// Indicator line colors — chosen to be distinguishable in default + dark themes
const COLORS = {
  close: '#3b82f6',   // blue-500
  sma20: '#22c55e',   // green-500
  sma50: '#eab308',   // yellow-500
  sma200: '#ef4444'   // red-500
};

// Format ISO date as MM-DD for the X axis (keeps labels short)
const formatTick = (iso: string) => iso.slice(5);

export function PriceChartWithSmas({ data, signals }: Props) {
  // Lookup close price by date so signal markers sit on the price line
  const closeByDate = new Map(data.map((d) => [d.date, d.close]));

  // Only show signal kinds that belong on the price chart (the SMA crosses)
  const priceChartSignals = signals.filter(
    (s) => s.kind === 'golden_cross' || s.kind === 'death_cross'
  );

  return (
    <div className="h-80 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <XAxis dataKey="date" tickFormatter={formatTick} minTickGap={40} />
          <YAxis domain={['auto', 'auto']} width={60} tickFormatter={(v) => v.toFixed(0)} />
          <Tooltip
            labelFormatter={(label) => `Date: ${label}`}
            formatter={(value: number | null, name) => [value == null ? '—' : value.toFixed(2), name]}
          />
          <Legend />
          <Line type="monotone" dataKey="close" stroke={COLORS.close} dot={false} name="Close" strokeWidth={1.5} />
          <Line type="monotone" dataKey="sma20" stroke={COLORS.sma20} dot={false} name="SMA 20" strokeWidth={1} />
          <Line type="monotone" dataKey="sma50" stroke={COLORS.sma50} dot={false} name="SMA 50" strokeWidth={1} />
          <Line type="monotone" dataKey="sma200" stroke={COLORS.sma200} dot={false} name="SMA 200" strokeWidth={1} />
          {priceChartSignals.map((s) => {
            const y = closeByDate.get(s.date);
            if (y == null) return null;
            const fill = s.kind === 'golden_cross' ? '#22c55e' : '#ef4444';
            return (
              <ReferenceDot
                key={`${s.kind}-${s.date}`}
                x={s.date}
                y={y}
                r={5}
                fill={fill}
                stroke="white"
                strokeWidth={1}
                ifOverflow="extendDomain"
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 6.2: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 6.3: Commit**

```bash
git add "app/(app)/stock/[ticker]/technical/_components/price-chart-with-smas.tsx"
git commit -m "feat(technical): price chart with SMA overlays + cross markers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: RSI + MACD panels

**Files:**
- Create: `app/(app)/stock/[ticker]/technical/_components/rsi-panel.tsx`
- Create: `app/(app)/stock/[ticker]/technical/_components/macd-panel.tsx`

- [ ] **Step 7.1: Create the RSI panel**

Create `app/(app)/stock/[ticker]/technical/_components/rsi-panel.tsx`:

```tsx
'use client';

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine
} from 'recharts';

interface DataPoint {
  date: string;
  rsi: number | null;
}

const formatTick = (iso: string) => iso.slice(5);

export function RsiPanel({ data }: { data: DataPoint[] }) {
  return (
    <div className="h-32 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <XAxis dataKey="date" tickFormatter={formatTick} minTickGap={40} />
          <YAxis domain={[0, 100]} ticks={[0, 30, 50, 70, 100]} width={40} />
          <Tooltip
            labelFormatter={(label) => `Date: ${label}`}
            formatter={(value: number | null) => [value == null ? '—' : value.toFixed(1), 'RSI']}
          />
          <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="3 3" />
          <ReferenceLine y={30} stroke="#22c55e" strokeDasharray="3 3" />
          <Line type="monotone" dataKey="rsi" stroke="#8b5cf6" dot={false} strokeWidth={1.25} name="RSI" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 7.2: Create the MACD panel**

Create `app/(app)/stock/[ticker]/technical/_components/macd-panel.tsx`:

```tsx
'use client';

import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ReferenceLine,
  Cell
} from 'recharts';

interface DataPoint {
  date: string;
  macdLine: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
}

const formatTick = (iso: string) => iso.slice(5);

export function MacdPanel({ data }: { data: DataPoint[] }) {
  return (
    <div className="h-32 w-full">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <XAxis dataKey="date" tickFormatter={formatTick} minTickGap={40} />
          <YAxis width={50} tickFormatter={(v) => v.toFixed(1)} />
          <Tooltip
            labelFormatter={(label) => `Date: ${label}`}
            formatter={(value: number | null, name) => [value == null ? '—' : value.toFixed(3), name]}
          />
          <Legend />
          <ReferenceLine y={0} stroke="#71717a" />
          <Bar dataKey="macdHistogram" name="Histogram">
            {data.map((d, i) => (
              <Cell
                key={`hist-${i}`}
                fill={d.macdHistogram == null ? 'transparent' : d.macdHistogram >= 0 ? '#22c55e' : '#ef4444'}
              />
            ))}
          </Bar>
          <Line type="monotone" dataKey="macdLine" stroke="#3b82f6" dot={false} name="MACD" strokeWidth={1.25} />
          <Line type="monotone" dataKey="macdSignal" stroke="#eab308" dot={false} name="Signal" strokeWidth={1} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 7.3: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 7.4: Commit**

```bash
git add "app/(app)/stock/[ticker]/technical/_components/rsi-panel.tsx" \
        "app/(app)/stock/[ticker]/technical/_components/macd-panel.tsx"
git commit -m "feat(technical): RSI + MACD panel components

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Signals list + final `TechnicalView` wiring + tab nav

**Files:**
- Create: `app/(app)/stock/[ticker]/technical/_components/signals-list.tsx`
- Modify: `app/(app)/stock/[ticker]/technical/_components/technical-view.tsx` (replace stub)
- Modify: `app/(app)/stock/[ticker]/page.tsx`
- Modify: `app/(app)/stock/[ticker]/financials/page.tsx`
- Modify: `app/(app)/stock/[ticker]/filings/page.tsx`
- Modify: `app/(app)/stock/[ticker]/ask/page.tsx`

- [ ] **Step 8.1: Create the signals list**

Create `app/(app)/stock/[ticker]/technical/_components/signals-list.tsx`:

```tsx
import type { Signal } from '@/lib/compute/technical';

const KIND_BADGE: Record<Signal['kind'], { label: string; color: string }> = {
  golden_cross:   { label: 'Golden cross',   color: 'text-green-600' },
  death_cross:    { label: 'Death cross',    color: 'text-red-600' },
  macd_bullish:   { label: 'MACD bullish',   color: 'text-green-600' },
  macd_bearish:   { label: 'MACD bearish',   color: 'text-red-600' },
  rsi_overbought: { label: 'RSI overbought', color: 'text-red-600' },
  rsi_oversold:   { label: 'RSI oversold',   color: 'text-green-600' }
};

export function SignalsList({ signals }: { signals: Signal[] }) {
  if (signals.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No technical signals detected in the last year.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {signals.map((s, i) => {
        const meta = KIND_BADGE[s.kind];
        return (
          <li key={`${s.date}-${s.kind}-${i}`} className="flex items-baseline gap-3 text-sm">
            <span className="font-mono text-xs text-muted-foreground tabular-nums">{s.date}</span>
            <span className={`font-medium ${meta.color}`}>{meta.label}</span>
            <span className="text-muted-foreground">{s.desc}</span>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 8.2: Replace the stub `TechnicalView` with the real composition**

Overwrite `app/(app)/stock/[ticker]/technical/_components/technical-view.tsx`:

```tsx
'use client';

import type { TechnicalResult } from '@/lib/compute/technical';
import { PriceChartWithSmas } from './price-chart-with-smas';
import { RsiPanel } from './rsi-panel';
import { MacdPanel } from './macd-panel';
import { SignalsList } from './signals-list';

interface Props {
  ticker: string;
  prices: { date: string; close: number }[];
  result: TechnicalResult;
}

function fmt(v: number | null, digits = 2): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

export function TechnicalView({ ticker, prices, result }: Props) {
  // Build the per-date row that all three charts share. Convert NaN → null so
  // Recharts renders gaps cleanly instead of dropping the segment.
  const rows = prices.map((p, i) => {
    const toNull = (v: number) => (Number.isFinite(v) ? v : null);
    return {
      date: p.date,
      close: p.close,
      sma20: toNull(result.sma20[i]!),
      sma50: toNull(result.sma50[i]!),
      sma200: toNull(result.sma200[i]!),
      rsi: toNull(result.rsi[i]!),
      macdLine: toNull(result.macdLine[i]!),
      macdSignal: toNull(result.macdSignal[i]!),
      macdHistogram: toNull(result.macdHistogram[i]!)
    };
  });

  const { current } = result;

  return (
    <div className="space-y-6">
      {/* Header strip with current readings */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm border-b pb-3">
        <div><span className="text-muted-foreground">Price</span> <span className="font-mono tabular-nums">{fmt(current.price)}</span></div>
        <div><span className="text-muted-foreground">SMA20</span> <span className="font-mono tabular-nums">{fmt(current.sma20)}</span></div>
        <div><span className="text-muted-foreground">SMA50</span> <span className="font-mono tabular-nums">{fmt(current.sma50)}</span></div>
        <div><span className="text-muted-foreground">SMA200</span> <span className="font-mono tabular-nums">{fmt(current.sma200)}</span></div>
        <div><span className="text-muted-foreground">RSI</span> <span className="font-mono tabular-nums">{fmt(current.rsi, 1)}</span></div>
        <div><span className="text-muted-foreground">MACD hist</span> <span className="font-mono tabular-nums">{fmt(current.macdHistogram, 3)}</span></div>
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2">Price + SMAs</h3>
        <PriceChartWithSmas data={rows} signals={result.signals} />
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2">RSI (14)</h3>
        <RsiPanel data={rows} />
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2">MACD (12, 26, 9)</h3>
        <MacdPanel data={rows} />
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2">Recent signals</h3>
        <SignalsList signals={result.signals} />
      </div>
    </div>
  );
}
```

- [ ] **Step 8.3: Add "Technical" tab to `app/(app)/stock/[ticker]/page.tsx`**

Find the existing `<TabsList>` block (around line 85-99 — the one between Overview and Financials → Filings → Ask). Insert a new `<TabsTrigger>` after Financials and before Filings:

```tsx
<TabsTrigger value="technical" asChild>
  <Link href={`/stock/${ticker}/technical`}>Technical</Link>
</TabsTrigger>
```

Final `<TabsList>` for that file should look like:

```tsx
<TabsList>
  <TabsTrigger value="overview" asChild>
    <Link href={`/stock/${ticker}`}>Overview</Link>
  </TabsTrigger>
  <TabsTrigger value="financials" asChild>
    <Link href={`/stock/${ticker}/financials`}>Financials</Link>
  </TabsTrigger>
  <TabsTrigger value="technical" asChild>
    <Link href={`/stock/${ticker}/technical`}>Technical</Link>
  </TabsTrigger>
  <TabsTrigger value="filings" asChild>
    <Link href={`/stock/${ticker}/filings`}>Filings</Link>
  </TabsTrigger>
  <TabsTrigger value="ask" asChild>
    <Link href={`/stock/${ticker}/ask`}>Ask</Link>
  </TabsTrigger>
</TabsList>
```

- [ ] **Step 8.4: Add the same "Technical" `<TabsTrigger>` to the other 3 page.tsx files**

Open each of these files and insert the same `<TabsTrigger value="technical">` line between the Financials and Filings triggers, matching the structure above:

- `app/(app)/stock/[ticker]/financials/page.tsx`
- `app/(app)/stock/[ticker]/filings/page.tsx`
- `app/(app)/stock/[ticker]/ask/page.tsx`

(The exact location may be slightly different across files — search for `Filings</Link>` inside a `<TabsTrigger>` and insert the Technical trigger before that block.)

- [ ] **Step 8.5: Typecheck + lint + tests**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all clean.

- [ ] **Step 8.6: Manual smoke (dev server)**

Visit http://localhost:3000/stock/AAPL/technical. Expect:
- Header strip showing current Price / SMA20 / SMA50 / SMA200 / RSI / MACD hist values (or `—` for any that haven't seeded yet — AAPL's 251 days is enough to seed all)
- Price + SMA chart with 4 lines, possibly with green/red dots at cross dates
- RSI panel showing the line oscillating between 30 and 70 reference lines
- MACD panel showing histogram bars (green positive / red negative) + MACD + signal lines
- "Recent signals" list with at least one entry (or "No technical signals detected…" if AAPL happens to have a flat year)
- Click between tabs — Overview, Financials, Technical, Filings, Ask all visible and navigable

(Manual visual check — no automated assertion.)

- [ ] **Step 8.7: Commit**

```bash
git add "app/(app)/stock/[ticker]/technical/_components/signals-list.tsx" \
        "app/(app)/stock/[ticker]/technical/_components/technical-view.tsx" \
        "app/(app)/stock/[ticker]/page.tsx" \
        "app/(app)/stock/[ticker]/financials/page.tsx" \
        "app/(app)/stock/[ticker]/filings/page.tsx" \
        "app/(app)/stock/[ticker]/ask/page.tsx"
git commit -m "feat(technical): SignalsList + full TechnicalView + Technical tab in nav

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Push + CI + Vercel deploy + browser smoke

**Files:** None modified; this is the rollout task.

- [ ] **Step 9.1: Push to GitHub**

```bash
git push origin master
```

- [ ] **Step 9.2: Verify CI run kicks off**

```bash
gh run list --limit 1 --json status,databaseId,headSha
```

Expected: a record with `status: queued` or `in_progress` and `headSha` matching HEAD.

- [ ] **Step 9.3: Watch CI to completion**

```bash
gh run watch <run-id> --exit-status
```

Substitute `<run-id>` from Step 9.2. Expected: exits 0 with all jobs green.

- [ ] **Step 9.4: Browser smoke on production**

Vercel auto-deploys on push. Wait ~30-60s, then in your browser:

1. https://equity-research-workbench-mauve.vercel.app/stock/AAPL/technical
2. https://equity-research-workbench-mauve.vercel.app/stock/NVDA/technical
3. https://equity-research-workbench-mauve.vercel.app/stock/MSFT/technical
4. https://equity-research-workbench-mauve.vercel.app/stock/GOOGL/technical
5. https://equity-research-workbench-mauve.vercel.app/stock/JD/technical

For each, expect: header strip values populated (no `—` for SMA200 if ticker has full 1Y of prices), 3 panels render, signals list shows at least one event for each, no console errors.

Also click the "Technical" tab from Overview / Financials / Filings / Ask on at least one ticker to verify nav works in both directions.

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `lib/compute/technical.ts` with sma/ema | T1 |
| RSI with Wilder smoothing | T2 |
| MACD (12/26/9) | T3 |
| `detectSignals` for all 6 signal kinds | T4 |
| `computeTechnical` wrapper returning `TechnicalResult` | T4 |
| Unit tests for each compute fn | T1–T4 |
| Integration test against simulated 1Y series | T4 (the "produces current readings" test) |
| `/stock/[ticker]/technical` server route | T5 |
| `<TechnicalView>` client wrapper | T5 (stub), T8 (real) |
| `<PriceChartWithSmas>` with signal markers | T6 |
| `<RsiPanel>` with 30/70 ReferenceLines | T7 |
| `<MacdPanel>` ComposedChart (bar + 2 lines) | T7 |
| `<SignalsList>` | T8 |
| Header strip with current readings | T8 |
| Tab nav updated in 4 existing pages + new page | T5 (new page nav), T8 (4 existing pages) |
| Handle missing readings (null) gracefully | T4 (`current.sma200` = null when undersized), T8 (`fmt(...)` shows `—`) |
| Push, CI, browser smoke | T9 |

All spec requirements have a task. No gaps.
