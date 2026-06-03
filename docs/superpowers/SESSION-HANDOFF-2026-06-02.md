# Session Handoff — 2026-06-02

Purpose: let a fresh session resume cheaply. Read this first, then the specific
spec/plan files referenced below as needed.

## Project

**Equity Research Workbench** — Next.js 14 (App Router) + TypeScript strict
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Drizzle ORM + Neon
Postgres + pgvector (HNSW), Stack Auth, Tailwind/shadcn. Deployed on Vercel.
Repo: `Traaa1234/equity-research-workbench` (public). Package manager: `pnpm`.

## Conventions (IMPORTANT — follow these)

- **Direct commit to master** is the established flow (no PR). Never force-push, never `--no-verify`, never bypass signing.
- **Commit trailer, exactly:** `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
- **Migrations:** numbered drizzle SQL applied via `pnpm db:migrate` (= `scripts/migrate.ts`, which skips files starting with `9` and tracks applied hashes in `public.__drizzle_migrations` — already seeded with all hashes on both branches). RLS files use a `9xxx_` prefix and are applied separately via the repo-root `_apply.ts` (`pnpm exec tsx _apply.ts --target test|prod --file <path>`). `psql` is NOT installed. Never `drizzle-kit push --force`.
- **RLS patterns:** catalog tables (filings, chunk_embeddings, transcripts) = `for select to authenticated using(true)`; user-scoped tables (qa_history, journal_*) = `using (user_id::text = current_setting('request.jwt.claim.sub', true))`. Writes go through service_role (BYPASSRLS).
- **drizzle 0.45 gotcha:** RLS-blocked writes throw `DrizzleQueryError` wrapping the PostgresError in `.cause` — tests must inspect `error.message + String(error.cause)`, not just `.message`.
- **BigInt serialization:** drizzle `bigserial` ids are `bigint`; `NextResponse.json` throws on them. Use a `ser()` helper: `JSON.parse(JSON.stringify(v, (_k,val)=> typeof val==='bigint'?val.toString():val))`. (ids go over the wire as strings — UIs use `String(id)`.)
- **Provider pattern:** external data via Python subprocess (`scripts/*_fetch.py` + `api/fallback/*.py` Vercel wrapper) — yfinance, EDGAR. yfinance is primary, Financial Datasets is fallback.
- **Test branches:** integration tests run against a dedicated Neon test branch (`makeTestServiceDb`/`makeTestUserDb` in `tests/helpers/test-db.ts`). Authed Playwright E2E specs are all `test.skip` pending a Stack Auth ESM fixture fix — write them skipped, matching the pattern.
- **Execution flow:** brainstorm (superpowers:brainstorming) → spec in `docs/superpowers/specs/` → plan in `docs/superpowers/plans/` → execute subagent-driven (fresh subagent per task + spec-compliance then code-quality review). Schema/RLS/pure-compute tasks verified inline; logic-heavy tasks (services, routes) get full review.

## Shipped feature inventory

Single-ticker (`/stock/[TICKER]` tabs): Overview, **Journal** (new), Financials,
Technical, News(+sentiment), Insiders, Holdings(13F), Filings(+AI summaries+tables),
Quality(Piotroski/Altman/Beneish), **Peers** (new), Ask(RAG over filings).
Watchlist (`/watchlist`): Roll-up, Discover(semantic NL search over universe),
Search(over filings), Ask. Plus: cron refresh, add-ticker, health, CI.

**Universe seeder:** COMPLETE — ~6,300 of ~6,500 tickers have descriptions +
1024-d embeddings (`companies_universe`). Discovery + Peers work across the full
universe. Each `companies_universe` row has ticker/name/country/sector/industry/
market_cap/embedding — useful for any country-level feature.

## Parked threads (resume points)

### 1. Earnings Transcripts slice — BLOCKED on a free data source
- **Done:** T1 (schema: `transcripts`, `transcript_chunks`, `transcript_freshness`) + T2 (RLS), both Neon branches. Source-agnostic; dormant tables, harmless.
- **Spec/plan:** `docs/superpowers/specs/2026-05-29-earnings-transcripts-design.md` + `.../plans/2026-05-29-earnings-transcripts.md` (both have revision boxes at top).
- **Source saga:** Motley Fool (scraping-blocked: UA-gating + JS body) → EarningsCall (free key unclear) → API Ninjas (confirmed live: transcript endpoint is **premium-only**, ~$39/mo). All re-sources are pure-TS (plain REST GET) — no Python needed; provider returns full text as one `{kind:'body', speaker:'', role:null}` section, chunked via existing `subChunk()` (Slice 2C). Widen `TranscriptSection['kind']` to include `'body'`.
- **Decision pending (user):** (A) test discountingcashflows.com free key (`/api/transcript/?ticker=AAPL&quarter=Q4&year=2023&key=…`) — last credible $0 shot; (B) pay $39/mo API Ninjas Developer; (C) shelve. If a free source pans out, re-spec is trivial (swap the REST URL/auth in the provider) and execute T4–T10 subagent-driven.

### 2. Journal Calibration scorecard — brainstorm paused 1 question from done
- **Free, deterministic, no external API.** Builds on the shipped Journal (`journal_positions.conviction_at_open` 1–10; exit `journal_entries.outcome` right/wrong/mixed).
- **Locked decisions:** calibration-first (AI thesis review = separate later slice); metric = **conviction bucket → outcome rate** (low 1–4 / med 5–7 / high 8–10, % right/wrong/mixed per band); calibrated = higher conviction → higher right-rate.
- **Open question:** which v1 dimensions beyond the core conviction breakdown — hold-time accuracy (expected vs actual days held), outcome-trend-over-time, per-sector/per-ticker right-rate. (User was answering this when we pivoted.)
- No spec written yet. Resume at the dimensions question, then approaches → design → spec → plan → execute.

## New intent: Global Macro Strategy tooling (brainstorm fresh)

A **top-down, cross-asset** lens — distinct from the current bottom-up single-stock
workbench. Likely a new product surface; the brainstorm should START with
scope/decomposition (it may be several sub-slices). **Data is mostly FREE:**
FRED API (rates, inflation, employment, yields, money supply — the gold standard,
free key) + yfinance (FX pairs, commodity/index ETFs, VIX).

Candidate tools to react to (not yet scoped):
- **Cross-asset "macro weather" dashboard** — 2s10s curve, DXY (dollar), gold/oil, credit spreads, VIX at a glance.
- **Regime detection** — risk-on/risk-off classification from cross-asset co-movement.
- **Country scorecard** — rank countries by growth/inflation/policy/valuation; leverages the already-seeded multi-country universe.
- **Yield-curve + central-bank tracker** — curve shape/inversion + Fed/ECB/BoJ decision calendar.
- **Cross-asset correlation/regime matrix** — how stocks/bonds/gold/dollar co-move now vs history.
- **Macro event calendar** — CPI/NFP/FOMC with historical market reactions.
- **Sector-rotation map** — which sectors lead in which regime.

Recommended first step in the fresh session: invoke `superpowers:brainstorming`,
flag scope/decomposition immediately (this is big), pick ONE sub-slice (likely the
cross-asset dashboard or country scorecard) to design first.
