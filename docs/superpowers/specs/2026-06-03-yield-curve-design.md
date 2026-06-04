# Yield-Curve Detail — Design Spec

**Date:** 2026-06-03 · **Status:** Approved (brainstorm complete; ready for plan).

This is **slice A2a** of the Global Macro Strategy surface — a focused Treasury
yield-curve page extending the A1 macro dashboard. It reuses the A1 foundation
(`macro_series`, `FredProvider`, the cron + registry + compute-on-read + page/drawer
patterns) almost entirely; the central-bank decision calendar (**A2b**) is split off
as a separate later slice.

---

## 1. Goal

A `/macro/curve` page that shows the full Treasury yield curve, the exact yield at
each maturity, the key curve spreads, and a **deterministic shape + recession-signal
read** — all free FRED daily data, all rule-based (no ML), consistent with A1.

## 2. Scope (context)

Covers **A2a only**. Out of v1: the historical curve-evolution heatmap, the **A2b**
central-bank decision calendar, TIPS/real or breakeven curves, and bull/bear-
steepening fine-grain beyond the simple momentum tag.

## 3. Data — 9 maturities (all FRED daily, reuse `macro_series`)

`DGS3MO, DGS6MO, DGS1, DGS2, DGS5, DGS7, DGS10, DGS20, DGS30`. `DGS10` is already in
`macro_series` from A1 (shared, idempotent upsert). **No new table, migration, or RLS**
— the existing `9990` catalog policy covers it.

**`lib/compute/curve-registry.ts`** — the ordered maturity list, each
`{ seriesId, label, months }` (months = ordering key: 3, 6, 12, 24, 60, 84, 120, 240, 360),
plus the 3 spread definitions:
- **2s10s** = `DGS10 − DGS2`
- **3m10y** = `DGS10 − DGS3MO`
- **5s30s** = `DGS30 − DGS5`
(Computed from the displayed maturity series so the spreads and the plotted points are
always consistent.)

## 4. Read model (the deterministic brain — `lib/compute/curve-analytics.ts`)

Pure functions over the latest values + the stored daily history.

### 4.1 Shape classification (first matching rule wins)
| # | Rule | Label |
|---|---|---|
| 1 | 3m10y < 0 **and** 2s10s < 0 | `INVERTED` |
| 2 | exactly one of {3m10y, 2s10s} < 0 | `PARTIALLY_INVERTED` |
| 3 | \|DGS10 − DGS3MO\| < 0.25 | `FLAT` |
| 4 | max(DGS2, DGS5) > max(DGS3MO, DGS30) + 0.1 | `HUMPED` |
| 5 | else | `NORMAL` |

### 4.2 Momentum tag (from the 2s10s 3-month change)
`> +0.1` → `steepening` · `< −0.1` → `flattening` · else `stable`.

### 4.3 Recession signal (first matching rule wins)
| # | Condition | Level / label |
|---|---|---|
| 1 | 3m10y < 0 **and** 2s10s < 0 | 🔴 `ON` — both curves inverted |
| 2 | exactly one < 0 | 🟠 `CAUTION` — front-end inverted |
| 3 | both ≥ 0 now, but 3m10y was < 0 within the last ~6 months | 🟠 `WATCH` — re-steepening (late-cycle window) |
| 4 | else | 🟢 `CLEAR` — positively sloped |

Rule 3 encodes that recessions historically *begin* after the curve re-steepens, so a
freshly un-inverted curve is not an all-clear.

### 4.4 Inversion duration
From the stored daily 3m10y series (computed each read): if currently inverted, the
count of consecutive most-recent **months** with 3m10y < 0; if currently positive but
recently inverted (rule 3), the **months since un-inversion**. Surfaced in the banner +
the 3m10y spread tile.

## 5. Service — `lib/services/yield-curve.ts`

Mirrors `MacroService`/`CountryScorecardService` for the upsert/freshness plumbing.

- `refreshAll('daily'|'backfill')` — fetch the 9 maturity series (sequential, `fredDelayMs`
  default 500), upsert `macro_series` + freshness. backfill = 5yr; daily = 40-day window.
- `getCurve()` → `{ asOf, maturities[], spreads[], read }` where:
  - `maturities[]` = `{ seriesId, label, months, current, change1d, overlay: { m1, y1, y2 } }`
    (overlay = the maturity's value 1-month / 1-year / 2-years ago, for the plot overlay toggle).
  - `spreads[]` = `{ key, label, value, badge, durationMo? }` (badge: INVERTED / FLAT / POSITIVE / STEEP).
  - `read` = `{ shape, momentum, recession: { level, label, durationMo } }`.
- `getMaturityDetail(seriesId)` → one rate's full stored history (for the drawer). Unknown
  seriesId (not in the curve registry) → throw → 404 at the route.

## 6. Refresh & cron

- New `RefreshKind` `'curve'` in `refresh-runner.ts` (short-circuits like `macro`/`countries`),
  calling `YieldCurveService.refreshAll('daily')`.
- `vercel.json`: `{ "path": "/api/cron/refresh?kind=curve", "schedule": "15 22 * * *" }`
  (daily, just after the macro cron — yields are daily). The cron route's `buildDeps` builds
  the service (reusing `FredProvider`).
- Backfill: `scripts/seed-curve.ts` (`refreshAll('backfill')`, 5yr) + a `seed-curve`
  `package.json` script. (~8 new FRED series; `FRED_API_KEY` keeps it un-throttled.)

## 7. API

- `app/api/curve/route.ts` `GET` → the board (`getCurve()`), authenticated read, `Cache-Control: private, max-age=300`.
- `app/api/curve/[seriesId]/route.ts` `GET` → maturity history; validate seriesId against the
  curve registry (unknown → `NotFoundError` → 404, mirroring the macro/countries detail routes).

## 8. UI (`app/(app)/macro/curve/` + `_components/`)

The approved layout, top to bottom:
- **Read banner** — shape + momentum + recession-signal verdict (+ inversion duration).
- **Curve plot** (`recharts` `LineChart`, categorical x = maturity label) — a solid "now" line
  + a dashed overlay line; an **overlay toggle** (1mo / 1yr / 2yr) selects which `overlay` value
  the dashed line uses (client-side, no re-fetch). Dots per maturity.
- **Maturity strip** — 9 compact tiles, each `{ label, current yield, 1d change }`; click → the
  maturity detail drawer.
- **Key spreads** — 2s10s / 3m10y / 5s30s tiles with the spread value + inversion badge (+ duration).
- **Maturity detail drawer** (Radix dialog + recharts, reusing the macro/countries drawer pattern)
  — one rate's history.
- New top-level **"Curve"** nav entry → `/macro/curve`.
- States: loading skeleton; stale banner (reused, >5 days for a daily series); empty (pre-backfill).

## 9. Testing

- **Unit (highest value):** `curve-analytics.test.ts` — every shape bucket (incl. the priority
  ordering and the 0.25 flat / 0.1 humped thresholds at boundaries), the momentum tag, all 4
  recession-signal levels (especially the "WATCH after un-inversion" rule), inversion-duration,
  and the 3 spread computations. Registry integrity (9 maturities, ordered, valid seriesIds).
- **Integration (test branch, reusing `macro_series`):** `refreshAll` upserts; `getCurve` returns
  9 maturities + 3 spreads + a read; `getMaturityDetail` unknown → throws.
- **API:** board shape; unknown seriesId → 404. **E2E:** one `test.skip` happy-path (page renders,
  a maturity tile opens the drawer).

## 10. Build shape (subagent-driven; formalized by writing-plans)

| Task | Summary | Review |
|---|---|---|
| T1 | `curve-registry.ts` + `curve-analytics.ts` (shape/recession/duration/spreads/momentum) + exhaustive unit tests | full |
| T2 | `YieldCurveService` (`refreshAll`/`getCurve`/`getMaturityDetail`) + `curve` cron kind + `seed-curve.ts` backfill + integration tests | full |
| T3 | board + maturity-detail APIs + tests | full |
| T4 | curve page UI (read banner + recharts curve plot w/ overlay toggle + maturity strip + spreads) + "Curve" nav | inline |
| T5 | maturity detail drawer (recharts) + loading/stale/empty states | inline |
| T6 | E2E-skip happy-path + final verification (typecheck/test/test:integration/lint/build) | inline |

## 11. Conventions adhered to

- Direct commit to master; trailer exactly `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Reuses `macro_series` + catalog RLS (`9990`) → **no new migration/RLS**.
- FRED pure-TS provider (sequential, `fredDelayMs`); compute-on-read analytics (`lib/compute`).
- TS strict; pnpm; tests against the Neon test branch; authed E2E `test.skip`.
- `numeric` values read as strings → `Number(...)`; no `bigserial` on the wire.
