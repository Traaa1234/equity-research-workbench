# Session Context Snapshot — 2026-06-07 (for resume after /clear)

**State:** working tree clean, master in sync with `origin/master` (HEAD `2851760`), all work pushed to `Traaa1234/equity-research-workbench`. Companion server stopped. Nothing in flight.

**Read this first, then `docs/superpowers/SESSION-HANDOFF-2026-06-03.md`** — that handoff is the canonical resume doc (conventions, full feature inventory, parked threads, next directions, the shared-store rule). This file is just the "where we are right now" pointer.

## What this (very long) session shipped — 4 global-macro slices, all live on Vercel

| Slice | Route | Spec / Plan (in `docs/superpowers/`) |
|---|---|---|
| **A1** Macro weather dashboard | `/macro` | `specs|plans/2026-06-03-macro-weather-dashboard*` |
| **B1** Country scorecard | `/macro/countries` | `…/2026-06-03-country-scorecard*` |
| **A2a** Yield-curve detail | `/macro/curve` | `…/2026-06-03-yield-curve*` |
| **A3a** Cross-asset correlation matrix | `/macro/correlations` | `…/2026-06-03-correlation-matrix*` |

All share the **`macro_series` + `macro_freshness`** store (no new tables since migration `0016`). ~60 commits, all CI-green, direct-to-master.

## Workflow used (reproduce it for the next slice)

`superpowers:brainstorming` (with the visual companion for layout questions; START by flagging scope/decomposition) → spec in `docs/superpowers/specs/` → `superpowers:writing-plans` → `superpowers:subagent-driven-development` (fresh implementer subagent per task + spec-compliance review + code-quality review per task; fix loops; final holistic review) → `superpowers:finishing-a-development-branch` → push. **Direct commit to master**, trailer exactly `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

## Open items / loose ends (carried in the handoff)

1. **B1 country backfill is PARTIAL** — DM core + all 16 ETFs landed; JP/AU/KR + EM macro series 429'd from hammering FRED. The key is valid; rerun `pnpm seed-countries` (prod) once FRED's per-IP limit resets, or let the weekly cron fill it.
2. **`FRED_API_KEY`** — valid + present in `.env.local`. **Confirm it's also set in Vercel env** so the deployed `macro`/`countries`/`curve` crons use the unthrottled keyed JSON API.
3. **A3a SPY weekly-lag (optional polish)** — SPY refreshes weekly (B1 countries cron) while the other 6 correlation series are daily; the equity leg can lag ~6 trading days (honest `asOf` shown). Fix: add SPY to the daily `macro` refresh.
4. **Verify the latest Vercel deploy is green** for all 4 slices (last push `2851760`).

## Next-step menu (all foundation-reusable)

- **A3b** regime read (risk-on/off classification; builds on A3a's correlations) · **A2b** central-bank calendar (free-data-source question) · **A4** sector-rotation map (needs A3b + daily sector ETFs) · **A5** macro event calendar (free-data-source question).
- **Parked threads** (unchanged): Earnings Transcripts (blocked on free data source — decision pending) · Journal Calibration scorecard (brainstorm paused at the v1-dimensions question).

## Condensed gotchas (full versions in the handoff)

- **Shared store:** new slices reusing `macro_series` MUST filter their reads (`inArray(... own ids)`) so `asOf`/stale banners stay accurate.
- **FRED keyless 429s:** services space requests via `fredDelayMs` (default 500ms, `0` in tests); a valid `FRED_API_KEY` removes them.
- **Conventions:** `numeric` reads back as string → `Number(...)`; no `bigserial` on the wire (composite PKs); migrations via `pnpm db:generate` → apply to BOTH Neon branches; RLS `9xxx_` via `_apply.ts`; pure tests `tests/compute|providers`, DB tests `tests/integration` (Neon test branch); authed Playwright E2E all `test.skip`.
- **Flake:** `tests/integration/transcripts-schema.test.ts` can intermittently deadlock on TRUNCATE — re-run once if it's the only failure.
- **Machine note:** memory-tight host — `pnpm typecheck`/`build` occasionally OOM; just re-run.
