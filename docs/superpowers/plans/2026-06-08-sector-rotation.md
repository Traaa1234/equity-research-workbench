# A4 Sector Rotation Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/macro/sectors` — a sortable performance heatmap for the 11 SPDR sector ETFs across 1D/1W/1M/3M/1Y return windows plus a vs-SPY column, with a price-history drawer per sector.

**Architecture:** Pure yfinance data (pricesBatch) upserted into the existing `macro_series` store; pure-TS compute layer (registry + analytics) consumed by a service class; server-rendered Next.js page with a client-side sortable table and Radix dialog drawer. No new DB migration or RLS file.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Drizzle ORM + Neon Postgres, Recharts, Radix UI Dialog, Tailwind/shadcn, Vitest, Playwright (skipped).

---

## File Map

**Create:**
- `lib/compute/sector-registry.ts` — 11 sectors + SPY benchmark config
- `lib/compute/sector-analytics.ts` — `periodReturn`, `relativeReturn`, `sectorReturns`, `WINDOWS`
- `lib/services/sector-rotation.ts` — `SectorRotationService` (`refreshAll`, `getSectors`, `getSeriesHistory`)
- `app/api/sectors/route.ts` — `GET /api/sectors`
- `app/api/sectors/[seriesId]/route.ts` — `GET /api/sectors/:id?range=`
- `app/(app)/macro/sectors/page.tsx` — server component
- `app/(app)/macro/sectors/_components/sector-table.tsx` — client sortable heatmap
- `app/(app)/macro/sectors/_components/sector-detail.tsx` — Radix drawer + Recharts
- `scripts/seed-sectors.ts` — one-off 5yr backfill
- `tests/compute/sector-analytics.test.ts` — pure unit tests
- `tests/integration/sector-rotation-service.test.ts` — DB integration tests
- `tests/e2e/sectors.spec.ts` — skipped Playwright spec

**Modify:**
- `lib/ingest/refresh-runner.ts` — add `'sectors'` kind + `sectorSvc` dep
- `app/api/cron/refresh/route.ts` — wire `SectorRotationService`
- `vercel.json` — add sectors cron entry
- `package.json` — add `seed-sectors` script
- `app/(app)/_components/nav.tsx` — add "Sectors" link

---

## Task 1: Sector Registry

**Files:**
- Create: `lib/compute/sector-registry.ts`
- Create: `tests/compute/sector-registry.test.ts`

- [ ] **Step 1: Create the registry**

```ts
// lib/compute/sector-registry.ts
export interface SectorDef {
  seriesId: string;
  label: string;
  shortLabel: string;
  isBenchmark?: true;
}

export const SECTOR_REGISTRY: SectorDef[] = [
  { seriesId: 'XLK',  label: 'Technology',             shortLabel: 'Tech'      },
  { seriesId: 'XLF',  label: 'Financials',             shortLabel: 'Fin'       },
  { seriesId: 'XLV',  label: 'Health Care',            shortLabel: 'Health'    },
  { seriesId: 'XLY',  label: 'Consumer Discretionary', shortLabel: 'Cons Disc' },
  { seriesId: 'XLP',  label: 'Consumer Staples',       shortLabel: 'Staples'   },
  { seriesId: 'XLE',  label: 'Energy',                 shortLabel: 'Energy'    },
  { seriesId: 'XLI',  label: 'Industrials',            shortLabel: 'Indus'     },
  { seriesId: 'XLU',  label: 'Utilities',              shortLabel: 'Util'      },
  { seriesId: 'XLB',  label: 'Materials',              shortLabel: 'Materials' },
  { seriesId: 'XLRE', label: 'Real Estate',            shortLabel: 'REITs'     },
  { seriesId: 'XLC',  label: 'Communication Services', shortLabel: 'Comm'      },
  { seriesId: 'SPY',  label: 'S&P 500',                shortLabel: 'SPY', isBenchmark: true },
];

/** All 12 series ids (11 sectors + SPY benchmark). */
export function sectorSeriesIds(): string[] {
  return SECTOR_REGISTRY.map((s) => s.seriesId);
}

/** 11 display sectors — excludes the SPY benchmark row. */
export function displaySectors(): SectorDef[] {
  return SECTOR_REGISTRY.filter((s) => !s.isBenchmark);
}
```

- [ ] **Step 2: Write the registry test**

```ts
// tests/compute/sector-registry.test.ts
import { describe, it, expect } from 'vitest';
import { SECTOR_REGISTRY, sectorSeriesIds, displaySectors } from '@/lib/compute/sector-registry';

describe('sector-registry', () => {
  it('has 12 entries (11 sectors + SPY benchmark)', () => {
    expect(SECTOR_REGISTRY).toHaveLength(12);
  });
  it('sectorSeriesIds() returns all 12 symbols', () => {
    expect(sectorSeriesIds()).toHaveLength(12);
    expect(sectorSeriesIds()).toContain('SPY');
    expect(sectorSeriesIds()).toContain('XLK');
  });
  it('displaySectors() returns exactly 11, no benchmark', () => {
    const display = displaySectors();
    expect(display).toHaveLength(11);
    expect(display.every((s) => !s.isBenchmark)).toBe(true);
    expect(display.some((s) => s.seriesId === 'SPY')).toBe(false);
  });
  it('no duplicate seriesIds', () => {
    const ids = sectorSeriesIds();
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 3: Run the test**

```bash
pnpm test tests/compute/sector-registry.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/compute/sector-registry.ts tests/compute/sector-registry.test.ts
git commit -m "feat(sectors): sector registry (11 ETFs + SPY benchmark)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Sector Analytics (TDD)

**Files:**
- Create: `lib/compute/sector-analytics.ts`
- Create: `tests/compute/sector-analytics.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/compute/sector-analytics.test.ts
import { describe, it, expect } from 'vitest';
import { periodReturn, relativeReturn, sectorReturns, WINDOWS } from '@/lib/compute/sector-analytics';

const pts = (vals: number[]) =>
  vals.map((value, i) => ({ date: `2026-${String(i + 1).padStart(2, '0')}-01`, value }));

describe('periodReturn', () => {
  it('computes (last / prev) - 1 for offset 1', () => {
    // prices[2]=105, prices[1]=102 → (105/102)-1
    expect(periodReturn(pts([100, 102, 105]), 1)).toBeCloseTo((105 / 102) - 1);
  });
  it('computes larger offsets correctly', () => {
    // prices[4]=110, prices[0]=100 → (110/100)-1 = 0.1
    expect(periodReturn(pts([100, 102, 104, 106, 110]), 4)).toBeCloseTo(0.1);
  });
  it('returns null when array length <= windowOffset', () => {
    expect(periodReturn(pts([100, 101]), 2)).toBeNull();
    expect(periodReturn(pts([100]), 1)).toBeNull();
    expect(periodReturn([], 1)).toBeNull();
  });
  it('returns null when reference price is 0', () => {
    expect(periodReturn(pts([0, 100]), 1)).toBeNull();
  });
});

describe('relativeReturn', () => {
  it('subtracts benchmarkRet from sectorRet', () => {
    expect(relativeReturn(0.05, 0.03)).toBeCloseTo(0.02);
    expect(relativeReturn(-0.02, 0.01)).toBeCloseTo(-0.03);
  });
  it('returns null when sectorRet is null', () => {
    expect(relativeReturn(null, 0.03)).toBeNull();
  });
  it('returns null when benchmarkRet is null', () => {
    expect(relativeReturn(0.05, null)).toBeNull();
  });
  it('returns null when both are null', () => {
    expect(relativeReturn(null, null)).toBeNull();
  });
});

describe('sectorReturns', () => {
  it('computes returns for all symbols over all windows', () => {
    // 3 prices → can compute 1D (offset 1) and 2D (offset 2)
    const prices = pts([100, 102, 105]);
    const result = sectorReturns({ XLK: prices, XLF: prices }, { '1D': 1, '2D': 2 });
    expect(result['XLK']).toBeDefined();
    expect(result['XLK']!['1D']).toBeCloseTo((105 / 102) - 1);
    expect(result['XLK']!['2D']).toBeCloseTo((105 / 100) - 1);
    expect(result['XLF']!['1D']).toBeCloseTo((105 / 102) - 1);
  });
  it('returns null for windows wider than available data', () => {
    const result = sectorReturns({ XLK: pts([100, 101]) }, { '1Y': 252 });
    expect(result['XLK']!['1Y']).toBeNull();
  });
  it('handles empty price array gracefully', () => {
    const result = sectorReturns({ XLK: [] }, WINDOWS);
    expect(Object.values(result['XLK']!).every((v) => v === null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect failures (module not found)**

```bash
pnpm test tests/compute/sector-analytics.test.ts
```

Expected: All tests fail with "Cannot find module".

- [ ] **Step 3: Implement sector-analytics.ts**

```ts
// lib/compute/sector-analytics.ts
export interface PricePoint { date: string; value: number }

export type ReturnWindow = '1D' | '1W' | '1M' | '3M' | '1Y';

/** Trading-day offsets for each return window. */
export const WINDOWS: Record<ReturnWindow, number> = {
  '1D': 1,
  '1W': 5,
  '1M': 21,
  '3M': 63,
  '1Y': 252,
};

/**
 * Return (prices[last] / prices[last - windowOffset]) - 1.
 * Uses trading-day offset (array index), NOT calendar-date arithmetic.
 * Returns null when prices.length <= windowOffset or reference price is 0.
 */
export function periodReturn(prices: PricePoint[], windowOffset: number): number | null {
  if (prices.length <= windowOffset) return null;
  const last = prices[prices.length - 1]!.value;
  const prev = prices[prices.length - 1 - windowOffset]!.value;
  if (prev === 0) return null;
  return (last / prev) - 1;
}

/**
 * Excess return: sectorRet - benchmarkRet.
 * Returns null if either input is null.
 */
export function relativeReturn(
  sectorRet: number | null,
  benchmarkRet: number | null,
): number | null {
  if (sectorRet == null || benchmarkRet == null) return null;
  return sectorRet - benchmarkRet;
}

/**
 * Compute returns for every symbol over every window.
 * windows is a map of label → trading-day offset, e.g. { '1D': 1, '1W': 5, ... }.
 * Each symbol's returns are computed independently from its own price array.
 */
export function sectorReturns(
  allPrices: Record<string, PricePoint[]>,
  windows: Record<string, number>,
): Record<string, Record<string, number | null>> {
  const result: Record<string, Record<string, number | null>> = {};
  for (const [sym, prices] of Object.entries(allPrices)) {
    result[sym] = {};
    for (const [label, offset] of Object.entries(windows)) {
      result[sym]![label] = periodReturn(prices, offset);
    }
  }
  return result;
}
```

- [ ] **Step 4: Run — expect all pass**

```bash
pnpm test tests/compute/sector-analytics.test.ts
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/compute/sector-analytics.ts tests/compute/sector-analytics.test.ts
git commit -m "feat(sectors): sector analytics — periodReturn / relativeReturn / sectorReturns (TDD)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: SectorRotationService (Integration TDD)

**Files:**
- Create: `lib/services/sector-rotation.ts`
- Create: `tests/integration/sector-rotation-service.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/sector-rotation-service.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { SectorRotationService } from '@/lib/services/sector-rotation';
import type { YFinanceProvider } from '@/lib/providers/yfinance';

config({ path: '.env.local' });

// 7 price points per symbol — enough to exercise 1D (1) and 1W (5) windows.
function fakePriceSeries(baseClose: number) {
  return Array.from({ length: 7 }, (_, i) => ({
    date: `2026-06-0${i + 1}`,
    open: null, high: null, low: null,
    close: baseClose + i,
    adjClose: null, volume: null,
  }));
}

const fakeYf = {
  pricesBatch: async (symbols: string[]) =>
    Object.fromEntries(
      symbols.map((sym, i) => [sym, fakePriceSeries(100 + i)]),
    ),
} as unknown as YFinanceProvider;

describe('SectorRotationService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await dbH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`);
  });

  it('refreshAll upserts all 12 symbols (11 sectors + SPY)', async () => {
    const svc = new SectorRotationService({ db: dbH.db, yf: fakeYf });
    const r = await svc.refreshAll('daily');
    expect(r.ok).toBe(12);
    expect(r.failed).toBe(0);
  });

  it('getSectors returns 11 display rows with the expected shape', async () => {
    const svc = new SectorRotationService({ db: dbH.db, yf: fakeYf });
    await svc.refreshAll('daily');
    const data = await svc.getSectors();
    expect(data.sectors).toHaveLength(11);
    expect(data.asOf).not.toBeNull();
    // No SPY in display rows
    expect(data.sectors.some((s) => s.seriesId === 'SPY')).toBe(false);
    // 1D return is computable with 7 points
    const first = data.sectors[0]!;
    expect(first.returns['1D']).not.toBeNull();
    expect(first.vsSpy['1D']).not.toBeNull();
    // 1Y (252 offset) is null — only 7 price points
    expect(first.returns['1Y']).toBeNull();
  });

  it('getSectors with no data: 11 rows, null prices, null asOf, stale=false', async () => {
    const svc = new SectorRotationService({ db: dbH.db });
    const data = await svc.getSectors();
    expect(data.sectors).toHaveLength(11);
    expect(data.sectors.every((s) => s.latestPrice === null)).toBe(true);
    expect(data.asOf).toBeNull();
    expect(data.stale).toBe(false);
  });

  it('getSeriesHistory throws for an unknown seriesId', async () => {
    const svc = new SectorRotationService({ db: dbH.db });
    await expect(svc.getSeriesHistory('UNKNOWN', '1y')).rejects.toThrow();
  });

  it('getSeriesHistory returns price history for a valid sector', async () => {
    const svc = new SectorRotationService({ db: dbH.db, yf: fakeYf });
    await svc.refreshAll('daily');
    const detail = await svc.getSeriesHistory('XLK', '1y');
    expect(detail.seriesId).toBe('XLK');
    expect(detail.label).toBe('Technology');
    expect(detail.history.length).toBeGreaterThan(0);
    expect(detail.history[0]).toHaveProperty('date');
    expect(detail.history[0]).toHaveProperty('value');
  });
});
```

- [ ] **Step 2: Run — expect failures (module not found)**

```bash
pnpm test:integration tests/integration/sector-rotation-service.test.ts
```

Expected: All tests fail with "Cannot find module '@/lib/services/sector-rotation'".

- [ ] **Step 3: Implement sector-rotation.ts**

```ts
// lib/services/sector-rotation.ts
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { macroSeries, macroFreshness } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type { YFinanceProvider } from '@/lib/providers/yfinance';
import { NotFoundError } from '@/lib/providers/types';
import {
  SECTOR_REGISTRY, sectorSeriesIds, displaySectors,
} from '@/lib/compute/sector-registry';
import {
  sectorReturns, relativeReturn, WINDOWS,
  type PricePoint, type ReturnWindow,
} from '@/lib/compute/sector-analytics';
import { logger } from '@/lib/logger';

interface Deps { db: ServiceDb; yf?: YFinanceProvider }

export type { ReturnWindow };

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
  sectors: SectorRow[];  // 11 rows, default sorted by 1M return desc
  asOf: string | null;   // max latest date across the batch
  stale: boolean;        // true if asOf > 3 calendar days ago (~2 trading days)
}

function isoYearsAgo(y: number): string {
  const d = new Date(); d.setFullYear(d.getFullYear() - y); return d.toISOString().slice(0, 10);
}

function nullReturns(): Record<ReturnWindow, null> {
  return { '1D': null, '1W': null, '1M': null, '3M': null, '1Y': null };
}

export class SectorRotationService {
  constructor(private readonly deps: Deps) {}

  async refreshAll(mode: 'daily' | 'backfill'): Promise<{ ok: number; failed: number }> {
    if (!this.deps.yf) throw new Error('SectorRotationService.refreshAll requires yf');
    const range: '1Y' | '5Y' = mode === 'backfill' ? '5Y' : '1Y';
    let ok = 0, failed = 0;

    let batch: Record<string, Array<{ date: string; close: number }>>;
    try {
      batch = await this.deps.yf.pricesBatch(sectorSeriesIds(), range) as Record<string, Array<{ date: string; close: number }>>;
    } catch (err) {
      logger.error({ err: String(err) }, 'sector pricesBatch failed');
      // Mark all as failed
      for (const id of sectorSeriesIds()) {
        await this.upsertFresh(id, [], 'error', String(err).slice(0, 500));
        failed++;
      }
      return { ok, failed };
    }

    for (const id of sectorSeriesIds()) {
      const pts = batch[id] ?? [];
      const sp = pts.map((p) => ({ date: p.date, value: p.close }));
      try {
        await this.upsertPrices(id, sp);
        await this.upsertFresh(id, sp, 'ok', null);
        ok++;
      } catch (err) {
        logger.warn({ id, err: String(err) }, 'sector upsert failed');
        await this.upsertFresh(id, [], 'error', String(err).slice(0, 500)).catch(() => {});
        failed++;
      }
    }
    return { ok, failed };
  }

  private async upsertPrices(seriesId: string, points: PricePoint[]): Promise<void> {
    if (!points.length) return;
    await this.deps.db.insert(macroSeries)
      .values(points.map((p) => ({ seriesId, obsDate: p.date, value: String(p.value), source: 'yfinance' })))
      .onConflictDoUpdate({
        target: [macroSeries.seriesId, macroSeries.obsDate],
        set: { value: sql`excluded.value`, source: sql`excluded.source` },
      });
  }

  private async upsertFresh(seriesId: string, pts: PricePoint[], status: string, error: string | null): Promise<void> {
    await this.deps.db.insert(macroFreshness)
      .values({ seriesId, lastObsDate: pts.length ? pts[pts.length - 1]!.date : null, status, error })
      .onConflictDoUpdate({
        target: macroFreshness.seriesId,
        set: { lastFetchedAt: sql`now()`, lastObsDate: sql`excluded.last_obs_date`, status, error },
      });
  }

  async getSectors(): Promise<SectorData> {
    const ids = sectorSeriesIds();
    const rows = await this.deps.db
      .select()
      .from(macroSeries)
      .where(inArray(macroSeries.seriesId, ids))
      .orderBy(asc(macroSeries.obsDate));

    // Build per-symbol price arrays
    const allPrices: Record<string, PricePoint[]> = {};
    for (const r of rows) {
      (allPrices[r.seriesId] ??= []).push({ date: r.obsDate, value: Number(r.value) });
    }

    const allReturns = sectorReturns(allPrices, WINDOWS);
    const spyRets = allReturns['SPY'] ?? nullReturns();

    const sectors: SectorRow[] = displaySectors().map((def) => {
      const prices = allPrices[def.seriesId] ?? [];
      const last = prices.length ? prices[prices.length - 1]! : null;
      const rets = allReturns[def.seriesId] ?? nullReturns();
      const vsSpy: Record<ReturnWindow, number | null> = {
        '1D': relativeReturn(rets['1D'] ?? null, spyRets['1D'] ?? null),
        '1W': relativeReturn(rets['1W'] ?? null, spyRets['1W'] ?? null),
        '1M': relativeReturn(rets['1M'] ?? null, spyRets['1M'] ?? null),
        '3M': relativeReturn(rets['3M'] ?? null, spyRets['3M'] ?? null),
        '1Y': relativeReturn(rets['1Y'] ?? null, spyRets['1Y'] ?? null),
      };
      return {
        seriesId: def.seriesId,
        label: def.label,
        shortLabel: def.shortLabel,
        latestPrice: last ? last.value : null,
        priceDate: last ? last.date : null,
        returns: {
          '1D': rets['1D'] ?? null,
          '1W': rets['1W'] ?? null,
          '1M': rets['1M'] ?? null,
          '3M': rets['3M'] ?? null,
          '1Y': rets['1Y'] ?? null,
        },
        vsSpy,
      };
    });

    // Default sort: 1M return desc (nulls last)
    sectors.sort((a, b) => {
      const av = a.returns['1M'] ?? -Infinity;
      const bv = b.returns['1M'] ?? -Infinity;
      return bv - av;
    });

    // asOf = max latest priceDate across all sectors (from macroFreshness)
    const fresh = ids.length
      ? await this.deps.db.select().from(macroFreshness).where(inArray(macroFreshness.seriesId, ids))
      : [];
    const asOf = fresh.map((r) => r.lastObsDate).filter((d): d is string => !!d).sort().pop() ?? null;
    const stale = asOf ? Date.now() - new Date(asOf).getTime() > 3 * 864e5 : false;

    return { sectors, asOf, stale };
  }

  async getSeriesHistory(
    seriesId: string,
    range: '1y' | '3y' | '5y',
  ): Promise<{ seriesId: string; label: string; history: PricePoint[] }> {
    const def = SECTOR_REGISTRY.find((s) => s.seriesId === seriesId && !s.isBenchmark);
    if (!def) throw new NotFoundError(`Unknown sector series: ${seriesId}`);
    const yearsBack = range === '1y' ? 1 : range === '3y' ? 3 : 5;
    const since = isoYearsAgo(yearsBack);
    const rows = await this.deps.db
      .select()
      .from(macroSeries)
      .where(and(eq(macroSeries.seriesId, seriesId), sql`${macroSeries.obsDate} >= ${since}`))
      .orderBy(asc(macroSeries.obsDate));
    return {
      seriesId,
      label: def.label,
      history: rows.map((r) => ({ date: r.obsDate, value: Number(r.value) })),
    };
  }
}
```

- [ ] **Step 4: Run — expect all pass**

```bash
pnpm test:integration tests/integration/sector-rotation-service.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/services/sector-rotation.ts tests/integration/sector-rotation-service.test.ts
git commit -m "feat(sectors): SectorRotationService — refreshAll + getSectors + getSeriesHistory (TDD)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: API Routes + Integration Tests

**Files:**
- Create: `app/api/sectors/route.ts`
- Create: `app/api/sectors/[seriesId]/route.ts`
- Create: `tests/integration/api-sectors.test.ts`

- [ ] **Step 1: Create `app/api/sectors/route.ts`**

```ts
// app/api/sectors/route.ts
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { SectorRotationService } from '@/lib/services/sector-rotation';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireUserId();
    const svc = new SectorRotationService({ db: getServiceDb() });
    const data = await svc.getSectors();
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (err) {
    return errorResponse(err, { route: 'sectors' });
  }
}
```

- [ ] **Step 2: Create `app/api/sectors/[seriesId]/route.ts`**

```ts
// app/api/sectors/[seriesId]/route.ts
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { SectorRotationService } from '@/lib/services/sector-rotation';

export const dynamic = 'force-dynamic';

const RANGES = ['1y', '3y', '5y'] as const;
type Range = (typeof RANGES)[number];

interface Ctx { params: { seriesId: string } }

export async function GET(req: Request, ctx: Ctx) {
  try {
    await requireUserId();
    const seriesId = decodeURIComponent(ctx.params.seriesId);
    const rangeRaw = new URL(req.url).searchParams.get('range') ?? '1y';
    if (!RANGES.includes(rangeRaw as Range)) {
      throw new ValidationError(`range must be one of: ${RANGES.join(', ')}`);
    }
    const svc = new SectorRotationService({ db: getServiceDb() });
    const detail = await svc.getSeriesHistory(seriesId, rangeRaw as Range);
    return NextResponse.json(detail, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (err) {
    return errorResponse(err, { route: 'sectors/[seriesId]' });
  }
}
```

- [ ] **Step 3: Write the integration test**

```ts
// tests/integration/api-sectors.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { SectorRotationService } from '@/lib/services/sector-rotation';
import type { YFinanceProvider } from '@/lib/providers/yfinance';

config({ path: '.env.local' });

function fakePriceSeries(base: number) {
  return Array.from({ length: 7 }, (_, i) => ({
    date: `2026-06-0${i + 1}`,
    open: null, high: null, low: null,
    close: base + i, adjClose: null, volume: null,
  }));
}

const fakeYf = {
  pricesBatch: async (symbols: string[]) =>
    Object.fromEntries(symbols.map((s, i) => [s, fakePriceSeries(100 + i)])),
} as unknown as YFinanceProvider;

describe('sectors API shape', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await dbH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`);
  });

  it('getSectors returns SectorData with 11 rows', async () => {
    const svc = new SectorRotationService({ db: dbH.db, yf: fakeYf });
    await svc.refreshAll('daily');
    const data = await svc.getSectors();
    expect(data).toHaveProperty('sectors');
    expect(data).toHaveProperty('asOf');
    expect(data).toHaveProperty('stale');
    expect(data.sectors).toHaveLength(11);
  });

  it('getSeriesHistory returns history array for XLK', async () => {
    const svc = new SectorRotationService({ db: dbH.db, yf: fakeYf });
    await svc.refreshAll('daily');
    const detail = await svc.getSeriesHistory('XLK', '1y');
    expect(detail.seriesId).toBe('XLK');
    expect(Array.isArray(detail.history)).toBe(true);
  });

  it('getSeriesHistory throws NotFoundError for SPY (benchmark, not a display sector)', async () => {
    const svc = new SectorRotationService({ db: dbH.db });
    await expect(svc.getSeriesHistory('SPY', '1y')).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run the integration tests**

```bash
pnpm test:integration tests/integration/api-sectors.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/api/sectors/route.ts "app/api/sectors/[seriesId]/route.ts" tests/integration/api-sectors.test.ts
git commit -m "feat(sectors): API routes GET /api/sectors + /api/sectors/[seriesId]

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: UI — Page + Sortable Heatmap Table

**Files:**
- Create: `app/(app)/macro/sectors/page.tsx`
- Create: `app/(app)/macro/sectors/_components/sector-table.tsx`
- Modify: `app/(app)/_components/nav.tsx`

- [ ] **Step 1: Create `app/(app)/macro/sectors/page.tsx`**

```tsx
// app/(app)/macro/sectors/page.tsx
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { SectorRotationService } from '@/lib/services/sector-rotation';
import { SectorTable } from './_components/sector-table';

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

- [ ] **Step 2: Create `app/(app)/macro/sectors/_components/sector-table.tsx`**

```tsx
// app/(app)/macro/sectors/_components/sector-table.tsx
'use client';

import { useState } from 'react';
import type { SectorData, ReturnWindow } from '@/lib/services/sector-rotation';
import { SectorDetail } from './sector-detail';

const WINDOWS: ReturnWindow[] = ['1D', '1W', '1M', '3M', '1Y'];

function cellClass(v: number | null): string {
  if (v == null) return 'text-muted-foreground';
  if (v >= 0.005)  return 'bg-emerald-950 text-emerald-300';
  if (v <= -0.005) return 'bg-red-950 text-red-300';
  return 'bg-amber-950 text-amber-300';
}

function fmtPct(v: number | null): string {
  if (v == null) return '—';
  const pct = v * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

export function SectorTable({ data }: { data: SectorData }) {
  const [sortCol, setSortCol] = useState<ReturnWindow>('1M');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [open, setOpen] = useState<string | null>(null);

  if (data.sectors.length === 0 || data.sectors.every((s) => s.latestPrice === null)) {
    return (
      <div className="rounded-xl border border-border p-6 text-sm text-muted-foreground">
        No sector data yet. Run <code>pnpm seed-sectors</code> to backfill, then the daily cron keeps it fresh.
      </div>
    );
  }

  function handleSort(col: ReturnWindow) {
    if (sortCol === col) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortCol(col);
      setSortDir('desc');
    }
  }

  const rows = [...data.sectors].sort((a, b) => {
    const av = a.returns[sortCol] ?? -Infinity;
    const bv = b.returns[sortCol] ?? -Infinity;
    return sortDir === 'desc' ? bv - av : av - bv;
  });

  return (
    <div>
      {data.stale && (
        <div className="text-[11px] text-amber-400 mb-2">
          ⚠ data looks stale — last refresh {data.asOf}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="px-2 py-1.5 text-left text-[10px] uppercase text-muted-foreground">
                Sector
              </th>
              <th className="px-2 py-1.5 text-right text-[10px] uppercase text-muted-foreground">
                Price
              </th>
              {WINDOWS.map((w) => (
                <th
                  key={w}
                  onClick={() => handleSort(w)}
                  className={`px-2 py-1.5 text-right text-[10px] uppercase tracking-wide cursor-pointer select-none ${
                    sortCol === w ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {w} {sortCol === w ? (sortDir === 'desc' ? '↓' : '↑') : ''}
                </th>
              ))}
              <th className="px-2 py-1.5 text-right text-[10px] uppercase text-muted-foreground">
                vs SPY ({sortCol})
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.seriesId}
                onClick={() => setOpen(r.seriesId)}
                className="border-b border-border/50 hover:bg-card cursor-pointer"
              >
                <td className="px-2 py-1.5 font-medium whitespace-nowrap">{r.label}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                  {r.latestPrice != null ? `$${r.latestPrice.toFixed(2)}` : '—'}
                </td>
                {WINDOWS.map((w) => (
                  <td
                    key={w}
                    className={`px-2 py-1.5 text-right tabular-nums text-xs rounded ${cellClass(r.returns[w])}`}
                  >
                    {fmtPct(r.returns[w])}
                  </td>
                ))}
                <td className={`px-2 py-1.5 text-right tabular-nums text-xs rounded ${cellClass(r.vsSpy[sortCol])}`}>
                  {fmtPct(r.vsSpy[sortCol])}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.asOf && (
        <div className="text-[11px] text-muted-foreground mt-2">as of {data.asOf}</div>
      )}
      <SectorDetail seriesId={open} onClose={() => setOpen(null)} />
    </div>
  );
}
```

- [ ] **Step 3: Add "Sectors" to the nav**

In `app/(app)/_components/nav.tsx`, add a link after the "Correlations" link:

```tsx
// Before (the last nav Link before </nav>):
          <Link href="/macro/correlations" className="text-sm text-muted-foreground hover:text-foreground">
            Correlations
          </Link>

// After (add immediately after the Correlations link):
          <Link href="/macro/correlations" className="text-sm text-muted-foreground hover:text-foreground">
            Correlations
          </Link>
          <Link href="/macro/sectors" className="text-sm text-muted-foreground hover:text-foreground">
            Sectors
          </Link>
```

- [ ] **Step 4: Commit** (typecheck deferred to Task 6 — `sector-table.tsx` imports `SectorDetail` which is created in Task 6)

```bash
git add "app/(app)/macro/sectors/page.tsx" "app/(app)/macro/sectors/_components/sector-table.tsx" "app/(app)/_components/nav.tsx"
git commit -m "feat(sectors): page + sortable heatmap table + nav entry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: UI — Detail Drawer + Skipped E2E

**Files:**
- Create: `app/(app)/macro/sectors/_components/sector-detail.tsx`
- Create: `tests/e2e/sectors.spec.ts`

- [ ] **Step 1: Create `app/(app)/macro/sectors/_components/sector-detail.tsx`**

```tsx
// app/(app)/macro/sectors/_components/sector-detail.tsx
'use client';

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { displaySectors } from '@/lib/compute/sector-registry';

interface History {
  seriesId: string;
  label: string;
  history: { date: string; value: number }[];
}

const RANGES = ['1y', '3y', '5y'] as const;
type Range = (typeof RANGES)[number];

export function SectorDetail({
  seriesId,
  onClose,
}: {
  seriesId: string | null;
  onClose: () => void;
}) {
  const [range, setRange] = useState<Range>('1y');
  const [detail, setDetail] = useState<History | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!seriesId) { setDetail(null); setError(null); return; }
    let alive = true;
    setLoading(true); setError(null);
    fetch(`/api/sectors/${encodeURIComponent(seriesId)}?range=${range}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { if (alive) setDetail(d as History); })
      .catch((e) => { if (alive) setError(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [seriesId, range]);

  const def = seriesId ? displaySectors().find((s) => s.seriesId === seriesId) : null;

  return (
    <Dialog.Root open={!!seriesId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed right-0 top-0 h-full w-full max-w-lg bg-background border-l border-border p-5 overflow-y-auto">
          <Dialog.Title className="text-lg font-semibold">
            {detail?.label ?? def?.label ?? seriesId}
          </Dialog.Title>
          <Dialog.Description className="text-xs text-muted-foreground mb-3">
            Price history
          </Dialog.Description>

          <div className="flex gap-1.5 mb-3">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`rounded-md border px-2 py-1 text-xs ${
                  range === r
                    ? 'bg-foreground text-background'
                    : 'border-border text-muted-foreground'
                }`}
              >
                {r.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="h-64">
            {loading && (
              <div className="text-sm text-muted-foreground">Loading…</div>
            )}
            {!loading && error && (
              <div className="text-sm text-red-400">Failed to load: {error}</div>
            )}
            {!loading && detail && detail.history.length > 0 && (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={detail.history}>
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={40} />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    width={52}
                    domain={['auto', 'auto']}
                    tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                  />
                  <Tooltip formatter={(v: number) => [`$${v.toFixed(2)}`, 'Price']} />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="#60a5fa"
                    dot={false}
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
            {!loading && detail && detail.history.length === 0 && (
              <div className="text-sm text-muted-foreground">No data in range.</div>
            )}
          </div>

          <Dialog.Close className="absolute top-4 right-4 text-muted-foreground hover:text-foreground text-sm">
            ✕
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 2: Create skipped E2E spec**

```ts
// tests/e2e/sectors.spec.ts
import { test, expect } from '@playwright/test';
// Authed E2E specs are skipped pending the Stack Auth ESM fixture fix (see handoff).
test.skip('sector rotation page renders and sorting works', async ({ page }) => {
  await page.goto('/macro/sectors');
  await expect(page.getByText('Sector Rotation')).toBeVisible();
  await page.getByRole('columnheader', { name: /1W/i }).click();
  await expect(page.getByRole('columnheader', { name: /1W/i })).toBeVisible();
});
```

- [ ] **Step 3: Run typecheck** (now that both `sector-table.tsx` and `sector-detail.tsx` exist)

```bash
pnpm typecheck
```

Expected: No type errors (re-run once if OOM — see handoff gotcha).

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/macro/sectors/_components/sector-detail.tsx" tests/e2e/sectors.spec.ts
git commit -m "feat(sectors): detail drawer (price history + range toggle) + skipped E2E

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Infrastructure — Cron, Seed, Vercel, Package

**Files:**
- Modify: `lib/ingest/refresh-runner.ts`
- Modify: `app/api/cron/refresh/route.ts`
- Modify: `vercel.json`
- Modify: `package.json`
- Create: `scripts/seed-sectors.ts`

- [ ] **Step 1: Add `'sectors'` kind to `lib/ingest/refresh-runner.ts`**

Change the `RefreshKind` union and `Deps` interface, then add the short-circuit block.

```ts
// In lib/ingest/refresh-runner.ts

// 1. Update the imports — add SectorRotationService:
import type { SectorRotationService } from '@/lib/services/sector-rotation';

// 2. Change the RefreshKind union (line 13):
export type RefreshKind = 'snapshot' | 'fundamentals' | 'prices' | 'earnings' | 'macro' | 'countries' | 'curve' | 'sectors';

// 3. Add sectorSvc to the Deps interface (after curveSvc):
  sectorSvc?: SectorRotationService;

// 4. Add the short-circuit block in runRefresh(), after the 'curve' block (before the ticker loop):
  if (deps.kind === 'sectors') {
    if (!deps.sectorSvc) throw new Error('sectorSvc required for sectors refresh');
    const r = await deps.sectorSvc.refreshAll('daily');
    summary.attempted = r.ok + r.failed;
    summary.succeeded = r.ok;
    summary.failed = r.failed;
    summary.durationMs = Date.now() - started;
    logger.info(summary, 'refresh-runner: sectors done');
    return summary;
  }
```

- [ ] **Step 2: Wire SectorRotationService into `app/api/cron/refresh/route.ts`**

```ts
// Add to imports (after YieldCurveService import):
import { SectorRotationService } from '@/lib/services/sector-rotation';

// Add 'sectors' to VALID_KINDS:
const VALID_KINDS: readonly RefreshKind[] = ['snapshot', 'fundamentals', 'prices', 'earnings', 'macro', 'countries', 'curve', 'sectors'];

// Add sector to the cachedDeps type (after curve):
  sector: SectorRotationService;

// Add sector to buildDeps() (after the curve line):
  const sector = new SectorRotationService({ db, yf });

// Add sector to the cachedDeps assignment (after curve):
    curve,
    sector,

// Add sectorSvc to the runRefresh call (after curveSvc):
      curveSvc: deps.curve,
      sectorSvc: deps.sector,
```

- [ ] **Step 3: Add the sectors cron to `vercel.json`**

In `vercel.json`, add after the `curve` cron entry:

```json
    {
      "path": "/api/cron/refresh?kind=sectors",
      "schedule": "30 22 * * *"
    }
```

The full `crons` array will then look like:
```json
  "crons": [
    { "path": "/api/cron/refresh?kind=snapshot",     "schedule": "30 21 * * *" },
    { "path": "/api/cron/refresh?kind=fundamentals",  "schedule": "0 6 * * *"   },
    { "path": "/api/cron/refresh?kind=macro",         "schedule": "0 22 * * *"  },
    { "path": "/api/cron/refresh?kind=countries",     "schedule": "0 6 * * 0"   },
    { "path": "/api/cron/refresh?kind=curve",         "schedule": "15 22 * * *" },
    { "path": "/api/cron/refresh?kind=sectors",       "schedule": "30 22 * * *" }
  ]
```

- [ ] **Step 4: Create `scripts/seed-sectors.ts`**

```ts
// scripts/seed-sectors.ts
import { config } from 'dotenv';
config({ path: '.env.local', override: false });

import { getServiceDb } from '@/lib/db/client';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { SectorRotationService } from '@/lib/services/sector-rotation';

const svc = new SectorRotationService({ db: getServiceDb(), yf: new YFinanceProvider() });
const summary = await svc.refreshAll('backfill');
console.log('sectors backfill:', JSON.stringify(summary));
process.exit(summary.failed > 0 ? 1 : 0);
```

- [ ] **Step 5: Add `seed-sectors` to `package.json`**

In `package.json`, add after the `seed-curve` (or similar) entry in the `scripts` block:

```json
"seed-sectors": "tsx scripts/seed-sectors.ts"
```

- [ ] **Step 6: Run typecheck to verify all wiring is correct**

```bash
pnpm typecheck
```

Expected: No type errors (re-run once if OOM).

- [ ] **Step 7: Run all unit + integration tests**

```bash
pnpm test
pnpm test:integration
```

Expected: All existing tests still pass + new tests pass.

- [ ] **Step 8: Commit**

```bash
git add lib/ingest/refresh-runner.ts app/api/cron/refresh/route.ts vercel.json scripts/seed-sectors.ts package.json
git commit -m "feat(sectors): cron wiring, seed script, vercel.json — A4 complete

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Post-Implementation

After all tasks are committed:

1. **Apply migrations to both Neon branches** — no new migration needed for this slice (reuses `macro_series` + `macro_freshness`). ✓ Skip this step.

2. **Backfill prod data:**
   ```bash
   DATABASE_URL=$DATABASE_URL_SERVICE_ROLE pnpm seed-sectors
   ```

3. **Backfill test branch:**
   ```bash
   DATABASE_URL=$DATABASE_URL_TEST_SERVICE_ROLE pnpm seed-sectors
   ```
   (Optional — integration tests use fake providers and truncate, so the test branch doesn't need real data.)

4. **Push to origin/master** — Vercel deploys automatically. Confirm the deploy is green and `/macro/sectors` renders.

5. **Verify `FRED_API_KEY` is in Vercel env** — not required for this slice (yfinance-only), but worth confirming it's set for the existing macro/curve/countries crons.
