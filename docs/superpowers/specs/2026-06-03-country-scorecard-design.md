# Country Scorecard — Design Spec

**Date:** 2026-06-03 · **Status:** Approved (brainstorm complete; ready for plan).

This is **slice B1** of the **Global Macro Strategy** surface — a cross-country
(top-down) lens, complementary to the shipped A1 macro weather dashboard. It ranks
~16 countries by an **investability-tilt** composite and reuses the A1 foundation
(`macro_series` store, `FredProvider`, `YFinanceProvider`, daily-refresh plumbing,
catalog RLS) almost entirely.

---

## 1. Goal

A single ranked **heatmap scorecard**: ~16 countries ordered by a 0–100 composite
that answers "where would I tilt global exposure now?" Each country is scored on
**5 equal-weighted dimensions** (growth, inflation, policy/rates, labor, equity
momentum), each blending a **level** and a **momentum** read, normalized by
**cross-country percentile rank**. Data is free: FRED-international (OECD-on-FRED)
+ country-ETF prices via yfinance.

## 2. Scope (context)

Covers **B1 only**. Builds on A1's foundation. Explicitly **not** in v1: equity
valuation dimension (free country-ETF P/E is unreliable), two-axis quadrant, FX/
currency dimension, custom dimension weights, historical scorecard playback,
per-sector country views, alerts. Other global-macro slices (A2 yield-curve/CB
tracker, A3 regime, A4 sector rotation, A5 event calendar) remain future work.

## 3. Architecture & data flow

```
FRED-international (CLI, long-rate, unemployment, CPI per country) ──┐
                                                                    ├─► CountryScorecardService.refreshAll()
country ETFs (yfinance prices_batch — one subprocess for all 16) ───┘     fetch → upsert macro_series → freshness
                                                                                    │
                                                                                    ▼
                                                                    macro_series  (REUSED — no new table)
                                                                                    │
  READ: app/api/countries/route.ts → getScorecard()                                 │
          → latest + trailing window per country-series                             │
          → country-score.ts (pure: per-dim level+momentum → percentile → composite → rank)
          → ranked rows JSON (16 countries × {composite, 5 dim scores})
                                                                                    │
                                                                                    ▼
        app/(app)/macro/countries/page.tsx (server) → <CountryScorecard> (client heatmap table)
            row click → Radix dialog → app/api/countries/[code] → dimension values + recharts history
```

## 4. Data model

- **Storage: reuse `macro_series`** (`series_id, obs_date, value, source`; composite
  PK). The country FRED series + ETF prices are the same shape. No new table, no new
  migration, no new RLS (the existing `9990` catalog policy covers it). `macro_freshness`
  is reused for per-series status.
- **Country registry — in code:** `lib/compute/country-registry.ts`, a typed list of
  ~16 countries, each `{ code, name, flag, etf, series: { cli, longRate, unemployment, cpi } }`.
  Mixed FRED code conventions are real (3-letter for CLI/CPI families, 2-letter for
  unemployment/rate families), so each country carries its **exact resolved series ids**.
  Inflation ids are **best-effort** (resolved + verified current during T1; `null` →
  that country scores neutral on inflation).

### Country set (~16) + ETFs
US `SPY` · Canada `EWC` · UK `EWU` · Germany `EWG` · France `EWQ` · Italy `EWI` ·
Spain `EWP` · Japan `EWJ` · Australia `EWA` · Korea `EWY` · China `MCHI` ·
India `INDA` · Brazil `EWZ` · Mexico `EWW` · Taiwan `EWT` · South Africa `EZA`.

Macro series families (resolved per-country in T1):
- **Growth** — OECD CLI `<ISO3>LOLITOAASTSAM` (verified current incl. CN/IN/BR/KR).
- **Labor** — harmonized unemployment `LRHUTTTT<ISO2>M156S`.
- **Policy/rates** — long-term gov yield `IRLTLT01<ISO2>M156N`.
- **Inflation** — per-country current CPI (national/HICP) → YoY; **best-effort**.
- **Known coverage gaps:** **Taiwan** is not in OECD-on-FRED — likely no CLI/
  unemployment/rate/CPI; it scores on equity momentum (`EWT`) with the macro dims
  neutral (50). Some EM may miss unemployment/rate/CPI → neutral on those.

## 5. Providers

- **`FredProvider`** (reused) — per-country FRED series, sequential with the existing
  500ms keyless delay (no delay if `FRED_API_KEY` set).
- **`YFinanceProvider`** (extended) — new **`prices_batch`** path: one subprocess
  (`scripts/yfinance_fetch.py` gains a `prices_batch` kind using `yf.download([...])`)
  fetching all 16 ETFs at once, returning `{ symbol: PricePoint[] }`. This avoids 16
  separate subprocess spawns (~40s) that would blow the cron budget. Fixture-tested via
  the provider's parse.

## 6. Scoring model (the deterministic brain — `lib/compute/country-score.ts`)

Pure functions over the latest values + trailing windows. For each country, every
dimension has a **level** metric and a **momentum** metric. Each metric is
**percentile-ranked across the countries that have it**, oriented so **"good" = high
percentile** (a per-metric `direction` flag inverts "lower is better"). Dimension
score = mean(level pct, momentum pct). **Composite = equal-weight mean of the 5
dimension scores**; rank descending. A missing metric contributes **50**.

| Dimension | Source | Level metric | Momentum metric | "Good" = |
|---|---|---|---|---|
| Growth | OECD CLI | CLI level | CLI 6-mo change | higher / rising |
| Inflation | CPI YoY (per-country) | CPI YoY | Δ CPI YoY (6-mo) | lower / falling |
| Policy/rates | Long-term gov yield | yield level | Δ yield (6-mo) | lower / easing |
| Labor | Harmonized unemployment | unemployment rate | Δ unemployment (12-mo) | lower / falling |
| Equity momentum | Country ETF | 6-mo total return | last price vs 200-day MA (% above/below) | higher / above trend |

- **Direction handling:** `percentileRank` ranks ascending; for `direction:'lower'`
  metrics, use `100 − pct` (or rank the negated value) so low/falling ⇒ high score.
- **Windows:** CLI Δ 6-mo; rates Δ 6-mo; unemployment Δ 12-mo; equity 6-mo return +
  200-day MA. Derivations (YoY, Δ-over-months, MA) live in `country-score.ts` and are
  unit-tested at boundaries.
- **Inflation simplification (documented):** "lower = better" treats outright
  deflation as "good"; the momentum half (is it falling?) partially compensates.
  Acceptable for v1.
- **Composite output:** `{ code, name, flag, composite, rank, dims: { growth, inflation,
  rates, labor, equity } }` where each dim is 0–100 (or `null`→rendered as 50/n-a).

## 7. Refresh & cron

- New `RefreshKind` `'countries'` in `refresh-runner.ts` (short-circuits like `'macro'`),
  calling `CountryScorecardService.refreshAll()`.
- `vercel.json`: `{ "path": "/api/cron/refresh?kind=countries", "schedule": "0 6 * * 0" }`
  (**weekly**, Sunday 06:00 UTC — the FRED-international series are monthly, so daily is
  pointless). The cron route's `buildDeps` constructs the service (reusing `FredProvider`
  + `YFinanceProvider`).
- **Budget:** ~64 FRED (keyed ≈20s / keyless+delay ≈35s) + **1 batched ETF call** (~5–10s)
  fits the 60s function limit. (If on Vercel Pro, `maxDuration` could be raised, but the
  batch keeps it within Hobby limits.)
- **Backfill:** `scripts/seed-countries.ts` (`refreshAll('backfill')`, 5yr) + a
  `package.json` `seed-countries` script. Run once for prod (+ test branch optional).

## 8. API

- `app/api/countries/route.ts` `GET` → `{ asOf, countries: RankedRow[] }`, authenticated
  read (`requireUserId()` then `getServiceDb()`), `Cache-Control: private, max-age=300`.
- `app/api/countries/[code]/route.ts` `GET` → one country's dimension values + per-dim
  metric histories (`{ date, value }[]`) for the detail charts. Unknown code (not in
  registry) → `NotFoundError` → 404 (validate against the registry before the service call).

## 9. UI (`app/(app)/macro/countries/` + `_components/`)

- **Page** (server) — `requireUserId()`, `getScorecard()` via the service, renders the
  table. `export const dynamic = 'force-dynamic'`. New top-level **"Countries"** nav entry
  in `app/(app)/_components/nav.tsx` → `/macro/countries`.
- **`<CountryScorecard>`** (client) — heatmap table: ranked rows (flag + name + composite +
  5 dim cells), cells color-coded 0–100 (**green ≥67 / amber 50–66 / red <50**),
  **sortable by any column** (header click; composite-desc default). `n/a` rendering for
  null dims.
- **`<CountryDetail>`** drawer (reuses the macro Radix-dialog + recharts pattern) — on row
  click: the 5 dimensions with underlying metric *values* (CLI, CPI YoY, yield,
  unemployment, ETF 6-mo return) + history charts + the percentile breakdown.
- **States:** skeleton (loading); stale banner (reused, when freshness is old/errored);
  empty (pre-backfill: "Run `pnpm seed-countries`").

## 10. Testing

- **Unit (highest value):** `country-score.test.ts` — `percentileRank` + direction
  inversion; level+momentum blend; composite mean; **missing→50**; ranking + tie order;
  the derivations (YoY, Δ-over-months, 200-day MA, % vs MA) at boundaries. Registry
  integrity (16 countries; each has `code/name/etf`; series object present).
- **Provider:** `prices_batch` parse via `__fixtures__` (one fixture with multiple
  symbols).
- **Integration (test branch, reusing `macro_series`):** `refreshAll` upserts country
  series + freshness; `getScorecard` returns 16 ranked rows in the expected shape;
  `getCountryDetail` for a known code.
- **API:** scorecard shape (16 rows, 5 dims, sorted); unknown country code → 404.
- **E2E:** one `test.skip` happy path (table renders, sort works, row opens detail),
  matching the skipped-authed convention.

## 11. Build shape (subagent-driven; formalized by writing-plans)

| Task | Summary | Review |
|---|---|---|
| T1 | `country-registry.ts` — 16 countries + ETFs + series; **resolve/verify per-country FRED ids incl. best-effort inflation** | full (data resolution) |
| T2 | `country-score.ts` pure compute (percentile/direction/level+momentum/composite/rank) + exhaustive unit tests | full |
| T3 | yfinance `prices_batch` kind (script + provider method) + fixture test | full |
| T4 | `CountryScorecardService` (`refreshAll`/`getScorecard`/`getCountryDetail`) + integration tests | full |
| T5 | `'countries'` cron kind + `vercel.json` weekly + `scripts/seed-countries.ts` backfill (live data) | inline |
| T6 | scorecard + country-detail APIs + tests | full |
| T7 | heatmap-table UI (sortable) + "Countries" nav entry | inline |
| T8 | country detail drawer (recharts) + loading/stale/empty states | inline |
| T9 | E2E-skip happy-path + final verification (typecheck/test/test:integration/lint/build) | inline |

## 12. Conventions adhered to

- Direct commit to master; trailer exactly `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Reuses `macro_series` + catalog RLS (`9990`) → **no new migration or RLS** for this slice.
- FRED pure-TS provider (sequential, keyless-delay/keyed); yfinance keeps the subprocess
  pattern (extended with a batch kind).
- Compute-on-read scoring (pure, in `lib/compute`), like the macro board. No stored scores.
- TS strict; pnpm; tests against the Neon test branch; authed E2E written `test.skip`.
- `numeric` values read as strings → `Number(...)`; no `bigserial` on the wire.
