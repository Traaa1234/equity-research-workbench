# Yield-Curve Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Treasury yield-curve page at `/macro/curve` — 9 FRED maturities + 3 key spreads + a deterministic shape/recession read, reusing the A1 macro foundation.

**Architecture:** 9 daily FRED maturity series land in the **existing `macro_series`** table (no new table/migration/RLS). A code registry + pure `curve-analytics` (shape/recession/duration/spreads/momentum) compute the read on demand; a `YieldCurveService` + two API routes + the page surface it; a daily `curve` cron refreshes.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Drizzle + Neon, Vitest, recharts, Radix dialog. pnpm.

**Spec:** `docs/superpowers/specs/2026-06-03-yield-curve-design.md`.

**Reference implementations to mirror (shipped this session):** `lib/compute/macro-signals.ts`, `lib/services/country-scorecard.ts` + `lib/services/macro.ts`, `app/api/countries/route.ts` + `[code]/route.ts`, `app/(app)/macro/page.tsx` + `_components/{macro-board,macro-detail}.tsx`, `lib/ingest/refresh-runner.ts` (the `countries` kind), `scripts/seed-macro.ts`, `app/(app)/_components/nav.tsx`.

**Conventions:** direct commit to master; trailer exactly `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`; `numeric` reads as string → `Number(...)`; pure tests in `tests/compute/`, DB tests in `tests/integration/`; `pnpm typecheck` must pass before each commit.

---

## File structure

**Create:** `lib/compute/curve-registry.ts`, `lib/compute/curve-analytics.ts`, `lib/services/yield-curve.ts`, `scripts/seed-curve.ts`, `app/api/curve/route.ts`, `app/api/curve/[seriesId]/route.ts`, `app/(app)/macro/curve/page.tsx` + `_components/curve-view.tsx` + `_components/curve-detail.tsx`; tests `tests/compute/curve-analytics.test.ts`, `tests/compute/curve-registry.test.ts`, `tests/integration/yield-curve-service.test.ts`, `tests/integration/api-curve.test.ts`, `tests/e2e/curve.spec.ts`.

**Modify:** `lib/ingest/refresh-runner.ts` (`curve` kind + dep), `app/api/cron/refresh/route.ts` (build service + `kind=curve`), `vercel.json` (daily cron), `package.json` (`seed-curve`), `app/(app)/_components/nav.tsx` ("Curve" entry).

---

## Task 1: Curve registry + analytics (the brain)

**Files:** Create `lib/compute/curve-registry.ts`, `lib/compute/curve-analytics.ts`, `tests/compute/curve-registry.test.ts`, `tests/compute/curve-analytics.test.ts`.

- [ ] **Step 1: Write `lib/compute/curve-registry.ts`**

```ts
export interface MaturityDef { seriesId: string; label: string; months: number }

export const CURVE_MATURITIES: MaturityDef[] = [
  { seriesId: 'DGS3MO', label: '3M', months: 3 },
  { seriesId: 'DGS6MO', label: '6M', months: 6 },
  { seriesId: 'DGS1', label: '1Y', months: 12 },
  { seriesId: 'DGS2', label: '2Y', months: 24 },
  { seriesId: 'DGS5', label: '5Y', months: 60 },
  { seriesId: 'DGS7', label: '7Y', months: 84 },
  { seriesId: 'DGS10', label: '10Y', months: 120 },
  { seriesId: 'DGS20', label: '20Y', months: 240 },
  { seriesId: 'DGS30', label: '30Y', months: 360 },
];

export interface SpreadDef { key: string; label: string; long: string; short: string }
export const CURVE_SPREADS: SpreadDef[] = [
  { key: '2s10s', label: '2s10s', long: 'DGS10', short: 'DGS2' },
  { key: '3m10y', label: '3m10y', long: 'DGS10', short: 'DGS3MO' },
  { key: '5s30s', label: '5s30s', long: 'DGS30', short: 'DGS5' },
];

export function curveSeriesIds(): string[] { return CURVE_MATURITIES.map((m) => m.seriesId); }
```

- [ ] **Step 2: Write the failing analytics test** (`tests/compute/curve-analytics.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { classifyShape, spreadSeries, momentumTag, recessionSignal, lastSignChangeMonths, spreadBadge, buildCurve } from '@/lib/compute/curve-analytics';

const s = (vals: [string, number][]) => vals.map(([date, value]) => ({ date, value }));

describe('classifyShape', () => {
  const y = (o: Partial<Record<string, number>>) => o as Record<string, number>;
  it('INVERTED when both 3m10y and 2s10s < 0', () => {
    expect(classifyShape(y({ DGS3MO: 5.3, DGS2: 4.8, DGS5: 4.4, DGS10: 4.5, DGS30: 4.6 }))).toBe('INVERTED');
  });
  it('PARTIALLY_INVERTED when exactly one < 0', () => {
    // 3m10y = 4.1-4.3 = -0.2 (inv); 2s10s = 4.1-3.85 = +0.25 (pos)
    expect(classifyShape(y({ DGS3MO: 4.3, DGS2: 3.85, DGS5: 3.9, DGS10: 4.1, DGS30: 4.5 }))).toBe('PARTIALLY_INVERTED');
  });
  it('FLAT when |10Y-3M| < 0.25 and not inverted', () => {
    expect(classifyShape(y({ DGS3MO: 4.0, DGS2: 4.0, DGS5: 4.05, DGS10: 4.1, DGS30: 4.15 }))).toBe('FLAT');
  });
  it('HUMPED when belly above both ends (and not inverted)', () => {
    // 3m10y = 4.1-3.5 = +0.6, 2s10s = 4.1-4.0 = +0.1 (neither inverted); belly 5Y 4.3 > max(3M,30Y)+0.1
    expect(classifyShape(y({ DGS3MO: 3.5, DGS2: 4.0, DGS5: 4.3, DGS10: 4.1, DGS30: 3.9 }))).toBe('HUMPED');
  });
  it('NORMAL otherwise (positive slope)', () => {
    expect(classifyShape(y({ DGS3MO: 3.5, DGS2: 3.7, DGS5: 3.9, DGS10: 4.2, DGS30: 4.5 }))).toBe('NORMAL');
  });
});

describe('spreads + momentum', () => {
  it('spreadSeries pairs by date and subtracts', () => {
    const long = s([['2026-01-01', 4.1], ['2026-02-01', 4.2]]);
    const short = s([['2026-01-01', 3.8], ['2026-02-01', 4.0]]);
    expect(spreadSeries(long, short)).toEqual([{ date: '2026-01-01', value: 4.1 - 3.8 }, { date: '2026-02-01', value: 4.2 - 4.0 }]);
  });
  it('momentumTag from 2s10s 3-mo change', () => {
    expect(momentumTag(s([['2026-01-01', -0.2], ['2026-04-01', 0.1]]))).toBe('steepening'); // +0.3
    expect(momentumTag(s([['2026-01-01', 0.3], ['2026-04-01', 0.0]]))).toBe('flattening');  // -0.3
    expect(momentumTag(s([['2026-01-01', 0.2], ['2026-04-01', 0.22]]))).toBe('stable');
  });
  it('spreadBadge bands', () => {
    expect(spreadBadge(-0.1)).toBe('INVERTED');
    expect(spreadBadge(0.1)).toBe('FLAT');
    expect(spreadBadge(0.4)).toBe('POSITIVE');
    expect(spreadBadge(0.7)).toBe('STEEP');
  });
});

describe('recession signal + duration', () => {
  it('ON when both inverted', () => {
    const r = recessionSignal(s([['2025-01-01', -0.3], ['2026-01-01', -0.2]]), s([['2025-01-01', -0.1], ['2026-01-01', -0.05]]));
    expect(r.level).toBe('ON');
  });
  it('CAUTION when one inverted', () => {
    const r = recessionSignal(s([['2026-01-01', -0.2]]), s([['2026-01-01', 0.25]]));
    expect(r.level).toBe('CAUTION');
  });
  it('WATCH when positive now but inverted within ~6mo', () => {
    // 3m10y: inverted through 2026-02, positive from 2026-04 (latest). monthsSinceInverted ~ 2.
    const s3 = s([['2026-01-01', -0.2], ['2026-02-01', -0.1], ['2026-04-01', 0.1]]);
    const s2 = s([['2026-01-01', 0.1], ['2026-04-01', 0.3]]);
    expect(recessionSignal(s3, s2).level).toBe('WATCH');
  });
  it('CLEAR when positive and not recently inverted', () => {
    const s3 = s([['2024-01-01', 0.5], ['2026-04-01', 0.6]]);
    expect(recessionSignal(s3, s3).level).toBe('CLEAR');
  });
  it('lastSignChangeMonths counts inversion duration', () => {
    const r = lastSignChangeMonths(s([['2025-01-01', 0.2], ['2025-04-01', -0.1], ['2026-01-01', -0.2]]));
    expect(r.invertedNow).toBe(true);
    expect(r.monthsInverted).toBe(9); // from 2025-04 to 2026-01
  });
});

describe('buildCurve', () => {
  it('assembles maturities + spreads + read from histories', () => {
    const h = (v: number) => s([['2025-06-01', v - 0.1], ['2026-06-01', v]]);
    const histories: Record<string, { date: string; value: number }[]> = {
      DGS3MO: h(4.3), DGS6MO: h(4.2), DGS1: h(4.0), DGS2: h(3.85), DGS5: h(3.9), DGS7: h(4.0), DGS10: h(4.1), DGS20: h(4.45), DGS30: h(4.5),
    };
    const c = buildCurve(histories);
    expect(c.maturities).toHaveLength(9);
    expect(c.maturities.find((m) => m.seriesId === 'DGS10')!.current).toBeCloseTo(4.1);
    expect(c.spreads).toHaveLength(3);
    expect(c.read.shape).toBe('PARTIALLY_INVERTED');
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `pnpm test -- curve-analytics` → FAIL (module missing).

- [ ] **Step 4: Implement `lib/compute/curve-analytics.ts`**

```ts
import { CURVE_MATURITIES, CURVE_SPREADS } from './curve-registry';

export interface SeriesPoint { date: string; value: number }
export type CurveShape = 'INVERTED' | 'PARTIALLY_INVERTED' | 'FLAT' | 'HUMPED' | 'NORMAL';
export type Momentum = 'steepening' | 'flattening' | 'stable';
export type RecessionLevel = 'ON' | 'CAUTION' | 'WATCH' | 'CLEAR';

function last(series: SeriesPoint[]): number | null { return series.length ? series[series.length - 1]!.value : null; }
function valueMonthsAgo(series: SeriesPoint[], months: number): number | null {
  if (series.length === 0) return null;
  const target = new Date(series[series.length - 1]!.date); target.setMonth(target.getMonth() - months);
  let best: SeriesPoint | null = null;
  for (const p of series) { if (new Date(p.date).getTime() <= target.getTime()) best = p; else break; }
  return best ? best.value : null;
}
export function changeOverMonths(series: SeriesPoint[], months: number): number | null {
  const l = last(series), past = valueMonthsAgo(series, months);
  return l == null || past == null ? null : l - past;
}
function monthsBetween(a: string, b: string): number {
  const d1 = new Date(a), d2 = new Date(b);
  return (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth());
}

export function spreadSeries(longH: SeriesPoint[], shortH: SeriesPoint[]): SeriesPoint[] {
  const shortMap = new Map(shortH.map((p) => [p.date, p.value]));
  const out: SeriesPoint[] = [];
  for (const p of longH) { const sv = shortMap.get(p.date); if (sv != null) out.push({ date: p.date, value: p.value - sv }); }
  return out;
}

export function classifyShape(y: Record<string, number | null | undefined>): CurveShape | null {
  const g3m = y.DGS3MO, g2 = y.DGS2, g5 = y.DGS5, g10 = y.DGS10, g30 = y.DGS30;
  if (g10 == null || g3m == null || g2 == null) return null;
  const m3m10y = g10 - g3m, m2s10s = g10 - g2;
  if (m3m10y < 0 && m2s10s < 0) return 'INVERTED';
  if ((m3m10y < 0) !== (m2s10s < 0)) return 'PARTIALLY_INVERTED';
  if (Math.abs(g10 - g3m) < 0.25) return 'FLAT';
  if (g5 != null && g30 != null && Math.max(g2, g5) > Math.max(g3m, g30) + 0.1) return 'HUMPED';
  return 'NORMAL';
}

export function momentumTag(s2s10s: SeriesPoint[]): Momentum {
  const chg = changeOverMonths(s2s10s, 3);
  if (chg == null) return 'stable';
  if (chg > 0.1) return 'steepening';
  if (chg < -0.1) return 'flattening';
  return 'stable';
}

export function spreadBadge(v: number | null): string {
  if (v == null) return 'N/A';
  if (v < 0) return 'INVERTED';
  if (v < 0.25) return 'FLAT';
  if (v > 0.5) return 'STEEP';
  return 'POSITIVE';
}

export function lastSignChangeMonths(s3m10y: SeriesPoint[]): { invertedNow: boolean; monthsInverted: number; monthsSinceInverted: number } {
  if (s3m10y.length === 0) return { invertedNow: false, monthsInverted: 0, monthsSinceInverted: 999 };
  const lp = s3m10y[s3m10y.length - 1]!;
  const invertedNow = lp.value < 0;
  if (invertedNow) {
    // start of the current consecutive-inverted streak (walk back while still < 0)
    let streakStart = lp.date;
    for (let i = s3m10y.length - 1; i >= 0; i--) {
      if (s3m10y[i]!.value < 0) streakStart = s3m10y[i]!.date; else break;
    }
    return { invertedNow, monthsInverted: monthsBetween(streakStart, lp.date), monthsSinceInverted: 0 };
  }
  // not inverted now: months since the most recent inverted reading
  let lastNeg: string | null = null;
  for (let i = s3m10y.length - 1; i >= 0; i--) { if (s3m10y[i]!.value < 0) { lastNeg = s3m10y[i]!.date; break; } }
  return { invertedNow, monthsInverted: 0, monthsSinceInverted: lastNeg ? monthsBetween(lastNeg, lp.date) : 999 };
}

export function recessionSignal(s3m10y: SeriesPoint[], s2s10s: SeriesPoint[]): { level: RecessionLevel; label: string; durationMo: number } {
  const l3 = last(s3m10y), l2 = last(s2s10s);
  const inv3 = l3 != null && l3 < 0, inv2 = l2 != null && l2 < 0;
  const dur = lastSignChangeMonths(s3m10y);
  if (inv3 && inv2) return { level: 'ON', label: 'Both curves inverted', durationMo: dur.monthsInverted };
  if (inv3 || inv2) return { level: 'CAUTION', label: 'Front-end inverted', durationMo: dur.monthsInverted };
  if (!dur.invertedNow && dur.monthsSinceInverted <= 6) return { level: 'WATCH', label: 'Curve re-steepening (late-cycle window)', durationMo: dur.monthsSinceInverted };
  return { level: 'CLEAR', label: 'Positively sloped', durationMo: 0 };
}

export interface CurveResult {
  maturities: { seriesId: string; label: string; months: number; current: number | null; change1d: number | null; overlay: { m1: number | null; y1: number | null; y2: number | null } }[];
  spreads: { key: string; label: string; value: number | null; badge: string; durationMo?: number }[];
  read: { shape: CurveShape | null; momentum: Momentum; recession: { level: RecessionLevel; label: string; durationMo: number } };
}

export function buildCurve(histories: Record<string, SeriesPoint[]>): CurveResult {
  const h = (id: string) => histories[id] ?? [];
  const latestById: Record<string, number | null> = {};
  for (const m of CURVE_MATURITIES) latestById[m.seriesId] = last(h(m.seriesId));

  const maturities = CURVE_MATURITIES.map((m) => {
    const hist = h(m.seriesId);
    const n = hist.length;
    return {
      seriesId: m.seriesId, label: m.label, months: m.months,
      current: n ? hist[n - 1]!.value : null,
      change1d: n >= 2 ? hist[n - 1]!.value - hist[n - 2]!.value : null,
      overlay: { m1: valueMonthsAgo(hist, 1), y1: valueMonthsAgo(hist, 12), y2: valueMonthsAgo(hist, 24) },
    };
  });

  const seriesByKey: Record<string, SeriesPoint[]> = {};
  const spreads = CURVE_SPREADS.map((sp) => {
    const ss = spreadSeries(h(sp.long), h(sp.short));
    seriesByKey[sp.key] = ss;
    const v = last(ss);
    const out: CurveResult['spreads'][number] = { key: sp.key, label: sp.label, value: v, badge: spreadBadge(v) };
    if (sp.key === '3m10y') out.durationMo = lastSignChangeMonths(ss).monthsInverted;
    return out;
  });

  const read = {
    shape: classifyShape(latestById),
    momentum: momentumTag(seriesByKey['2s10s'] ?? []),
    recession: recessionSignal(seriesByKey['3m10y'] ?? [], seriesByKey['2s10s'] ?? []),
  };
  return { maturities, spreads, read };
}
```

- [ ] **Step 5: Run to verify it passes** — `pnpm test -- curve-analytics` → PASS.

- [ ] **Step 6: Registry integrity test** (`tests/compute/curve-registry.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { CURVE_MATURITIES, CURVE_SPREADS, curveSeriesIds } from '@/lib/compute/curve-registry';

describe('curve registry', () => {
  it('has 9 maturities ordered by months ascending', () => {
    expect(CURVE_MATURITIES).toHaveLength(9);
    const months = CURVE_MATURITIES.map((m) => m.months);
    expect([...months].sort((a, b) => a - b)).toEqual(months);
  });
  it('has 3 spreads whose long/short ids are real maturities', () => {
    expect(CURVE_SPREADS).toHaveLength(3);
    const ids = new Set(curveSeriesIds());
    for (const sp of CURVE_SPREADS) { expect(ids.has(sp.long)).toBe(true); expect(ids.has(sp.short)).toBe(true); }
  });
  it('curveSeriesIds returns 9 unique ids', () => {
    expect(new Set(curveSeriesIds()).size).toBe(9);
  });
});
```

- [ ] **Step 7: Run both + typecheck + commit**
Run `pnpm test -- curve-analytics curve-registry` (all pass) and `pnpm typecheck`. Then:
```
git add lib/compute/curve-registry.ts lib/compute/curve-analytics.ts tests/compute/curve-analytics.test.ts tests/compute/curve-registry.test.ts
git commit -m "feat(curve): maturity registry + curve analytics (shape/recession/spreads)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: YieldCurveService + cron + backfill

**Files:** Create `lib/services/yield-curve.ts`, `scripts/seed-curve.ts`, `tests/integration/yield-curve-service.test.ts`. Modify `lib/ingest/refresh-runner.ts`, `app/api/cron/refresh/route.ts`, `vercel.json`, `package.json`. **Mirror `lib/services/country-scorecard.ts` + the `countries` cron kind.**

- [ ] **Step 1: Implement `lib/services/yield-curve.ts`**

```ts
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { macroSeries, macroFreshness } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type { FredProvider } from '@/lib/providers/fred';
import { curveSeriesIds, CURVE_MATURITIES } from '@/lib/compute/curve-registry';
import { buildCurve, type SeriesPoint, type CurveResult } from '@/lib/compute/curve-analytics';
import { logger } from '@/lib/logger';

interface Deps { db: ServiceDb; fred?: FredProvider; fredDelayMs?: number }
export interface CurveRefreshSummary { ok: number; failed: number }

function isoDaysAgo(d: number): string { const x = new Date(); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10); }
function isoYearsAgo(y: number): string { const x = new Date(); x.setFullYear(x.getFullYear() - y); return x.toISOString().slice(0, 10); }
function sleep(ms: number): Promise<void> { return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve(); }

export class YieldCurveService {
  constructor(private readonly deps: Deps) {}

  async refreshAll(mode: 'daily' | 'backfill'): Promise<CurveRefreshSummary> {
    if (!this.deps.fred) throw new Error('refreshAll requires fred');
    const start = mode === 'backfill' ? isoYearsAgo(5) : isoDaysAgo(40);
    const delay = this.deps.fredDelayMs ?? 500;
    let ok = 0, failed = 0;
    for (const id of curveSeriesIds()) {
      try { await sleep(delay); const pts = await this.deps.fred.fetchSeries(id, { start }); await this.upsert(id, pts); await this.fresh(id, pts, 'ok', null); ok++; }
      catch (err) { logger.warn({ id, err: String(err) }, 'curve refresh failed'); await this.fresh(id, [], 'error', String(err).slice(0, 500)); failed++; }
    }
    return { ok, failed };
  }

  private async upsert(seriesId: string, points: SeriesPoint[]): Promise<void> {
    if (!points.length) return;
    await this.deps.db.insert(macroSeries)
      .values(points.map((p) => ({ seriesId, obsDate: p.date, value: String(p.value), source: 'fred' })))
      .onConflictDoUpdate({ target: [macroSeries.seriesId, macroSeries.obsDate], set: { value: sql`excluded.value`, source: sql`excluded.source` } });
  }
  private async fresh(seriesId: string, pts: SeriesPoint[], status: string, error: string | null): Promise<void> {
    await this.deps.db.insert(macroFreshness)
      .values({ seriesId, lastObsDate: pts.length ? pts[pts.length - 1]!.date : null, status, error })
      .onConflictDoUpdate({ target: macroFreshness.seriesId, set: { lastFetchedAt: sql`now()`, lastObsDate: sql`excluded.last_obs_date`, status, error } });
  }

  private async histories(): Promise<Record<string, SeriesPoint[]>> {
    const ids = curveSeriesIds();
    const rows = await this.deps.db.select().from(macroSeries).where(inArray(macroSeries.seriesId, ids)).orderBy(asc(macroSeries.obsDate));
    const by: Record<string, SeriesPoint[]> = {};
    for (const r of rows) { (by[r.seriesId] ??= []).push({ date: r.obsDate, value: Number(r.value) }); }
    return by;
  }

  async getCurve(): Promise<CurveResult & { asOf: string | null }> {
    const result = buildCurve(await this.histories());
    const ids = curveSeriesIds();
    const fresh = await this.deps.db.select().from(macroFreshness).where(inArray(macroFreshness.seriesId, ids));
    const asOf = fresh.map((r) => r.lastObsDate).filter((d): d is string => !!d).sort().pop() ?? null;
    return { ...result, asOf };
  }

  async getMaturityDetail(seriesId: string): Promise<{ seriesId: string; label: string; points: SeriesPoint[] }> {
    const def = CURVE_MATURITIES.find((m) => m.seriesId === seriesId);
    if (!def) throw new Error('unknown maturity');
    const rows = await this.deps.db.select().from(macroSeries).where(eq(macroSeries.seriesId, seriesId)).orderBy(asc(macroSeries.obsDate));
    return { seriesId, label: def.label, points: rows.map((r) => ({ date: r.obsDate, value: Number(r.value) })) };
  }
}
```

- [ ] **Step 2: Integration test** (`tests/integration/yield-curve-service.test.ts`) — mirror `tests/integration/country-scorecard-service.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { YieldCurveService } from '@/lib/services/yield-curve';
import type { FredProvider } from '@/lib/providers/fred';

config({ path: '.env.local' });

const yieldsById: Record<string, number> = { DGS3MO: 4.3, DGS6MO: 4.2, DGS1: 4.0, DGS2: 3.85, DGS5: 3.9, DGS7: 4.0, DGS10: 4.1, DGS20: 4.45, DGS30: 4.5 };
const fakeFred = { fetchSeries: async (id: string) => [{ date: '2025-06-01', value: yieldsById[id]! - 0.1 }, { date: '2026-06-01', value: yieldsById[id]! }] } as unknown as FredProvider;

describe('YieldCurveService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => { await dbH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`); });

  it('refreshAll upserts the 9 maturities', async () => {
    const svc = new YieldCurveService({ db: dbH.db, fred: fakeFred, fredDelayMs: 0 });
    const r = await svc.refreshAll('daily');
    expect(r.ok).toBe(9);
    expect(r.failed).toBe(0);
  });
  it('getCurve returns 9 maturities + 3 spreads + a read', async () => {
    const svc = new YieldCurveService({ db: dbH.db, fred: fakeFred, fredDelayMs: 0 });
    await svc.refreshAll('daily');
    const c = await svc.getCurve();
    expect(c.maturities).toHaveLength(9);
    expect(c.spreads).toHaveLength(3);
    expect(c.read.shape).toBe('PARTIALLY_INVERTED');
    expect(c.maturities.find((m) => m.seriesId === 'DGS10')!.current).toBeCloseTo(4.1);
  });
  it('getMaturityDetail throws for an unknown series', async () => {
    const svc = new YieldCurveService({ db: dbH.db, fred: fakeFred, fredDelayMs: 0 });
    await expect(svc.getMaturityDetail('NOPE')).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Cron wiring**
(a) `lib/ingest/refresh-runner.ts`: add `import type { YieldCurveService } from '@/lib/services/yield-curve';`; add `'curve'` to `RefreshKind`; add `curveSvc?: YieldCurveService` to `Deps`; add a short-circuit AFTER the `countries` block:
```ts
  if (deps.kind === 'curve') {
    if (!deps.curveSvc) throw new Error('curveSvc required for curve refresh');
    const r = await deps.curveSvc.refreshAll('daily');
    summary.attempted = r.ok + r.failed;
    summary.succeeded = r.ok;
    summary.failed = r.failed;
    summary.durationMs = Date.now() - started;
    logger.info(summary, 'refresh-runner: curve done');
    return summary;
  }
```
(b) `app/api/cron/refresh/route.ts`: import `YieldCurveService`; add `'curve'` to `VALID_KINDS`; add `curve: YieldCurveService` to cachedDeps type + buildDeps (`const curve = new YieldCurveService({ db, fred: new FredProvider() });`); pass `curveSvc: deps.curve` to `runRefresh`.
(c) `vercel.json` crons: add `{ "path": "/api/cron/refresh?kind=curve", "schedule": "15 22 * * *" }`.

- [ ] **Step 4: `scripts/seed-curve.ts`** (mirror `seed-macro.ts`)
```ts
import { config } from 'dotenv'; config({ path: '.env.local', override: false });
import { getServiceDb } from '@/lib/db/client';
import { FredProvider } from '@/lib/providers/fred';
import { YieldCurveService } from '@/lib/services/yield-curve';

const svc = new YieldCurveService({ db: getServiceDb(), fred: new FredProvider() });
const r = await svc.refreshAll('backfill');
console.log('curve backfill:', JSON.stringify(r));
process.exit(r.failed > 0 ? 1 : 0);
```
Add `"seed-curve": "tsx scripts/seed-curve.ts"` to `package.json` scripts.

- [ ] **Step 5: Typecheck, backfill, commit**
Run `pnpm typecheck` (clean) and `pnpm test:integration -- yield-curve-service` (3 pass). Run `pnpm seed-curve` (prod; expect `{"ok":9,"failed":0}` — re-run if FRED 429s, idempotent). Then:
```
git add lib/services/yield-curve.ts scripts/seed-curve.ts tests/integration/yield-curve-service.test.ts lib/ingest/refresh-runner.ts app/api/cron/refresh/route.ts vercel.json package.json
git commit -m "feat(curve): YieldCurveService + daily curve cron + seed-curve" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Board + maturity-detail APIs

**Files:** Create `app/api/curve/route.ts`, `app/api/curve/[seriesId]/route.ts`, `tests/integration/api-curve.test.ts`. **Mirror `app/api/countries/*`.**

- [ ] **Step 1: `app/api/curve/route.ts`**
```ts
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { YieldCurveService } from '@/lib/services/yield-curve';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireUserId();
    const curve = await new YieldCurveService({ db: getServiceDb() }).getCurve();
    return NextResponse.json(curve, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (err) { return errorResponse(err, { route: 'curve' }); }
}
```

- [ ] **Step 2: `app/api/curve/[seriesId]/route.ts`**
```ts
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { NotFoundError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { YieldCurveService } from '@/lib/services/yield-curve';
import { CURVE_MATURITIES } from '@/lib/compute/curve-registry';

export const dynamic = 'force-dynamic';
interface Ctx { params: { seriesId: string } }

export async function GET(_req: Request, ctx: Ctx) {
  try {
    await requireUserId();
    const seriesId = ctx.params.seriesId.toUpperCase();
    if (!CURVE_MATURITIES.some((m) => m.seriesId === seriesId)) throw new NotFoundError(`Unknown maturity: ${seriesId}`);
    const detail = await new YieldCurveService({ db: getServiceDb() }).getMaturityDetail(seriesId);
    return NextResponse.json(detail, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (err) { return errorResponse(err, { route: 'curve/[seriesId]' }); }
}
```

- [ ] **Step 3: Test** (`tests/integration/api-curve.test.ts`) — mirror `api-countries.test.ts`; verify the board shape via the service path.
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { YieldCurveService } from '@/lib/services/yield-curve';
import type { FredProvider } from '@/lib/providers/fred';

config({ path: '.env.local' });
const yieldsById: Record<string, number> = { DGS3MO: 4.3, DGS6MO: 4.2, DGS1: 4.0, DGS2: 3.85, DGS5: 3.9, DGS7: 4.0, DGS10: 4.1, DGS20: 4.45, DGS30: 4.5 };
const fakeFred = { fetchSeries: async (id: string) => [{ date: '2025-06-01', value: yieldsById[id]! - 0.1 }, { date: '2026-06-01', value: yieldsById[id]! }] } as unknown as FredProvider;

describe('curve board shape', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => { await dbH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`); });

  it('produces 9 maturities + 3 spreads + a read', async () => {
    const svc = new YieldCurveService({ db: dbH.db, fred: fakeFred, fredDelayMs: 0 });
    await svc.refreshAll('daily');
    const c = await svc.getCurve();
    expect(c.maturities).toHaveLength(9);
    expect(c.spreads.map((s) => s.key)).toEqual(['2s10s', '3m10y', '5s30s']);
    expect(['INVERTED', 'PARTIALLY_INVERTED', 'FLAT', 'HUMPED', 'NORMAL']).toContain(c.read.shape);
  });
});
```

- [ ] **Step 4: Run + commit**
Run `pnpm test:integration -- api-curve` (1 pass), `pnpm typecheck`, `pnpm lint`. Then:
```
git add "app/api/curve/route.ts" "app/api/curve/[seriesId]/route.ts" tests/integration/api-curve.test.ts
git commit -m "feat(curve): board + maturity-detail API routes" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Curve page UI + nav

**Files:** Create `app/(app)/macro/curve/page.tsx`, `_components/curve-view.tsx`, `_components/curve-detail.tsx` (stub). Modify `app/(app)/_components/nav.tsx`. **Mirror `app/(app)/macro/page.tsx` + the macro/countries client components.**

- [ ] **Step 1: Nav** — in `nav.tsx`, after the "Countries" `<Link>`, add `<Link href="/macro/curve" className="text-sm text-muted-foreground hover:text-foreground">Curve</Link>`.

- [ ] **Step 2: Page** (`app/(app)/macro/curve/page.tsx`)
```tsx
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { YieldCurveService } from '@/lib/services/yield-curve';
import { CurveView } from './_components/curve-view';

export const dynamic = 'force-dynamic';

export default async function CurvePage() {
  await requireUserId();
  const curve = await new YieldCurveService({ db: getServiceDb() }).getCurve();
  return (
    <main className="container mx-auto px-4 py-6">
      <h1 className="text-xl font-semibold tracking-tight mb-4">Yield Curve</h1>
      <CurveView curve={curve} />
    </main>
  );
}
```

- [ ] **Step 3: `_components/curve-view.tsx`** (client) — read banner + recharts curve plot (overlay toggle) + maturity strip + spreads + detail drawer

```tsx
'use client';
import { useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { CurveResult } from '@/lib/compute/curve-analytics';
import { CurveDetail } from './curve-detail';

type Board = CurveResult & { asOf: string | null };
type Overlay = 'm1' | 'y1' | 'y2';
const OVERLAY_LABEL: Record<Overlay, string> = { m1: '1mo', y1: '1yr', y2: '2yr' };
const REC_CLASS: Record<string, string> = { ON: 'text-red-300', CAUTION: 'text-amber-300', WATCH: 'text-amber-300', CLEAR: 'text-emerald-300' };
const SPREAD_BADGE: Record<string, string> = { INVERTED: 'bg-red-950 text-red-300', FLAT: 'bg-amber-950 text-amber-300', POSITIVE: 'bg-emerald-950 text-emerald-300', STEEP: 'bg-emerald-950 text-emerald-300', 'N/A': 'bg-slate-800 text-slate-400' };

export function CurveView({ curve }: { curve: Board }) {
  const [overlay, setOverlay] = useState<Overlay>('y1');
  const [open, setOpen] = useState<string | null>(null);
  const allEmpty = curve.maturities.every((m) => m.current == null);
  if (allEmpty) return <div className="rounded-xl border border-border p-6 text-sm text-muted-foreground">No curve data yet. Run <code>pnpm seed-curve</code>.</div>;

  const r = curve.read;
  const chartData = curve.maturities.map((m) => ({ label: m.label, now: m.current, ago: m.overlay[overlay] }));
  return (
    <div>
      <div className="rounded-2xl border border-amber-700/60 bg-gradient-to-r from-amber-950/40 to-card p-4 mb-4">
        <div className="text-lg font-extrabold">Curve: {r.shape ?? 'n/a'} <span className="text-sm font-semibold text-muted-foreground">· {r.momentum}</span></div>
        <div className="text-xs mt-1">recession signal: <b className={REC_CLASS[r.recession.level] ?? ''}>{r.recession.level}</b> — {r.recession.label}{r.recession.durationMo ? ` (${r.recession.durationMo} mo)` : ''}</div>
        {curve.asOf && <div className="text-[11px] text-muted-foreground mt-1">as of {curve.asOf}</div>}
      </div>

      <div className="rounded-xl border border-border bg-card p-3 mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Treasury yield curve</div>
          <div className="flex gap-1">
            {(['m1', 'y1', 'y2'] as Overlay[]).map((o) => (
              <button key={o} onClick={() => setOverlay(o)} className={`rounded border px-2 py-0.5 text-[10px] ${overlay === o ? 'bg-foreground text-background' : 'border-border text-muted-foreground'}`}>vs {OVERLAY_LABEL[o]}</button>
            ))}
          </div>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <XAxis dataKey="label" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} width={40} domain={['auto', 'auto']} unit="%" />
              <Tooltip />
              <Line type="monotone" dataKey="ago" stroke="#64748b" strokeDasharray="5 4" dot={false} strokeWidth={2} name={`${OVERLAY_LABEL[overlay]} ago`} />
              <Line type="monotone" dataKey="now" stroke="#60a5fa" dot strokeWidth={2.5} name="now" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">Maturity yields</div>
      <div className="grid gap-2 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(96px,1fr))' }}>
        {curve.maturities.map((m) => (
          <button key={m.seriesId} onClick={() => setOpen(m.seriesId)} className="rounded-lg border border-border bg-card p-2 text-center hover:border-foreground/40">
            <div className="text-[10px] font-bold text-muted-foreground">{m.label}</div>
            <div className="text-base font-bold">{m.current == null ? '—' : m.current.toFixed(2)}</div>
            {m.change1d != null && <div className={`text-[9px] ${m.change1d > 0 ? 'text-emerald-400' : m.change1d < 0 ? 'text-red-400' : 'text-muted-foreground'}`}>{m.change1d > 0 ? '▲' : m.change1d < 0 ? '▼' : '—'}{Math.abs(m.change1d).toFixed(2)}</div>}
          </button>
        ))}
      </div>

      <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">Key spreads</div>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))' }}>
        {curve.spreads.map((s) => (
          <div key={s.key} className="rounded-xl border border-border bg-card p-3">
            <div className="text-[10px] uppercase text-muted-foreground">{s.label}</div>
            <div className="text-xl font-bold">{s.value == null ? '—' : `${s.value > 0 ? '+' : ''}${s.value.toFixed(2)}%`}</div>
            <span className={`inline-block mt-2 rounded-full px-2 py-0.5 text-[9px] font-bold ${SPREAD_BADGE[s.badge] ?? SPREAD_BADGE['N/A']}`}>{s.badge}{s.durationMo ? ` · ${s.durationMo}mo` : ''}</span>
          </div>
        ))}
      </div>

      <CurveDetail seriesId={open} onClose={() => setOpen(null)} />
    </div>
  );
}
```

- [ ] **Step 4: Stub** `_components/curve-detail.tsx`
```tsx
'use client';
export function CurveDetail(_props: { seriesId: string | null; onClose: () => void }) { return null; }
```

- [ ] **Step 5: Verify + commit**
Run `pnpm typecheck`, `pnpm lint`, `pnpm build` (confirm `/macro/curve` is a `ƒ` route). Then:
```
git add "app/(app)/macro/curve/page.tsx" "app/(app)/macro/curve/_components/curve-view.tsx" "app/(app)/macro/curve/_components/curve-detail.tsx" "app/(app)/_components/nav.tsx"
git commit -m "feat(curve): /macro/curve page UI (plot + strip + spreads + read) + nav" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Maturity detail drawer

**Files:** Replace `app/(app)/macro/curve/_components/curve-detail.tsx`. **Mirror `app/(app)/macro/_components/macro-detail.tsx`** (Radix dialog + recharts + the alive-flag/.catch/loading/error pattern).

- [ ] **Step 1: Implement the drawer** — fetch `/api/curve/<seriesId>`, render the rate's recharts history.
```tsx
'use client';
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface Detail { seriesId: string; label: string; points: { date: string; value: number }[] }

export function CurveDetail({ seriesId, onClose }: { seriesId: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!seriesId) { setDetail(null); setError(null); return; }
    let alive = true; setLoading(true); setError(null);
    fetch(`/api/curve/${encodeURIComponent(seriesId)}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { if (alive) setDetail(d as Detail); })
      .catch((e) => { if (alive) setError(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [seriesId]);
  return (
    <Dialog.Root open={!!seriesId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed right-0 top-0 h-full w-full max-w-lg bg-background border-l border-border p-5 overflow-y-auto">
          <Dialog.Title className="text-lg font-semibold">{detail ? `${detail.label} Treasury yield` : seriesId}</Dialog.Title>
          <Dialog.Description className="text-xs text-muted-foreground mb-3">Constant-maturity yield history</Dialog.Description>
          {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {error && <div className="text-sm text-red-400">Failed to load: {error}</div>}
          {detail && detail.points.length > 0 && (
            <div className="h-72"><ResponsiveContainer width="100%" height="100%">
              <LineChart data={detail.points}><XAxis dataKey="date" tick={{ fontSize: 9 }} minTickGap={40} /><YAxis tick={{ fontSize: 9 }} width={40} domain={['auto', 'auto']} unit="%" /><Tooltip /><Line type="monotone" dataKey="value" stroke="#60a5fa" dot={false} strokeWidth={2} /></LineChart>
            </ResponsiveContainer></div>
          )}
          {detail && detail.points.length === 0 && !loading && !error && <div className="text-sm text-muted-foreground">No data for this maturity yet.</div>}
          <Dialog.Close className="absolute top-4 right-4 text-muted-foreground hover:text-foreground text-sm">✕</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 2: Verify + commit** — `pnpm typecheck`, `pnpm build`. Then:
```
git add "app/(app)/macro/curve/_components/curve-detail.tsx"
git commit -m "feat(curve): maturity detail drawer (recharts rate history)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: E2E-skip + final verification

**Files:** Create `tests/e2e/curve.spec.ts`.

- [ ] **Step 1: E2E skip spec**
```ts
import { test, expect } from '@playwright/test';
// Authed E2E specs are skipped pending the Stack Auth ESM fixture fix (see handoff).
test.skip('yield curve renders and a maturity opens detail', async ({ page }) => {
  await page.goto('/macro/curve');
  await expect(page.getByText('Yield Curve')).toBeVisible();
  await expect(page.getByText(/recession signal/i)).toBeVisible();
  await page.getByRole('button', { name: /10Y/ }).first().click();
  await expect(page.getByText(/Treasury yield/)).toBeVisible();
});
```

- [ ] **Step 2: Full verification** — run each and report:
`pnpm typecheck` (clean) · `pnpm test` (all unit incl. curve-analytics, curve-registry) · `pnpm test:integration` (incl. yield-curve-service, api-curve) · `pnpm lint` · `pnpm build` (`/macro`, `/macro/countries`, `/macro/curve` all present).

- [ ] **Step 3: Commit**
```
git add tests/e2e/curve.spec.ts
git commit -m "feat(curve): skipped E2E happy-path + final verification" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the executor

- **No new migration/RLS** — curve maturities live in the existing `macro_series` (catalog RLS `9990`). `DGS10` is shared with A1 (idempotent).
- **FRED 429s** self-heal (the service marks failures + continues; re-run `seed-curve`). With `FRED_API_KEY` set, the keyed JSON API avoids them.
- **Commit trailer** exactly the 4.7 line on every commit.
