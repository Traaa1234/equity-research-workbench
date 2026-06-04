# Session Handoff — 2026-06-03

Purpose: let a fresh session resume cheaply. Read this first, then the specific
spec/plan files referenced below as needed. (Supersedes
`SESSION-HANDOFF-2026-06-02.md`; conventions + parked threads carried forward.)

## Project

**Equity Research Workbench** — Next.js 14 (App Router) + TypeScript strict
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Drizzle ORM + Neon
Postgres + pgvector (HNSW), Stack Auth, Tailwind/shadcn. Deployed on Vercel.
Repo: `Traaa1234/equity-research-workbench` (public). Package manager: `pnpm`.

## Conventions (IMPORTANT — follow these)

- **Direct commit to master** is the established flow (no PR). Never force-push, never `--no-verify`, never bypass signing.
- **Commit trailer, exactly:** `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
- **Migrations:** numbered drizzle SQL applied via `pnpm db:migrate` (= `scripts/migrate.ts`, which skips files starting with `9` and tracks applied hashes in `public.__drizzle_migrations`). Latest is **0016** (`0015` created the macro tables; `0016` dropped a redundant index). `pnpm db:generate` auto-sequences from the highest existing index. Apply each migration to **both** Neon branches: `DATABASE_URL=$DATABASE_URL_SERVICE_ROLE pnpm db:migrate` (prod) and `DATABASE_URL=$DATABASE_URL_TEST_SERVICE_ROLE pnpm db:migrate` (test). RLS files use a `9xxx_` prefix and are applied separately via `pnpm exec tsx _apply.ts --target prod|test --file <path>` (run for both). `psql` is NOT installed. Remember to `git add` the generated `lib/db/migrations/meta/<n>_snapshot.json` files (easy to miss).
- **RLS patterns:** catalog tables (filings, chunk_embeddings, transcripts, **macro_series/macro_freshness**) = `for select to authenticated using(true)`; user-scoped tables (qa_history, journal_*) = `using (user_id::text = current_setting('request.jwt.claim.sub', true))`. Writes go through service_role (BYPASSRLS).
- **drizzle 0.45 gotcha:** RLS-blocked writes throw `DrizzleQueryError` wrapping the PostgresError in `.cause` — tests must inspect `error.message + String(error.cause)`, not just `.message`.
- **BigInt serialization:** drizzle `bigserial` ids are `bigint`; `NextResponse.json` throws on them. Use a `ser()` helper, or avoid `bigserial` entirely with a composite PK (as the macro tables do).
- **Provider pattern:** external data via Python subprocess (`scripts/*_fetch.py`) for yfinance/EDGAR; **plain REST sources are pure-TS** (`fetch()` directly — FRED, API Ninjas). Inject `fetch` for testability.
- **Test branches:** integration tests run against a dedicated Neon test branch (`makeTestServiceDb`/`makeTestUserDb` in `tests/helpers/test-db.ts`). Pure tests → `tests/compute/`, `tests/providers/`; DB tests → `tests/integration/`. Run pure with `pnpm test`, DB with `pnpm test:integration`. Authed Playwright E2E specs are all `test.skip` pending a Stack Auth ESM fixture fix — write them skipped, matching the pattern.
- **Execution flow:** brainstorm (superpowers:brainstorming) → spec in `docs/superpowers/specs/` → plan in `docs/superpowers/plans/` → execute subagent-driven (fresh subagent per task + spec-compliance then code-quality review). Schema/RLS/pure-compute tasks verified inline; logic-heavy tasks (services, routes) get full review.

## Shipped feature inventory

Single-ticker (`/stock/[TICKER]` tabs): Overview, Journal, Financials, Technical,
News(+sentiment), Insiders, Holdings(13F), Filings(+AI summaries+tables),
Quality(Piotroski/Altman/Beneish), Peers, Ask(RAG over filings).
Watchlist (`/watchlist`): Roll-up, Discover(semantic NL search), Search, Ask.
**Macro (`/macro`): cross-asset "macro weather" dashboard.** **Countries
(`/macro/countries`): cross-country investability scorecard.** (Both NEW this
session — see below.) Plus: cron refresh, add-ticker, health, CI.

**Universe seeder:** COMPLETE — ~6,300 of ~6,500 tickers have descriptions +
1024-d embeddings (`companies_universe`).

## NEW: Global Macro Strategy — Slice A1 (Macro Weather Dashboard) — SHIPPED

Top-down, cross-asset lens, distinct from the bottom-up single-stock workbench.
**Live at `/macro`, deployed, 13/13 series populated.**

- **Spec/plan:** `docs/superpowers/specs/2026-06-03-macro-weather-dashboard-design.md` + `.../plans/2026-06-03-macro-weather-dashboard.md`.
- **What it is:** 13 free tiles (FRED + yfinance) in 6 asset-class groups, a 5-level "weather" verdict (☀ SUNNY … ⛈ STORMY) summed from **7 rule-based voting signals**, plus **6 context level tiles** (badged, not summed). All deterministic — no ML. Clickable tile → Radix-dialog drawer with a recharts history chart (1y/3y/5y) + the plain-English rule + as-of.
- **Voters (7):** `T10Y2Y` (2s10s), `BAMLH0A0HYM2` (HY OAS), `CPIAUCSL` (CPI YoY, derived), `UNRATE` (Sahm), `HG=F` (copper momentum), `^VIX`, `NFCI`. **Context (6):** `T10Y3M`, `DGS10`, `DFF`, `DTWEXBGS`, `GC=F`, `CL=F`. Thresholds are in spec §6.
- **Key files:** providers `lib/providers/fred.ts` (pure-TS; **key-preferred, keyless fallback**; dispatches parse by response content-type) + reused `lib/providers/yfinance.ts` (GC=F/CL=F/HG=F/^VIX). Signals `lib/compute/macro-signals.ts`; registry `lib/compute/macro-registry.ts` (in-code, the 13-tile config). Service `lib/services/macro.ts` (`refreshAll`, `getBoard`, `getSeriesDetail`). Tables `macro_series` (composite PK `(series_id,obs_date)`) + `macro_freshness`; RLS `9990_rls_macro_series.sql`. APIs `app/api/macro/route.ts` + `app/api/macro/[seriesId]/route.ts`. UI `app/(app)/macro/page.tsx` + `_components/{macro-board,macro-tile,macro-detail}.tsx`; nav entry in `app/(app)/_components/nav.tsx`.
- **Refresh:** cron kind `macro` in `lib/ingest/refresh-runner.ts` (short-circuits before the per-ticker loop) + `vercel.json` (`/api/cron/refresh?kind=macro`, `0 22 * * *`). One-off backfill: `pnpm seed-macro` (`scripts/seed-macro.ts`, `refreshAll('backfill')` = 5yr).
- **Data state:** **prod branch fully populated (13/13, ~5yr).** Test branch NOT seeded (integration tests use fake providers + truncate — no real data needed).
- **FRED gotcha (important):** the **keyless** `fredgraph.csv` endpoint rate-limits (HTTP 429) under load (and occasionally 504s on high-traffic daily series). Mitigated by a **configurable inter-request delay** (`fredDelayMs`, default 500ms; pass `0` in tests) in both `MacroService` and `CountryScorecardService`. A **`FRED_API_KEY` is now set in `.env.local`** and is **valid** (32-char, verified) — `FredProvider` auto-uses the unthrottled JSON API when present. **NOTE:** confirm it's also in **Vercel env** so the deployed crons use the keyed API (otherwise they fall back to keyless + the delay, which is fine for macro's 13 series but borderline for countries' 36).

## NEW: Global Macro — Slice B1 (Country Scorecard) — SHIPPED

Cross-country investability lens. **Live at `/macro/countries`, deployed.**

- **Spec/plan:** `docs/superpowers/specs/2026-06-03-country-scorecard-design.md` + `.../plans/2026-06-03-country-scorecard.md`.
- **What it is:** ~16 countries ranked 0–100 by a composite of **5 equal-weighted dimensions** (growth/inflation/rates/labor/equity-momentum), each blending a **level** + **momentum** read, normalized by **cross-country percentile rank** (good = high; a per-metric direction inverts "lower is better"; a missing metric → neutral 50). Sortable heatmap table (green ≥67 / amber 50–66 / red <50); row click → detail drawer with per-series recharts. **No new table/migration/RLS** — country series reuse `macro_series` + the `9990` catalog RLS.
- **Key files:** `lib/compute/country-registry.ts` (16 countries → ETF + FRED ids), `lib/compute/country-score.ts` (pure percentile scoring), `lib/services/country-scorecard.ts` (`refreshAll`/`getScorecard`/`getCountryDetail`, `fredDelayMs` like macro). APIs `app/api/countries/route.ts` + `[code]`. UI `app/(app)/macro/countries/page.tsx` + `_components/{country-scorecard,country-detail}.tsx`; nav "Countries" entry. yfinance gained a **`prices_batch_1y`/`prices_batch_5y`** kind in BOTH `scripts/yfinance_fetch.py` AND `api/fallback/yfinance.py`, plus `YFinanceProvider.pricesBatch()` — one call fetches all 16 ETFs (keeps the cron in budget).
- **Refresh:** cron kind `countries` (`/api/cron/refresh?kind=countries`, **weekly** `0 6 * * 0` — FRED-international is monthly). Backfill: `pnpm seed-countries` (5yr).
- **Data coverage (verified):** CLI (`<ISO3>LOLITOAASTSAM`) for 15 (not Taiwan); unemployment (`LRHUTTTT<ISO2>M156S`) + long rate (`IRLTLT01<ISO2>M156N`) for the 10 DM; **inflation = US-only** (`CPIAUCSL`) — the OECD international CPI families on FRED are stale (~2024) / MoM%-type, unusable for a current YoY index, so non-US `cpi` is null → neutral. Documented best-effort gap; future enhancement = source current national CPI indexes per country. EM (CN/IN/BR/MX/ZA) + TW lack most macro dims → neutral there; they still score on equity momentum (ETF).
- **DATA STATUS — ACTION ITEM:** the prod backfill is **PARTIAL** — DM core + all 16 ETFs landed (~5yr); JP/AU/KR + EM macro series **429'd** from running the backfill ~5× in one day (FRED per-IP rate limit, not a key/code problem — a single keyed request to a "failed" series returns data fine). **To complete: run `pnpm seed-countries` once more after FRED's limit resets (a few hours), or let the weekly cron fill it in.** The page renders all 16 now (neutral where data is missing).

### Global-macro future slices (not yet built)
Spine A (cross-asset): **A2** yield-curve + central-bank tracker · **A3** regime detection / correlation matrix (deliberately deferred — A1 chose rule-based signals, not a composite regime score) · **A4** sector-rotation map · **A5** macro event calendar (free-data-source question). The shared foundation (FRED + yfinance providers incl. `pricesBatch`, `macro_series` store, cron, the registry + compute-on-read + heatmap-UI patterns) is built and reusable.

## Parked threads (resume points — unchanged)

### 1. Earnings Transcripts slice — BLOCKED on a free data source
- **Done:** T1 (schema: `transcripts`, `transcript_chunks`, `transcript_freshness`) + T2 (RLS), both Neon branches. Source-agnostic; dormant tables, harmless.
- **Spec/plan:** `docs/superpowers/specs/2026-05-29-earnings-transcripts-design.md` + `.../plans/2026-05-29-earnings-transcripts.md` (both have revision boxes at top).
- **Decision pending (user):** (A) test discountingcashflows.com free key — last credible $0 shot; (B) pay $39/mo API Ninjas Developer; (C) shelve. Re-sources are pure-TS REST; provider returns full text as one `{kind:'body'}` section, chunked via existing `subChunk()`. If a free source pans out, execute T4–T10 subagent-driven.

### 2. Journal Calibration scorecard — brainstorm paused 1 question from done
- **Free, deterministic, no external API.** Builds on the shipped Journal (`journal_positions.conviction_at_open` 1–10; exit `journal_entries.outcome` right/wrong/mixed).
- **Locked decisions:** calibration-first; metric = **conviction bucket → outcome rate** (low 1–4 / med 5–7 / high 8–10, % right/wrong/mixed per band); calibrated = higher conviction → higher right-rate.
- **Open question:** which v1 dimensions beyond the core conviction breakdown — hold-time accuracy, outcome-trend-over-time, per-sector/per-ticker right-rate.
- No spec written yet. Resume at the dimensions question, then approaches → design → spec → plan → execute.

## Suggested next directions

- **Complete the B1 country backfill** (quick): once FRED's per-IP limit resets, run `pnpm seed-countries` (prod) to fill JP/AU/KR + EM macro series; confirm `FRED_API_KEY` is in **Vercel env** so the weekly cron is clean.
- **Next global-macro slice:** A2 (yield-curve + central-bank tracker) or A3/A4/A5 — foundation is in place and reusable.
- **Resume a parked thread** (transcripts data-source decision, or the journal-calibration dimensions question).
- **Optional polish:** source current per-country CPI indexes to make B1's inflation dimension non-US (best-effort gap); add the `macro_freshness` RLS test (Minor gap flagged in A1 review).
