# Slice 5A — Technical Analysis Tab

**Date:** 2026-05-27
**Status:** Design approved, plan pending
**Scope:** Slice 5A only; Slice 5B (sentiment analysis) is a separate follow-up.

## Goal

Add a `/stock/[ticker]/technical` tab that renders a price chart with moving-average overlays, RSI and MACD panels, and a list of recently-detected technical signals (golden/death crosses, MACD crossovers, RSI overbought/oversold).

Pure compute over the existing `prices` table. No new data sources, no schema changes, no recurring cost, no scheduled jobs.

## Non-Goals

- Range selector (1M/3M/6M) — only 1Y of OHLCV stored per ticker; defer until prices table extended
- Candlestick chart — line chart for v1; OHLC bars can come later
- Indicator parameter customization — fixed periods (20/50/200 for SMA, 14 for RSI, 12-26-9 for MACD)
- Backtester / signal performance tracking
- Alerts / notifications on new signals (would need a cron + channel — deferred)
- Sentiment data (Slice 5B)
- Volume indicators (Bollinger Bands, VWAP, OBV) — would be an "Extended pack" follow-up

## Architecture

Three layers, all reusing existing project conventions:

```
┌──────────────────────────────────────────────────────────────────┐
│  Next.js server component at /stock/[ticker]/technical/page.tsx   │
│    1. PricesService.get(ticker, '1Y')   ← existing service        │
│    2. computeTechnical(prices)          ← NEW pure compute        │
│    3. Render <TechnicalView ... />      ← NEW client component    │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  lib/compute/technical.ts                                        │
│    sma(values, period) → number[]                                │
│    ema(values, period) → number[]                                │
│    rsi(closes, period=14) → number[]                             │
│    macd(closes, fast=12, slow=26, signal=9)                      │
│       → { line: number[], signal: number[], histogram: number[] }│
│    detectSignals(prices, computed) → Signal[]                    │
│    computeTechnical(prices) → TechnicalResult                    │
│                                                                  │
│  All pure functions. Returns NaN for indices before the period   │
│  has enough data. Index of every returned array matches prices[i].│
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  app/(app)/stock/[ticker]/technical/_components/                 │
│    technical-view.tsx          (client wrapper holding 3 charts) │
│    price-chart-with-smas.tsx   (Recharts LineChart + markers)    │
│    rsi-panel.tsx               (Recharts LineChart + ReferLines) │
│    macd-panel.tsx              (Recharts ComposedChart)          │
│    signals-list.tsx            (simple list of Signal[])         │
└──────────────────────────────────────────────────────────────────┘
```

**Key invariants:**

- All compute happens on the server in a pure function. The client receives pre-computed arrays and renders them.
- Indicator arrays are parallel to `prices[]` — `sma20[i]` is the indicator value as of `prices[i].date`. `NaN` for unfilled positions.
- No new database tables, no new env vars, no new external HTTP calls.
- Reuses existing `PricesService.get` — which already handles staleness via cache + provider fallback.

## Indicator Specifications

| Indicator | Periods | Source | Output shape |
|---|---|---|---|
| Simple Moving Average | 20, 50, 200 days | Close prices | One number[] per period |
| Relative Strength Index | 14 days (Wilder smoothing) | Close prices | One number[], 0–100 range |
| MACD | Fast=12, Slow=26, Signal=9 | Close prices | { line, signal, histogram } |

### Formulas

**SMA(period)** — rolling arithmetic mean over the last `period` close prices. Returns `NaN` for indices `[0, period-2]`.

**EMA(period)** — seeded with `SMA(period)` at index `period-1`, then recursive: `ema[i] = price[i] * k + ema[i-1] * (1-k)` where `k = 2/(period+1)`. Returns `NaN` before the seed.

**RSI(14)** — Wilder's smoothing:
1. `gain[i] = max(close[i] - close[i-1], 0)`, `loss[i] = max(close[i-1] - close[i], 0)`
2. First `avgGain` = SMA of `gain[1..14]`; same for `avgLoss` (positioned at index 14)
3. Subsequent: `avgGain[i] = (avgGain[i-1] * 13 + gain[i]) / 14` (Wilder smoothing)
4. `rs = avgGain / avgLoss`; `rsi = 100 - 100/(1+rs)`
5. NaN for indices `[0, 13]` (need 14 returns to seed).

**MACD(12, 26, 9)**:
- `line = EMA(close, 12) - EMA(close, 26)` (NaN where either EMA is NaN)
- `signal = EMA(line, 9)`
- `histogram = line - signal`

## Signal Detection

`detectSignals(prices, computed) → Signal[]` walks the indicator arrays day-by-day and emits one `Signal` per state transition. Returned newest-first.

```ts
interface Signal {
  date: string;          // ISO YYYY-MM-DD
  kind: 'golden_cross' | 'death_cross' | 'macd_bullish' | 'macd_bearish'
      | 'rsi_overbought' | 'rsi_oversold';
  desc: string;          // human-readable
  value?: number;        // optional context (e.g., RSI reading at trigger)
}
```

| Kind | Trigger condition |
|---|---|
| `golden_cross` | `sma50[i-1] <= sma200[i-1] && sma50[i] > sma200[i]` |
| `death_cross` | `sma50[i-1] >= sma200[i-1] && sma50[i] < sma200[i]` |
| `macd_bullish` | `macdLine[i-1] <= macdSignal[i-1] && macdLine[i] > macdSignal[i]` |
| `macd_bearish` | `macdLine[i-1] >= macdSignal[i-1] && macdLine[i] < macdSignal[i]` |
| `rsi_overbought` | `rsi[i-1] <= 70 && rsi[i] > 70` (transition only — avoids flooding the list while RSI stays >70) |
| `rsi_oversold` | `rsi[i-1] >= 30 && rsi[i] < 30` (same logic — transition only) |

`Signal[]` is returned sorted by `date DESC`. For the typical 1Y window expect 0–8 signals per ticker.

## Output Shape

`computeTechnical(prices: PricePoint[]) → TechnicalResult`:

```ts
interface TechnicalResult {
  // Parallel arrays — index matches prices[i].date
  sma20: number[];
  sma50: number[];
  sma200: number[];
  rsi: number[];           // 0–100
  macdLine: number[];
  macdSignal: number[];
  macdHistogram: number[];

  // Sparse event list, newest first
  signals: Signal[];

  // Latest non-NaN reading for the header strip
  current: {
    price: number;
    sma20: number | null;
    sma50: number | null;
    sma200: number | null;
    rsi: number | null;
    macdHistogram: number | null;
  };
}
```

When `prices.length < 200`, `sma200` will be all NaN and `current.sma200` will be `null`. The UI must handle missing readings gracefully (render `—` instead of crashing).

## UI Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  AAPL · Technical                              Price 310.25  ↑5% │
│  SMA20: 305.10  SMA50: 298.42  SMA200: 245.18  RSI: 62.1  ...    │  header strip
├──────────────────────────────────────────────────────────────────┤
│   Price + SMAs                                                   │  ~320px
│   (LineChart: close, sma20, sma50, sma200; signal dots inline)   │
├──────────────────────────────────────────────────────────────────┤
│   RSI (14)                            ─ ─ ─ 70 ─ ─ ─ ─ ─ ─ ─ ─  │  ~140px
│   (LineChart, 0–100, ReferenceLine at 30 and 70)                 │
│                                       ─ ─ ─ 30 ─ ─ ─ ─ ─ ─ ─ ─  │
├──────────────────────────────────────────────────────────────────┤
│   MACD (12, 26, 9)                                               │  ~140px
│   (ComposedChart: histogram as Bar, line + signal as Lines)      │
├──────────────────────────────────────────────────────────────────┤
│  Recent signals                                                  │
│  · 2026-02-14  Golden cross (50d SMA crossed above 200d SMA)     │  scrollable list
│  · 2025-12-03  RSI overbought (78.3)                             │
│  · ...                                                           │
└──────────────────────────────────────────────────────────────────┘
```

**Tab nav:** Add "Technical" to the existing dashboard tab nav alongside Overview / Financials / Filings / Ask.

**Styling:** Tailwind + shadcn tokens; consistent with existing Recharts usage in `_components/fcf-chart.tsx`, `margin-chart.tsx`, etc. No new dependencies.

**Accessibility:** Charts have `<title>` / aria-label; signals list is a semantic `<ul>`. Numeric cells use `tabular-nums`.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `lib/compute/technical.ts` | Create | All indicator + signal compute functions |
| `tests/compute/technical.test.ts` | Create | Unit tests for sma/ema/rsi/macd/detectSignals/computeTechnical |
| `app/(app)/stock/[ticker]/technical/page.tsx` | Create | Server component — fetch prices, compute, render |
| `app/(app)/stock/[ticker]/technical/_components/technical-view.tsx` | Create | Client wrapper holding 3 charts + signals list |
| `app/(app)/stock/[ticker]/technical/_components/price-chart-with-smas.tsx` | Create | Recharts LineChart |
| `app/(app)/stock/[ticker]/technical/_components/rsi-panel.tsx` | Create | Recharts LineChart |
| `app/(app)/stock/[ticker]/technical/_components/macd-panel.tsx` | Create | Recharts ComposedChart |
| `app/(app)/stock/[ticker]/technical/_components/signals-list.tsx` | Create | Simple list |
| `app/(app)/stock/[ticker]/page.tsx` | Modify | Add "Technical" link to the tab nav |
| `app/(app)/stock/[ticker]/financials/page.tsx` | Modify | Add "Technical" link to the tab nav |
| `app/(app)/stock/[ticker]/filings/page.tsx` | Modify | Add "Technical" link to the tab nav |
| `app/(app)/stock/[ticker]/ask/page.tsx` | Modify | Add "Technical" link to the tab nav |

**Tab nav duplication note:** The tab nav (Overview/Financials/Filings/Ask links) is currently inlined in each of the 4 page.tsx files — no shared component. Slice 5A adds "Technical" by editing all 4 plus including the same nav block in the new `technical/page.tsx`. Extracting to a shared `<DashboardTabs>` component is a reasonable follow-up cleanup, but is **deferred from this slice** — that's a refactor that should ship on its own, not bundled with a feature.

## Testing Matrix

| Layer | Test | Asserts |
|---|---|---|
| `sma` | `[1,2,3,4,5]`, period=3 → `[NaN,NaN,2,3,4]` | windowed average + NaN padding |
| `ema` | seed + recursion against hand-computed fixture | smoothing weight `k = 2/(n+1)` |
| `rsi` | Wilder 1978 reference (14 closes) → published RSI | Wilder smoothing |
| `macd` | 30-day fixture → expected line/signal/histogram | composition of EMAs |
| `detectSignals` | Synthetic series with hand-placed crossovers | no dups, correct direction, transition-only for RSI |
| `computeTechnical` (integration) | Real AAPL 1Y prices | no NaN in `current.*`, signals list non-empty and chronological |
| `<TechnicalView>` snapshot | Minimal fixture | renders header + 3 panels + list |

## Rollout (Plan Tasks)

1. **`lib/compute/technical.ts` — primitive indicators** — `sma`, `ema`, `rsi`, `macd` + unit tests for each
2. **Signals + result wrapper** — `detectSignals` + `computeTechnical` + integration test against real AAPL prices
3. **Server route** — `app/(app)/stock/[ticker]/technical/page.tsx` fetches prices, calls compute, renders view
4. **Price chart with SMAs** — `<PriceChartWithSmas>` Recharts component + signal markers
5. **RSI + MACD panels** — `<RsiPanel>`, `<MacdPanel>` Recharts components
6. **Header strip + signals list** — `<TechnicalView>` wraps everything, adds the current-readings header and the recent-signals list. Add "Technical" entry to the dashboard tab nav.
7. **Push, watch CI, browser smoke** — verify AAPL/NVDA/MSFT/GOOGL/JD all render

## Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| Wilder RSI smoothing implemented incorrectly | Medium | Test against Wilder's 1978 published fixture (well-documented expected outputs) |
| MACD requires 26+9 = 35 priors to seed signal line | Low | UI handles NaN gracefully; document in code comment |
| Recharts `ComposedChart` with Bar+Line+Line composition is more fiddly than `LineChart` | Low | Pattern is documented; copy from Recharts examples |
| New tickers may have <200 trading days (JD has 251 — fine for now) | Low | UI shows `—` instead of crashing when `current.sma200 === null` |
| Server compute on every page load | Low | Indicators on 251 datapoints take <5ms; trivial cost |
| Performance with all 5 tickers visited rapidly | Low | Each request is independent + cached at the prices layer |

## Success Criteria

1. Visiting `/stock/AAPL/technical` renders a chart with 4 lines (price + 3 SMAs), an RSI panel, a MACD panel, and a signals list with at least one historical event.
2. Same for NVDA, MSFT, GOOGL, JD — no crashes, no all-NaN panels.
3. `pnpm test` passes with new `tests/compute/technical.test.ts` (all unit tests green).
4. CI green (lint / typecheck / unit / integration / build).
5. Latest known signal events match what you'd expect by eye from the chart (e.g., if SMAs visibly cross around date X, the signals list shows a cross at date X).
