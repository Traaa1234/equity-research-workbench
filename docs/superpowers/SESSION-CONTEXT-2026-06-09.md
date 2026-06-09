# Session Context — 2026-06-09

## Where We Are Now

**HEAD:** `9c625cb` — feat(sectors): cron wiring, seed script, vercel.json — A4 complete  
**Branch:** `master` (direct commits, pushed to origin)  
**Vercel:** 15 commits pushed this session; deploy should be green

## What Shipped This Session — A4 Sector Rotation Map

Full implementation of `/macro/sectors`:
- Sortable heatmap of 11 SPDR sector ETFs × 1D/1W/1M/3M/1Y return windows vs SPY
- Price-history drawer (Radix Dialog + Recharts LineChart, 1Y/3Y/5Y range toggle)
- Pure yfinance data via `pricesBatch`, stored in `macro_series` + `macro_freshness`
- Daily cron at 22:30 UTC (`/api/cron/refresh?kind=sectors`)
- Seed script: `pnpm seed-sectors` (uses 5Y backfill mode)

**Key files added:**
- `lib/compute/sector-registry.ts` — 11 ETFs + SPY benchmark
- `lib/compute/sector-analytics.ts` — periodReturn / relativeReturn / sectorReturns
- `lib/services/sector-rotation.ts` — SectorRotationService
- `app/api/sectors/route.ts` + `app/api/sectors/[seriesId]/route.ts`
- `app/(app)/macro/sectors/page.tsx` + `_components/sector-table.tsx` + `_components/sector-detail.tsx`
- `scripts/seed-sectors.ts`

## Immediate Next Step

Run the prod seed (yfinance, 5yr backfill for all 12 symbols):
```bash
DATABASE_URL=$DATABASE_URL_SERVICE_ROLE pnpm seed-sectors
```
Then verify `/macro/sectors` renders on prod.

## Open Items

| Item | Status |
|------|--------|
| A4 Sector Rotation | ✅ Shipped |
| FRED_API_KEY in Vercel env | ✅ Confirmed set |
| B1 country backfill (partial) | ⚠️ Rerun `pnpm seed-countries` if needed |
| A3a SPY weekly lag | ✅ Fixed as side effect — sectors cron refreshes SPY daily |
| A3b Regime Detection | Not started (not needed for A4) |
| E2E auth fixture | ⚠️ All authed E2E specs `test.skip` pending Stack Auth ESM fix |

## Slices Shipped (Cumulative)

- A1 Macro Dashboard (yield curve, macro series)
- A2 Yield Curve detail
- A3a Correlation Matrix
- B1 Country Scorecard
- **A4 Sector Rotation Map** ← this session

## Conventions (unchanged)

- Direct commit to master — never force-push, never --no-verify
- Commit trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
- Migrations to BOTH Neon branches; RLS via `_apply.ts`
- `inArray()` scoping for all shared-store reads — critical
- `numeric` DB column → `Number(r.value)` before arithmetic
- `pnpm typecheck`/`build` may OOM on this host — re-run once
- Authed Playwright E2E always `test.skip`
- Integration test flake: `transcripts-schema.test.ts` can deadlock on TRUNCATE — re-run once if sole failure
