# Cross-Asset Correlation Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `/macro/correlations` page — a 7×7 cross-asset rolling-correlation heatmap (30/60/90d) computed on returns, over series already in `macro_series`.

**Architecture:** Pure compute-on-read. A code registry names 7 assets already stored by A1+B1; `correlation.ts` transforms each to a daily-change series, aligns on common dates, and computes pairwise Pearson per window; a service + one API route + a heatmap page surface it. **No new table/migration/RLS/provider/cron/backfill.**

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Drizzle + Neon, Vitest. pnpm.

**Spec:** `docs/superpowers/specs/2026-06-03-correlation-matrix-design.md`.

**Reference implementations to mirror (shipped this session):** `lib/compute/curve-analytics.ts`, `lib/services/yield-curve.ts` (read path), `app/api/curve/route.ts`, `app/(app)/macro/curve/page.tsx` + `_components/curve-view.tsx`, `app/(app)/_components/nav.tsx`.

**Conventions:** direct commit to master; trailer exactly `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`; `numeric` reads as string → `Number(...)`; pure tests in `tests/compute/`, DB tests in `tests/integration/`; `pnpm typecheck` before each commit.

---

## File structure

**Create:** `lib/compute/correlation-registry.ts`, `lib/compute/correlation.ts`, `lib/services/correlation.ts`, `app/api/correlations/route.ts`, `app/(app)/macro/correlations/page.tsx` + `_components/correlation-matrix.tsx`; tests `tests/compute/correlation.test.ts`, `tests/compute/correlation-registry.test.ts`, `tests/integration/correlation-service.test.ts`, `tests/e2e/correlations.spec.ts`.

**Modify:** `app/(app)/_components/nav.tsx` ("Correlations" entry).

---

## Task 1: Correlation registry + compute (the brain)

**Files:** Create `lib/compute/correlation-registry.ts`, `lib/compute/correlation.ts`, `tests/compute/correlation-registry.test.ts`, `tests/compute/correlation.test.ts`.

- [ ] **Step 1: Write `lib/compute/correlation-registry.ts`**

```ts
export type Transform = 'return' | 'diff';
export interface CorrAsset { seriesId: string; label: string; transform: Transform }

export const CORR_ASSETS: CorrAsset[] = [
  { seriesId: 'SPY', label: 'EQ', transform: 'return' },
  { seriesId: 'DGS10', label: '10Y', transform: 'diff' },
  { seriesId: 'GC=F', label: 'GOLD', transform: 'return' },
  { seriesId: 'DTWEXBGS', label: 'USD', transform: 'diff' },
  { seriesId: 'BAMLH0A0HYM2', label: 'HY', transform: 'diff' },
  { seriesId: 'CL=F', label: 'OIL', transform: 'return' },
  { seriesId: '^VIX', label: 'VIX', transform: 'diff' },
];

export function corrSeriesIds(): string[] { return CORR_ASSETS.map((a) => a.seriesId); }
```

- [ ] **Step 2: Write the failing compute test** (`tests/compute/correlation.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { dailyChange, alignByDate, pearson, correlationMatrix } from '@/lib/compute/correlation';

const s = (vals: [string, number][]) => vals.map(([date, value]) => ({ date, value }));

describe('dailyChange', () => {
  it('return = simple daily return for prices', () => {
    expect(dailyChange(s([['d1', 100], ['d2', 110]]), 'return')).toEqual([{ date: 'd2', value: 0.1 }]);
  });
  it('diff = first difference for levels', () => {
    expect(dailyChange(s([['d1', 4.0], ['d2', 4.2]]), 'diff')[0]!.value).toBeCloseTo(0.2);
  });
  it('empty / single-point series → []', () => {
    expect(dailyChange([], 'return')).toEqual([]);
    expect(dailyChange(s([['d1', 1]]), 'diff')).toEqual([]);
  });
});

describe('alignByDate', () => {
  it('keeps only dates present in every series, sorted', () => {
    const a = s([['d1', 1], ['d2', 2], ['d3', 3]]);
    const b = s([['d2', 9], ['d3', 8], ['d4', 7]]);
    const { dates, values } = alignByDate([a, b]);
    expect(dates).toEqual(['d2', 'd3']);
    expect(values).toEqual([[2, 3], [9, 8]]);
  });
});

describe('pearson', () => {
  const lin = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
  it('+1 for identical', () => { const x = lin(12, (i) => i); expect(pearson(x, x)!).toBeCloseTo(1); });
  it('-1 for negated', () => { const x = lin(12, (i) => i); expect(pearson(x, x.map((v) => -v))!).toBeCloseTo(-1); });
  it('null when < 10 observations', () => { expect(pearson([1, 2, 3], [3, 2, 1])).toBeNull(); });
  it('null when a series has zero variance', () => { const x = lin(12, (i) => i); expect(pearson(x, lin(12, () => 5))).toBeNull(); });
});

describe('correlationMatrix', () => {
  it('symmetric with diagonal 1; uses last `window` obs', () => {
    const a = Array.from({ length: 20 }, (_, i) => i);
    const b = a.map((v) => -v);
    const m = correlationMatrix([a, b], 60); // window > length → uses all 20
    expect(m[0]![0]).toBe(1);
    expect(m[1]![1]).toBe(1);
    expect(m[0]![1]!).toBeCloseTo(-1);
    expect(m[0]![1]).toBeCloseTo(m[1]![0]!); // symmetric
  });
  it('null cells when window too short', () => {
    const a = [1, 2, 3], b = [3, 2, 1];
    const m = correlationMatrix([a, b], 60);
    expect(m[0]![1]).toBeNull();
    expect(m[0]![0]).toBe(1); // diagonal still 1
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `pnpm test -- correlation` → FAIL (module missing).

- [ ] **Step 4: Implement `lib/compute/correlation.ts`**

```ts
import type { Transform } from './correlation-registry';

export interface SeriesPoint { date: string; value: number }

export function dailyChange(series: SeriesPoint[], transform: Transform): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!.value, cur = series[i]!.value;
    const v = transform === 'return' ? (prev === 0 ? 0 : cur / prev - 1) : cur - prev;
    out.push({ date: series[i]!.date, value: v });
  }
  return out;
}

/** Align change-series on the intersection of their dates (ascending). Returns parallel value rows. */
export function alignByDate(seriesList: SeriesPoint[][]): { dates: string[]; values: number[][] } {
  if (seriesList.length === 0) return { dates: [], values: [] };
  const maps = seriesList.map((s) => new Map(s.map((p) => [p.date, p.value])));
  const dates = [...maps[0]!.keys()].filter((d) => maps.every((m) => m.has(d))).sort();
  const values = maps.map((m) => dates.map((d) => m.get(d)!));
  return { dates, values };
}

export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 10) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]!; sy += ys[i]!; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i]! - mx, dy = ys[i]! - my; cov += dx * dy; vx += dx * dx; vy += dy * dy; }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

/** N×N matrix of pairwise Pearson over the last `windowDays` aligned obs. Diagonal = 1. */
export function correlationMatrix(aligned: number[][], windowDays: number): (number | null)[][] {
  const windows = aligned.map((row) => row.slice(-windowDays));
  const n = aligned.length;
  const m: (number | null)[][] = [];
  for (let i = 0; i < n; i++) {
    m[i] = [];
    for (let j = 0; j < n; j++) m[i]![j] = i === j ? 1 : pearson(windows[i]!, windows[j]!);
  }
  return m;
}
```

- [ ] **Step 5: Run to verify it passes** — `pnpm test -- correlation` → PASS.

- [ ] **Step 6: Registry integrity test** (`tests/compute/correlation-registry.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { CORR_ASSETS, corrSeriesIds } from '@/lib/compute/correlation-registry';

describe('correlation registry', () => {
  it('has 7 assets with unique ids + valid transforms', () => {
    expect(CORR_ASSETS).toHaveLength(7);
    expect(new Set(corrSeriesIds()).size).toBe(7);
    for (const a of CORR_ASSETS) { expect(a.label).toBeTruthy(); expect(['return', 'diff']).toContain(a.transform); }
  });
  it('prices use return, levels use diff', () => {
    const byId = Object.fromEntries(CORR_ASSETS.map((a) => [a.seriesId, a.transform]));
    expect(byId['SPY']).toBe('return');
    expect(byId['GC=F']).toBe('return');
    expect(byId['CL=F']).toBe('return');
    expect(byId['DGS10']).toBe('diff');
    expect(byId['^VIX']).toBe('diff');
    expect(byId['BAMLH0A0HYM2']).toBe('diff');
  });
});
```

- [ ] **Step 7: Run both + typecheck + commit**
Run `pnpm test -- correlation correlation-registry` (all pass) and `pnpm typecheck`. Then:
```
git add lib/compute/correlation-registry.ts lib/compute/correlation.ts tests/compute/correlation.test.ts tests/compute/correlation-registry.test.ts
git commit -m "feat(correlations): registry + correlation compute (returns/align/pearson/matrix)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: CorrelationService + API

**Files:** Create `lib/services/correlation.ts`, `app/api/correlations/route.ts`, `tests/integration/correlation-service.test.ts`. **Mirror the read path of `lib/services/yield-curve.ts` + `app/api/curve/route.ts`.**

- [ ] **Step 1: Implement `lib/services/correlation.ts`**

```ts
import { asc, inArray } from 'drizzle-orm';
import { macroSeries } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import { CORR_ASSETS, corrSeriesIds } from '@/lib/compute/correlation-registry';
import { dailyChange, alignByDate, correlationMatrix, type SeriesPoint } from '@/lib/compute/correlation';

interface Deps { db: ServiceDb }
export interface CorrMatrices {
  assets: { seriesId: string; label: string }[];
  windows: Record<'30' | '60' | '90', (number | null)[][]>;
  asOf: string | null;
}

export class CorrelationService {
  constructor(private readonly deps: Deps) {}

  async getMatrices(): Promise<CorrMatrices> {
    const ids = corrSeriesIds();
    const rows = await this.deps.db.select().from(macroSeries).where(inArray(macroSeries.seriesId, ids)).orderBy(asc(macroSeries.obsDate));
    const by = new Map<string, SeriesPoint[]>();
    for (const r of rows) { const a = by.get(r.seriesId) ?? []; a.push({ date: r.obsDate, value: Number(r.value) }); by.set(r.seriesId, a); }

    const changeSeries = CORR_ASSETS.map((a) => dailyChange(by.get(a.seriesId) ?? [], a.transform));
    const aligned = alignByDate(changeSeries);
    const windows = {
      '30': correlationMatrix(aligned.values, 30),
      '60': correlationMatrix(aligned.values, 60),
      '90': correlationMatrix(aligned.values, 90),
    } as CorrMatrices['windows'];
    const asOf = aligned.dates.length ? aligned.dates[aligned.dates.length - 1]! : null;
    return { assets: CORR_ASSETS.map((a) => ({ seriesId: a.seriesId, label: a.label })), windows, asOf };
  }
}
```

- [ ] **Step 2: `app/api/correlations/route.ts`** (mirror `app/api/curve/route.ts`)

```ts
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { CorrelationService } from '@/lib/services/correlation';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireUserId();
    const data = await new CorrelationService({ db: getServiceDb() }).getMatrices();
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (err) { return errorResponse(err, { route: 'correlations' }); }
}
```

- [ ] **Step 3: Integration test** (`tests/integration/correlation-service.test.ts`)

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { macroSeries } from '@/lib/db/schema';
import { CorrelationService } from '@/lib/services/correlation';
import { corrSeriesIds } from '@/lib/compute/correlation-registry';

config({ path: '.env.local' });

describe('CorrelationService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => { await dbH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`); });

  it('returns 7 assets, 3 windows, a symmetric matrix with diagonal 1', async () => {
    // Seed 15 overlapping daily rows for all 7 ids. The `(d % 4)` term gives every
    // series a NON-CONSTANT daily change (non-zero variance) — including the `diff`
    // assets — so no correlation cell is null from zero variance.
    const ids = corrSeriesIds();
    const rows: { seriesId: string; obsDate: string; value: string; source: string }[] = [];
    for (let d = 1; d <= 15; d++) {
      const date = `2026-01-${String(d).padStart(2, '0')}`;
      ids.forEach((id, k) => rows.push({ seriesId: id, obsDate: date, value: String(100 + (k + 1) * d + (d % 4)), source: 'fred' }));
    }
    await dbH.db.insert(macroSeries).values(rows);

    const out = await new CorrelationService({ db: dbH.db }).getMatrices();
    expect(out.assets).toHaveLength(7);
    expect(Object.keys(out.windows)).toEqual(['30', '60', '90']);
    const m = out.windows['60'];
    expect(m).toHaveLength(7);
    expect(m[0]![0]).toBe(1);              // diagonal
    expect(m[0]![1]).toBeCloseTo(m[1]![0]!); // symmetric
    expect(out.asOf).toBe('2026-01-15');
  });
});
```

- [ ] **Step 4: Run + commit**
Run `pnpm test:integration -- correlation-service` (1 pass), `pnpm typecheck`, `pnpm lint`. Then:
```
git add lib/services/correlation.ts "app/api/correlations/route.ts" tests/integration/correlation-service.test.ts
git commit -m "feat(correlations): CorrelationService.getMatrices + API route" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Heatmap UI + nav

**Files:** Create `app/(app)/macro/correlations/page.tsx`, `_components/correlation-matrix.tsx`. Modify `app/(app)/_components/nav.tsx`. **Mirror `app/(app)/macro/curve/page.tsx` + `curve-view.tsx`.**

- [ ] **Step 1: Nav** — in `nav.tsx`, after the "Curve" `<Link>`, add `<Link href="/macro/correlations" className="text-sm text-muted-foreground hover:text-foreground">Correlations</Link>`.

- [ ] **Step 2: Page** (`app/(app)/macro/correlations/page.tsx`)
```tsx
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { CorrelationService } from '@/lib/services/correlation';
import { CorrelationMatrix } from './_components/correlation-matrix';

export const dynamic = 'force-dynamic';

export default async function CorrelationsPage() {
  await requireUserId();
  const data = await new CorrelationService({ db: getServiceDb() }).getMatrices();
  return (
    <main className="container mx-auto px-4 py-6">
      <h1 className="text-xl font-semibold tracking-tight mb-4">Cross-Asset Correlations</h1>
      <CorrelationMatrix data={data} />
    </main>
  );
}
```

- [ ] **Step 3: `_components/correlation-matrix.tsx`** (client)
```tsx
'use client';
import { useState } from 'react';
import type { CorrMatrices } from '@/lib/services/correlation';

type Win = '30' | '60' | '90';

function cellClass(c: number | null, diag: boolean): string {
  if (diag) return 'bg-card text-muted-foreground';
  if (c == null) return 'bg-slate-800 text-slate-500';
  if (c >= 0.55) return 'bg-blue-700 text-blue-50';
  if (c >= 0.2) return 'bg-blue-900 text-blue-200';
  if (c > -0.2) return 'bg-slate-800 text-slate-300';
  if (c > -0.55) return 'bg-red-900 text-red-200';
  return 'bg-red-700 text-red-50';
}
function fmt(c: number | null): string { return c == null ? 'n/a' : (c < 0 ? '' : '+') + c.toFixed(2); }

export function CorrelationMatrix({ data }: { data: CorrMatrices }) {
  const [win, setWin] = useState<Win>('60');
  if (data.asOf == null) {
    return <div className="rounded-xl border border-border p-6 text-sm text-muted-foreground">No overlapping data yet for the cross-asset set.</div>;
  }
  const m = data.windows[win];
  const labels = data.assets.map((a) => a.label);
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] text-muted-foreground">as of {data.asOf} · correlation of daily returns</div>
        <div className="flex gap-1.5">
          {(['30', '60', '90'] as Win[]).map((w) => (
            <button key={w} onClick={() => setWin(w)} className={`rounded-md border px-2 py-1 text-xs ${win === w ? 'bg-foreground text-background' : 'border-border text-muted-foreground'}`}>{w}d</button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="border-separate" style={{ borderSpacing: '3px' }}>
          <thead><tr><th></th>{labels.map((l) => <th key={l} className="text-[10px] text-muted-foreground font-bold px-1">{l}</th>)}</tr></thead>
          <tbody>
            {m.map((row, i) => (
              <tr key={labels[i]}>
                <th className="text-[10px] text-muted-foreground font-bold pr-2 text-right">{labels[i]}</th>
                {row.map((c, j) => (
                  <td key={j} className={`w-[54px] h-[38px] text-center text-xs font-bold rounded-md ${cellClass(c, i === j)}`}>{i === j ? '1.00' : fmt(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 text-[11px] text-muted-foreground">red = move opposite · slate = uncorrelated · blue = move together</div>
    </div>
  );
}
```

- [ ] **Step 4: Verify + commit**
Run `pnpm typecheck`, `pnpm lint`, `pnpm build` (confirm `/macro/correlations` is a `ƒ` route). Then:
```
git add "app/(app)/macro/correlations/page.tsx" "app/(app)/macro/correlations/_components/correlation-matrix.tsx" "app/(app)/_components/nav.tsx"
git commit -m "feat(correlations): heatmap UI (window toggle) + nav entry" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: E2E-skip + final verification

**Files:** Create `tests/e2e/correlations.spec.ts`.

- [ ] **Step 1: E2E skip spec**
```ts
import { test, expect } from '@playwright/test';
// Authed E2E specs are skipped pending the Stack Auth ESM fixture fix (see handoff).
test.skip('correlation matrix renders and the window toggle works', async ({ page }) => {
  await page.goto('/macro/correlations');
  await expect(page.getByText('Cross-Asset Correlations')).toBeVisible();
  await page.getByRole('button', { name: '30d' }).click();
  await expect(page.getByText(/correlation of daily returns/)).toBeVisible();
});
```

- [ ] **Step 2: Full verification** — run and report each:
`pnpm typecheck` (clean) · `pnpm test` (all unit incl. correlation, correlation-registry) · `pnpm test:integration` (incl. correlation-service) · `pnpm lint` · `pnpm build` (`/macro`, `/macro/countries`, `/macro/curve`, `/macro/correlations` all present).

- [ ] **Step 3: Commit**
```
git add tests/e2e/correlations.spec.ts
git commit -m "feat(correlations): skipped E2E happy-path + final verification" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the executor

- **No new migration/RLS/cron/backfill** — the 7 series already exist in `macro_series` (A1 + B1) and are kept current by their crons. This slice only reads + computes.
- Correlations are computed on **daily changes** (returns for prices, first-difference for yields/spreads/vol) and on the **date intersection** of all 7 series, so every cell uses the same observation dates.
- **Commit trailer** exactly the 4.7 line on every commit.
