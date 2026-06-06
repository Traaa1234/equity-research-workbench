# Cross-Asset Correlation Matrix — Design Spec

**Date:** 2026-06-03 · **Status:** Approved (brainstorm complete; ready for plan).

This is **slice A3a** of the Global Macro Strategy surface — a cross-asset
correlation heatmap. It is **pure compute-on-read** over data the A1 + B1 slices
already store; the regime classification (**A3b**) is a separate later slice that
can build on this.

---

## 1. Goal

A `/macro/correlations` page showing how the major asset classes are co-moving
*right now* — a 7×7 heatmap of pairwise rolling correlations (on returns), with a
30/60/90-day window toggle. Deterministic, free, all-reused data.

## 2. Scope (context)

Covers **A3a only**. Out of v1: the "vs typical / unusual-correlation" deviation
layer, per-pair correlation history, the **A3b** regime classification, and any
assets beyond the 7. **No new DB table, migration, RLS, provider, refresh, cron, or
backfill** — every input series already exists in `macro_series`.

## 3. Data — 7 assets, all already in `macro_series`

| Asset | seriesId | source slice | transform |
|---|---|---|---|
| EQ (S&P 500) | `SPY` | B1 (country ETF) | `return` |
| 10Y yield | `DGS10` | A1 | `diff` |
| Gold | `GC=F` | A1 | `return` |
| Dollar (broad) | `DTWEXBGS` | A1 | `diff` |
| HY credit spread | `BAMLH0A0HYM2` | A1 | `diff` |
| Oil (WTI) | `CL=F` | A1 | `return` |
| VIX | `^VIX` | A1 | `diff` |

`return` = daily simple return `v[i]/v[i-1] − 1` (price series). `diff` = daily
first difference `v[i] − v[i-1]` (yields, spreads, vol — levels, not prices). All
7 carry ~5yr of history (A1 13/13 + B1 SPY backfilled), kept current by the existing
macro (daily) + countries (weekly) crons.

**`lib/compute/correlation-registry.ts`** — the ordered asset list:
`{ seriesId, label, transform }`.

## 4. Correlation compute (`lib/compute/correlation.ts`, pure)

1. **Transform** each raw series to a daily-change series (per its `transform`),
   keyed by date.
2. **Align** all 7 on the intersection of their dates (so every correlation uses the
   same observation dates), ordered ascending.
3. For each window N ∈ {30, 60, 90}: take the **last N aligned observations**; compute
   pairwise **Pearson** correlation for every asset pair → an N_assets × N_assets
   matrix (symmetric; diagonal = 1).
4. A cell is **null** when the window has < 10 observations or either series has zero
   variance in the window (avoids divide-by-zero / meaningless values).

Exposed helpers (unit-tested): `dailyChange(series, transform)`, `alignByDate(seriesList)`,
`pearson(xs, ys)`, `correlationMatrix(alignedSeries, windowDays)`.

## 5. Service — `lib/services/correlation.ts`

- `getMatrices()` → `{ assets: { seriesId, label }[], windows: { '30': number[][] | (null)[][]; '60': ...; '90': ... }, asOf: string | null }`.
  Reads the 7 series from `macro_series` (`inArray`), transforms + aligns once, computes
  all three windows (cheap), and sets `asOf` = max observation date across the aligned
  series. (One server compute; the client toggles between the three matrices — no re-fetch.)

## 6. API

- `app/api/correlations/route.ts` `GET` → `getMatrices()`, authenticated read
  (`requireUserId()` then `getServiceDb()`), `Cache-Control: private, max-age=300`,
  `export const dynamic = 'force-dynamic'`. **No `[id]` detail route** (no per-pair history in v1).

## 7. UI (`app/(app)/macro/correlations/` + `_components/`)

- **Page** (server) — fetches `getMatrices()`, renders `<CorrelationMatrix>`. New top-level
  **"Correlations"** nav entry → `/macro/correlations`.
- **`<CorrelationMatrix>`** (client) — the 7×7 heatmap: cells colored on a red↔slate↔blue
  scale (−1 red = move opposite, 0 slate, +1 blue = move together), diagonal de-emphasized,
  `n/a` for null cells. A **30/60/90-day window toggle** switches between the three matrices
  client-side (no re-fetch). A small legend + an as-of line.
- **States:** loading skeleton; empty (if the 7 series have no overlapping data → all-null
  matrix with a "no data yet" note).

## 8. Testing

- **Unit (highest value):** `correlation.test.ts` — `pearson` on known vectors (+1 for
  identical, −1 for negated, ~0 for orthogonal); `dailyChange` for `return` vs `diff`;
  `alignByDate` intersection (drops non-common dates); `correlationMatrix` symmetry +
  diagonal = 1 + null cells for short window / zero variance. Registry integrity (7 unique
  ids, valid transforms).
- **Integration (test branch, reusing `macro_series`):** seed a few overlapping rows for the
  7 ids via the service-role client; `getMatrices()` returns the 7 assets, three windows, and
  a sane matrix (symmetric, diagonal 1).
- **API:** shape (assets + 3 windows). **E2E:** one `test.skip` happy-path (page renders, a
  window toggle works).

## 9. Build shape (subagent-driven; formalized by writing-plans)

| Task | Summary | Review |
|---|---|---|
| T1 | `correlation-registry.ts` + `correlation.ts` (transform/align/pearson/matrix) + exhaustive unit tests | full |
| T2 | `CorrelationService.getMatrices()` + `app/api/correlations/route.ts` + integration + API tests | full |
| T3 | heatmap UI (`<CorrelationMatrix>` + window toggle) + "Correlations" nav + page | inline |
| T4 | E2E-skip happy-path + final verification (typecheck/test/test:integration/lint/build) | inline |

## 10. Conventions adhered to

- Direct commit to master; trailer exactly `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Reuses `macro_series` + catalog RLS (`9990`) → **no new migration/RLS/cron/backfill**.
- Compute-on-read pure analytics in `lib/compute`; read-route auth + service-role pattern.
- TS strict; pnpm; tests against the Neon test branch; authed E2E `test.skip`.
- `numeric` values read as strings → `Number(...)`.
