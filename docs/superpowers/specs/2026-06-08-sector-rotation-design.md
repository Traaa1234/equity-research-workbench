# A4 Sector Rotation Map — Design Spec

**Date:** 2026-06-08  
**Route:** `/macro/sectors`  
**Slice:** A4 (Global Macro Strategy)  
**Status:** Approved — ready for implementation planning

---

## 1. Overview

A sortable performance heatmap showing the 11 SPDR sector ETFs across five return windows (1D / 1W / 1M / 3M / 1Y) plus an excess-return column vs SPY. Pure momentum — no regime overlay. Reuses the `macro_series` + `macro_freshness` store and `YFinanceProvider.pricesBatch()` with no new migrations or RLS files.

**Side-effect benefit:** including SPY in the daily sectors refresh fixes the A3a correlation matrix's SPY-weekly-lag issue.

---

## 2. Sectors & Symbols

| Symbol | Sector Label | Short Label |
|--------|-------------|-------------|
| XLK | Technology | Tech |
| XLF | Financials | Fin |
| XLV | Health Care | Health |
| XLY | Consumer Discretionary | Cons Disc |
| XLP | Consumer Staples | Staples |
| XLE | Energy | Energy |
| XLI | Industrials | Indus |
| XLU | Utilities | Util |
| XLB | Materials | Materials |
| XLRE | Real Estate | REITS |
| XLC | Communication Services | Comm |
| SPY | *(benchmark — daily-refreshed, not displayed as a sector row)* | — |

All 12 symbols fetched via `YFinanceProvider.pricesBatch()` in a single call per refresh run.

---

## 3. Data & Storage

- **Store:** `macro_series` (composite PK `(series_id, obs_date)`) + `macro_freshness`. No new migration. No new RLS file (existing `9990_rls_macro_series.sql` covers catalog tables including this one).
- **Upsert is idempotent** with B1 (which already has SPY as the US ETF). The sectors cron making SPY daily-fresh is a harmless improvement.
- **Shared-store rule:** `SectorRotationService` reads filter with `inArray(macroSeries.seriesId, SECTOR_SERIES_IDS)` (including `'SPY'`) so `asOf` / stale banners stay accurate.

---

## 4. Compute Layer

### 4.1 `lib/compute/sector-registry.ts`

```ts
export interface SectorDef {
  seriesId: string;    // yfinance symbol
  label: string;       // full label, e.g. 'Technology'
  shortLabel: string;  // narrow-column label, e.g. 'Tech'
  isBenchmark?: true;  // SPY only — excluded from display rows
}

export const SECTOR_REGISTRY: SectorDef[] = [ /* 11 sectors + SPY */ ];

export function sectorSeriesIds(): string[] { /* all 12 ids */ }
export function displaySectors(): SectorDef[] { /* 11, excluding benchmark */ }
```

### 4.2 `lib/compute/sector-analytics.ts`

Pure functions — no DB, no providers, fully unit-testable.

```ts
export interface PricePoint { date: string; value: number }

/**
 * Return (prices[last] / prices[last - windowOffset]) - 1 using a
 * data-point offset into the sorted (ascending) price array.
 * yfinance prices are trading-day-only, so an offset of N means
 * "N trading days ago" — do NOT use calendar date arithmetic.
 * windowOffset: 1=1D, 5=1W, 21=1M, 63=3M, 252=1Y
 * Returns null when array length ≤ windowOffset, or when the
 * reference price is zero.
 */
export function periodReturn(prices: PricePoint[], windowOffset: number): number | null

/**
 * Excess return: sectorRet - benchmarkRet. Null if either is null.
 */
export function relativeReturn(sectorRet: number | null, benchmarkRet: number | null): number | null

/**
 * Compute returns for all symbols over all windows.
 * Uses the latest date present in ALL series as the "as-of" anchor
 * (date-intersection discipline — same as A3a).
 */
export function sectorReturns(
  allPrices: Record<string, PricePoint[]>,
  windows: Record<string, number>,  // trading-day offsets: { '1D': 1, '1W': 5, '1M': 21, '3M': 63, '1Y': 252 }
): Record<string, Record<string, number | null>>
```

### 4.3 `lib/services/sector-rotation.ts`

```ts
export type ReturnWindow = '1D' | '1W' | '1M' | '3M' | '1Y';

export interface SectorRow {
  seriesId: string;
  label: string;
  shortLabel: string;
  latestPrice: number | null;
  priceDate: string | null;
  returns: Record<ReturnWindow, number | null>;
  vsSpy: Record<ReturnWindow, number | null>;
}

export interface SectorData {
  sectors: SectorRow[];   // 11 rows, default sorted by 1M return desc
  asOf: string | null;    // latest priceDate across the batch
  stale: boolean;         // true if asOf > 2 trading days ago
}

export class SectorRotationService {
  constructor(private deps: { db: ServiceDb; yf?: YFinanceProvider })

  /** Fetch via pricesBatch → upsert macro_series + macro_freshness. */
  async refreshAll(mode: 'daily' | 'backfill'): Promise<{ ok: number; failed: number }>

  /** Read from DB, compute returns, return SectorData. */
  async getSectors(): Promise<SectorData>
}
```

`refreshAll` uses `'1Y'` range for daily mode and `'5Y'` for backfill (same as `CountryScorecardService`).

---

## 5. API Routes

**`app/api/sectors/route.ts`** — `GET /api/sectors`

- `export const dynamic = 'force-dynamic'`
- Calls `SectorRotationService.getSectors()`
- Returns `SectorData` as JSON (no bigserial on the wire; numeric strings → `Number(...)` per convention)
- Primary path is server-rendered; route exists for client-side revalidation if needed

**`app/api/sectors/[seriesId]/route.ts`** — `GET /api/sectors/{seriesId}`

- Same pattern as `app/api/macro/[seriesId]/route.ts`
- Reads full price history from `macro_series` for the given `seriesId` (must be one of the 11 sector ETF ids — 404 otherwise)
- Returns `{ seriesId, label, history: PricePoint[] }` as JSON
- Used by `<SectorDetail>` drawer to load the Recharts history chart

---

## 6. UI

### 6.1 Page — `app/(app)/macro/sectors/page.tsx`

Server component:
```tsx
export const dynamic = 'force-dynamic';
export default async function SectorsPage() {
  await requireUserId();
  const data = await new SectorRotationService({ db: getServiceDb() }).getSectors();
  return (
    <main className="container mx-auto px-4 py-6">
      <h1 className="text-xl font-semibold tracking-tight mb-4">Sector Rotation</h1>
      <SectorTable data={data} />
    </main>
  );
}
```

Empty state (all prices null): "No sector data yet. Run `pnpm seed-sectors` to backfill, then the daily cron keeps it fresh."

### 6.2 Table — `app/(app)/macro/sectors/_components/sector-table.tsx`

Client component (`'use client'`). State: `sortCol` (default `'1M'`), `sortDir` (default `'desc'`), `open: string | null` (seriesId of drawer).

**Columns:** Sector | Price | 1D | 1W | **1M** | 3M | 1Y | vs SPY

- The **vs SPY** column tracks whichever return window column is currently selected for sorting (e.g., sort by 3M → vs SPY column shows vs-SPY 3M). Column header reflects this: "vs SPY (1M)" → "vs SPY (3M)" etc.
- Clicking any return column header sorts by that window; clicking the active column header toggles asc/desc.
- **Cell coloring thresholds:**
  - Return cells: green ≥ +0.5% / amber −0.5% to +0.5% / red ≤ −0.5%
  - vs-SPY cells: same thresholds (positive = outperforming benchmark)
- Stale banner when `data.stale`; as-of footnote below the table.
- Row click → `<SectorDetail seriesId={row.seriesId} onClose={...} />`

### 6.3 Drawer — `app/(app)/macro/sectors/_components/sector-detail.tsx`

Radix Dialog (same shell as `macro-detail.tsx` / `curve-detail.tsx`):
- `GET /api/sectors/{seriesId}` — fetches full price history for the drawer  
  *(separate route `app/api/sectors/[seriesId]/route.ts`, same pattern as `/api/macro/[seriesId]`)*
- Recharts `LineChart` — full price history, toggle 1Y / 3Y / 5Y
- Return summary strip: 1D / 1W / 1M / 3M / 1Y badges (green/amber/red)
- vs-SPY strip for the same windows

### 6.4 Nav

Add "Sectors" to the macro nav group in `app/(app)/_components/nav.tsx`, alongside Curve / Correlations / Countries.

---

## 7. Refresh Infrastructure

### 7.1 `lib/ingest/refresh-runner.ts`

- Add `'sectors'` to `RefreshKind` union
- Add `sectorSvc?: SectorRotationService` to `Deps`
- Handle `kind === 'sectors'` as a short-circuit (same pattern as `'macro'`, `'curve'`):
  ```ts
  if (kind === 'sectors') {
    const summary = await deps.sectorSvc!.refreshAll('daily');
    // record run, return
  }
  ```

### 7.2 `app/api/cron/refresh/route.ts`

Wire `SectorRotationService` into the deps object (inject `yf` provider).

### 7.3 `vercel.json`

```json
{ "path": "/api/cron/refresh?kind=sectors", "schedule": "30 22 * * *" }
```

`app/api/cron/refresh/route.ts` already has `maxDuration: 60` — no change needed there.

### 7.4 `scripts/seed-sectors.ts`

```ts
// One-off 5yr backfill
await new SectorRotationService({ db, yf }).refreshAll('backfill');
```

### 7.5 `package.json`

```json
"seed-sectors": "tsx scripts/seed-sectors.ts"
```

---

## 8. Testing

### 8.1 Pure tests — `tests/compute/sector-analytics.test.ts`

- `periodReturn`: correct value over each window; null when < 2 obs; null when price is 0
- `relativeReturn`: correct excess; null when either leg null
- `sectorReturns`: correct per-symbol return map given fixture price series; date-intersection anchor

### 8.2 Integration tests — `tests/integration/sector-rotation.test.ts`

- `refreshAll` — upserts rows into `macro_series` + `macro_freshness` on the Neon test branch (fake `YFinanceProvider` injected)
- `getSectors` — reads back, returns correct `SectorRow[]` shape
- `getSectors` with no data — returns empty sectors, null asOf, stale false

### 8.3 E2E

One `test.skip` Playwright spec for the `/macro/sectors` happy path (matching the existing skipped pattern).

---

## 9. Conventions Checklist

- `numeric` DB reads → `Number(...)` before arithmetic
- No `bigserial` on the wire (composite PK — no issue)
- Migrations: none needed
- RLS: existing `9990_rls_macro_series.sql` covers this — no new file
- `macro_series` reads scoped with `inArray(... SECTOR_SERIES_IDS)` per shared-store rule
- Authed E2E → `test.skip`
- Direct commit to master; trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
