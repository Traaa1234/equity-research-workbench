# Macro Weather Dashboard — Design Spec

**Date:** 2026-06-03 · **Status:** Approved (brainstorm complete; ready for plan).

This is **slice A1** of a new **Global Macro Strategy** product surface — a
top-down, cross-asset lens distinct from the existing bottom-up single-stock
workbench. A1 was chosen first because it stands up the shared macro-data
foundation (FRED + yfinance cross-asset) that every later macro slice reuses,
carries the lowest analytical risk (mostly fetch → classify → display), and maps
cleanly onto the established provider → store → service → API → UI patterns.

---

## 1. Goal

A single at-a-glance board answering "what's the macro weather right now?" across
asset classes — rates, credit, inflation/growth, the dollar, commodities, and
volatility/financial-conditions. Each tile shows the current value plus a
**deterministic, rule-based signal** (no ML, no opinion), and a one-line overall
**weather verdict** aggregates the signals. Data is **free**: FRED (no key
required; key preferred) + yfinance (already in-repo).

## 2. Scope decomposition (context)

The global-macro direction is a multi-slice product. This spec covers **A1 only**.
Deferred to later slices (explicitly **not** in v1):

- **A3 — computed regime label / correlation matrix** (this is why we chose the
  rule-based-signal design, *not* a composite regime score).
- A2 yield-curve/central-bank tracker, A4 sector rotation, A5 macro event
  calendar, B1 country scorecard.

A1 builds the foundation (`macro_series` store, `fred.ts` provider, yfinance
cross-asset reuse, daily refresh) that A2–A5 will consume.

## 3. Architecture & data flow

```
FRED (pure-TS REST/CSV, bounded date range) ──┐
                                              ├─► MacroService.refreshAll()   [lib/services/macro.ts]
yfinance (existing yfinance_fetch.py:          │     iterate registry → fetch → upsert → freshness
  gold GC=F, copper HG=F, WTI CL=F, VIX ^VIX) ─┘                │
                                                                ▼
                                              macro_series  (raw time series)
                                                                │
  READ: app/api/macro/route.ts → MacroService.getBoard()        │
          → latest + trailing window per series                 │
          → macro-signals.ts (pure: value → badge; Σ votes → weather)   [lib/compute]
          → board JSON (tiles grouped by asset class + weather + asOf)
                                                                │
                                                                ▼
        app/(app)/macro/page.tsx (server) → <MacroBoard> (client, Variant A)
            tile click → Radix dialog → app/api/macro/[seriesId]
                       → history + rule explanation → recharts
```

## 4. Providers

### `lib/providers/fred.ts` (new, pure-TypeScript — no Python)
FRED is a plain REST/CSV GET, so the provider calls `fetch()` directly (same
realization as the transcripts re-source — no `*_fetch.py`, no Vercel `fallback`
wrapper, no subprocess).

- Interface: `fetchSeries(seriesId, { start })` → `{ date: string; value: number }[]`
  (ascending; `value` parsed as float, FRED `.` missing markers dropped).
- **Key-preferred, keyless fallback:** if `FRED_API_KEY` is set, use the JSON API
  (`https://api.stlouisfed.org/fred/series/observations?series_id=…&observation_start=…&file_type=json&api_key=…`).
  Otherwise use the keyless CSV endpoint
  (`https://fred.stlouisfed.org/graph/fredgraph.csv?id=…&cosd=…`). Both verified live.
- **Throttling note (verified):** the keyless CSV endpoint rate-limits rapid
  sequential requests. `refreshAll` therefore fetches FRED series **sequentially
  with a small inter-request delay** (the keyed JSON path does not need this, but
  the delay is harmless). Never parallel-fan the FRED fetches.
- Always bound the request with a `start`/`cosd` date (we never pull full history).
- Fixtures in `lib/providers/__fixtures__` (CSV + JSON samples) drive unit tests; no
  live key needed in CI (`fetch` is mocked).

### `lib/providers/yfinance.ts` (reused as-is)
Symbol-agnostic; used for the 4 commodity/vol tickers. `snapshot` kind → latest
value; `prices_5y` kind → history for sparkline / percentile bands / detail chart.
Verified live for `GC=F`, `HG=F`, `^VIX` (and `CL=F` uses the identical futures
path). FRED `DCOILWTICO` is a documented fallback for WTI if ever needed.

## 5. Data model

### `macro_series` (raw observations) — `lib/db/schema.ts` → migration `0007`
| column | type | notes |
|---|---|---|
| `series_id` | `text` | registry key, e.g. `T10Y2Y`, `GC=F` |
| `obs_date` | `date` | observation date |
| `value` | `double precision` | raw value as published |
| `source` | `text` | `'fred'` \| `'yfinance'` |

**PK `(series_id, obs_date)`** — composite, idempotent upsert (`on conflict do
update`). No `bigserial` → the BigInt-over-the-wire gotcha does not apply here.

### `macro_freshness` (operational) — same migration
| column | type | notes |
|---|---|---|
| `series_id` | `text` PK | |
| `last_fetched_at` | `timestamptz` | last refresh attempt |
| `last_obs_date` | `date` | newest stored observation |
| `status` | `text` | `'ok'` \| `'error'` |
| `error` | `text` (nullable) | last error message |

Mirrors the `transcript_freshness` pattern; drives the UI stale banner and the
cron summary.

### Series registry — **in code**, not the DB
`lib/compute/macro-registry.ts` — a typed, ordered list mapping each series to its
display + classification config. The 13-tile board is fixed and curated, so a
version-controlled, type-checked code config is YAGNI-correct (a runtime-editable
meta table buys nothing in v1). Adding a tile = edit registry + backfill.

```ts
type AssetClass = 'rates' | 'credit' | 'inflation_growth' | 'dollar_fx'
                | 'commodities' | 'vol_conditions';
type Source = 'fred' | 'yfinance';
interface MacroSeriesDef {
  seriesId: string;          // storage key + FRED id / yfinance symbol
  label: string;             // tile label
  assetClass: AssetClass;
  source: Source;
  unit: string; decimals: number;
  role: 'vote' | 'context';  // does it contribute to the weather score?
  derive?: 'yoy';            // e.g. CPI index → YoY %
  rule: SignalRule;          // see §6
}
```

### RLS — `lib/db/migrations/9990_rls_macro_series.sql` (+ freshness)
Catalog data → `for select to authenticated using (true)`. Writes go through
`service_role` (BYPASSRLS). Applied to **both Neon branches** (test + prod) via
`pnpm exec tsx _apply.ts --target test|prod --file lib/db/migrations/9990_rls_macro_series.sql`.
`9990` is an unused number in the existing 99xx RLS sequence.

## 6. Signal model (the deterministic brain)

`lib/compute/macro-signals.ts` — pure functions over the latest value + the stored
trailing window. **Voting/context split:** only tiles with an unambiguous
risk-on/off sign vote in the weather score; the rest are shown as **context
levels** (badged, not summed). This prevents six correlated rates/level tiles from
dominating the aggregate.

### 6.1 Voting tiles — 7, one per macro theme → each contributes −1 / 0 / +1

| Tile | `seriesId` | Theme | Rule | −1 / 0 / +1 |
|---|---|---|---|---|
| 2s10s | `T10Y2Y` | curve/recession | curve sign | `<0` inverted / `0–0.25` flat / `>0.25` positive |
| HY OAS | `BAMLH0A0HYM2` | credit stress | level | `>5` stressed / `3.5–5` normal / `<3.5` tight |
| Unemployment | `UNRATE` | labor | Sahm: 3mo-avg − trailing-12mo-min | `≥0.5` trigger / `0.2–0.5` ticking / `<0.2` stable |
| VIX | `^VIX` | volatility | level | `>24` stressed / `16–24` normal / `<16` calm |
| NFCI | `NFCI` | fin. conditions | z-score (mean 0 by construction) | `>0.2` tight / `−0.2–0.2` neutral / `<−0.2` loose |
| Copper | `HG=F` | growth | trailing 3-mo % change | `<−5%` soft / `±5%` steady / `>+5%` firm |
| CPI YoY | `CPIAUCSL` (`derive:'yoy'`) | inflation | YoY % | `>4` hot / `2.5–4` elevated / `≤2.5` on-target |

Sign convention: **+1 = benign/risk-on, −1 = caution/risk-off.** For CPI and
unemployment, "benign" = on-target / stable.

### 6.2 Context tiles — 6, badged level, **no vote**

| Tile | `seriesId` | Source | Badge bands |
|---|---|---|---|
| 3m10y | `T10Y3M` | fred | `<0` inverted / `0–0.5` flat / `>0.5` normal (curve confirm) |
| 10Y yield | `DGS10` | fred | 3-yr percentile: low / normal / elevated |
| Fed funds | `DFF` | fred | `<2.5` accommodative / `2.5–4` neutral / `>4` restrictive |
| Broad USD | `DTWEXBGS` | fred | 3-yr percentile: weak / mid / strong |
| Gold | `GC=F` | yfinance | 3-yr percentile: low / firm / elevated |
| WTI crude | `CL=F` | yfinance | 3-yr percentile: cheap / range / rich |

Context badges are informational coloring only (slate, amber-tinted at a 3-yr
decile extreme); they never enter the weather sum.

### 6.3 Weather aggregation
Sum the 7 votes (range −7…+7) → 5-level label:

| Score | Label |
|---|---|
| ≥ +4 | ☀ SUNNY — risk-on |
| +2…+3 | 🌤 FAIR — constructive |
| −1…+1 | ⛅ MIXED — neutral |
| −3…−2 | ☁ CLOUDY — cautious |
| ≤ −4 | ⛈ STORMY — risk-off |

The hero also reports the benign/neutral/caution counts among the 7 voters and
which themes are flashing caution.

### 6.4 Derivations (computed in the signal layer from stored raw series)
- **CPI YoY:** `(latest_index / index_12mo_prior − 1) × 100` from raw `CPIAUCSL`.
- **Sahm (unemployment):** 3-month average minus the trailing-12-month minimum.
- **Copper momentum:** trailing 3-month percentage change.
- **Percentile bands (context tiles):** rank of latest within the trailing 3-yr window.

`macro_series` stores only **raw** source values; all derivations live in
`macro-signals.ts` and are unit-tested at their thresholds.

## 7. Refresh & cron

- Extend `RefreshKind` in `lib/ingest/refresh-runner.ts` with `'macro'`; add a
  branch calling `MacroService.refreshAll()` (iterate registry → fetch a bounded
  trailing window → upsert `macro_series` → update `macro_freshness`). FRED fetches
  run **sequentially**; yfinance via the existing subprocess.
- `vercel.json`: add `{ "path": "/api/cron/refresh?kind=macro", "schedule": "0 22 * * *" }`
  (daily ~22:00 UTC, after FRED EOD). 13 series ≈ well under the 50s budget;
  existing `maxDuration: 60` on the cron route covers it.
- **Backfill:** one-off `scripts/seed-macro.ts` (+ `package.json` script) pulls
  ~5 yr/series for percentile bands + detail charts (~17k rows total — trivial).
  The daily cron then refreshes only a short trailing window; monthly (CPI,
  UNRATE) and weekly (NFCI) series no-op on non-release days (idempotent upsert).

## 8. API

Both use existing `ok()` / `errorResponse()` helpers and authenticated reads
(catalog data via the authenticated user DB; RLS `select` is `true`).

- `app/api/macro/route.ts` `GET` → board JSON: `{ weather, asOf, groups: [{ assetClass, tiles: [...] }] }`,
  signals computed server-side.
- `app/api/macro/[seriesId]/route.ts` `GET` → `{ meta, points: [{date,value}], ruleExplanation, badge, asOf }`,
  bounded by a `range` param (`1y|3y|5y`). Unknown `seriesId` (not in registry) → 404.

## 9. UI (`app/(app)/macro/` + `components/macro/`)

- **`macro/page.tsx`** (server) — fetches the board, renders **Variant A**: hero
  weather banner (label + voter counts + flashing themes) → six asset-class
  sections, each a responsive tile grid.
- **New top-level nav entry "Macro"** in the app-shell nav, alongside Watchlist /
  Journal.
- **`<MacroTile>`** (client) — label, value, change vs previous observation (1-day
  for daily series; prior month/week for monthly/weekly), signal badge (green/+1,
  slate/0, red/−1 for voters; muted level coloring + no vote-dot for context),
  ~90-day sparkline, caption.
- **`<MacroDetail>`** drawer (`@radix-ui/react-dialog`) — opens on tile click →
  `recharts` history chart with 1y/3y/5y toggle, the **plain-English rule** that
  produced the current badge, value, **as-of date**, source.
- **States:** skeleton (loading); stale banner (when `macro_freshness.status='error'`
  or `last_obs_date` is stale for a daily series); empty (pre-backfill).

## 10. Testing strategy

- **Unit (highest value):** `macro-signals.ts` — boundary tests on **every**
  threshold in §6.1/§6.2 and all 5 weather bands in §6.3; the §6.4 derivations
  (CPI YoY, Sahm, copper momentum, percentile). Registry integrity test (every
  entry has a valid source/rule; voters sum-bounded).
- **Provider:** `fred.ts` CSV + JSON parsing (incl. `.` missing markers, empty
  body) via `__fixtures__`.
- **Integration (dedicated Neon test branch, `makeTestServiceDb`/`makeTestUserDb`):**
  `macro_series` upsert idempotency; **RLS** — authenticated can `select`, writes
  blocked except `service_role`. Per the drizzle-0.45 gotcha, assert on
  `error.message + String(error.cause)`.
- **API:** board route shape; unknown `seriesId` → 404.
- **E2E (Playwright):** one `test.skip` happy-path (board renders, tile opens
  drawer), matching the skipped-authed-E2E convention.

## 11. Out of scope (v1)

No computed regime label or correlation matrix (deferred A3); no sector rotation,
country scorecard, or event calendar; no intraday refresh; no user-editable
tiles/thresholds; no alerts/notifications; no "market reaction after event"
overlays.

## 12. Build shape (subagent-driven; formalized by writing-plans)

| Task | Summary | Review |
|---|---|---|
| T1 | Schema: `macro_series` + `macro_freshness` → generate `0007` → migrate both branches | inline |
| T2 | RLS `9990_rls_macro_series.sql` (+freshness) → apply both branches | inline |
| T3 | `fred.ts` provider (key + keyless, sequential, fixtures) + unit tests | full |
| T4 | `macro-registry.ts` + `macro-signals.ts` (the brain) + exhaustive unit tests | full |
| T5 | `MacroService` (`refreshAll` + `getBoard`) + yfinance reuse + integration tests | full |
| T6 | `refresh-runner` `'macro'` kind + `vercel.json` cron + `scripts/seed-macro.ts` backfill | inline |
| T7 | Board API + detail API + tests | full |
| T8 | Board UI: page + `<MacroBoard>` + `<MacroTile>` + hero + sections | inline |
| T9 | Detail drawer (recharts) + nav entry | inline |
| T10 | E2E-skip happy-path + stale/empty states + polish | inline |

## 13. Conventions adhered to

- Direct commit to master; commit trailer exactly `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Migrations via `pnpm db:generate` → `pnpm db:migrate` (skips 9xxx, tracks hashes);
  RLS via `_apply.ts` on both branches; never `drizzle-kit push --force`.
- Catalog RLS pattern (`select to authenticated using(true)`, writes via service_role).
- No `bigserial` on the wire (composite PK), so no `ser()` BigInt dance needed here.
- FRED provider pure-TS (no Python); yfinance keeps the existing subprocess provider.
- TS strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); pnpm; tests
  against the Neon test branch; authed E2E written `test.skip`.
