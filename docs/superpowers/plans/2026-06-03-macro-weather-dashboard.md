# Macro Weather Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a top-down, cross-asset "macro weather" dashboard at `/macro` — 13 free FRED/yfinance tiles, 7 rule-based voting signals + 6 context levels, and a 5-level weather verdict.

**Architecture:** Providers (`fred.ts` pure-TS + existing `yfinance.ts`) → `macro_series` raw store → pure signal compute (`lib/compute/macro-signals.ts`) → `MacroService` → board/detail APIs → server page + client board/drawer. A new `?kind=macro` cron refreshes daily; a one-off `seed-macro.ts` backfills ~5yr.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Drizzle + Neon Postgres, Vitest, recharts, Radix dialog. Package manager `pnpm`.

**Spec:** `docs/superpowers/specs/2026-06-03-macro-weather-dashboard-design.md` (authoritative for every threshold).

**Conventions (from the spec + session handoff):**
- Direct commit to `master`. Commit trailer **exactly**: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. Never `--no-verify`, never force-push.
- Drizzle migrations: edit `lib/db/schema.ts` → `pnpm db:generate` → apply to **both** Neon branches:
  - prod: `DATABASE_URL=$DATABASE_URL_SERVICE_ROLE pnpm db:migrate`
  - test: `DATABASE_URL=$DATABASE_URL_TEST_SERVICE_ROLE pnpm db:migrate`
- RLS files use a `9xxx_` prefix (skipped by `migrate.ts`), applied via `pnpm exec tsx _apply.ts --target prod|test --file <path>` (run for **both** targets).
- Tests: pure → `tests/compute/`, `tests/providers/`; DB → `tests/integration/`. Run pure with `pnpm test`, DB with `pnpm test:integration`. Typecheck with `pnpm typecheck`.
- `numeric` columns read back as strings → wrap with `Number(...)`. Money/analytic values stored as `numeric`, not float.
- RLS-blocked writes throw a `DrizzleQueryError`; assert on `error.message + String(error.cause)`.

---

## File structure

**Create:**
- `lib/providers/fred.ts` — FRED provider (pure-TS, key + keyless).
- `lib/providers/__fixtures__/fred-dgs10.csv`, `lib/providers/__fixtures__/fred-dgs10.json` — parser fixtures.
- `lib/compute/macro-signals.ts` — pure helpers, classifiers, weather aggregation, board builder.
- `lib/compute/macro-registry.ts` — the 13-series typed registry + asset-class ordering.
- `lib/services/macro.ts` — `MacroService` (refreshAll + getBoard + getSeriesDetail).
- `scripts/seed-macro.ts` — one-off ~5yr backfill.
- `app/api/macro/route.ts` — board JSON.
- `app/api/macro/[seriesId]/route.ts` — series detail JSON.
- `app/(app)/macro/page.tsx` — server page.
- `app/(app)/macro/_components/macro-board.tsx` — client board (hero + sections).
- `app/(app)/macro/_components/macro-tile.tsx` — client tile.
- `app/(app)/macro/_components/macro-detail.tsx` — client Radix-dialog detail drawer with recharts.
- Tests: `tests/providers/fred.test.ts`, `tests/compute/macro-signals.test.ts`, `tests/compute/macro-registry.test.ts`, `tests/integration/macro-schema.test.ts`, `tests/integration/macro-rls.test.ts`, `tests/integration/macro-service.test.ts`, `tests/integration/api-macro.test.ts`, `tests/e2e/macro.spec.ts`.

**Modify:**
- `lib/db/schema.ts` — add `macroSeries`, `macroFreshness`.
- `lib/db/migrations/9990_rls_macro_series.sql` — new RLS file (create).
- `lib/ingest/refresh-runner.ts` — add `'macro'` kind + `macroSvc` dep.
- `app/api/cron/refresh/route.ts` — build `MacroService`, pass to `runRefresh`, allow `kind=macro`.
- `vercel.json` — add the macro cron entry.
- `package.json` — add `"seed-macro"` script.
- `app/(app)/_components/nav.tsx` — add the "Macro" nav link.

---

## Task 1: Schema — `macro_series` + `macro_freshness`

**Files:**
- Modify: `lib/db/schema.ts`
- Create (generated): `lib/db/migrations/0007_*.sql`
- Test: `tests/integration/macro-schema.test.ts`

- [ ] **Step 1: Add tables to `lib/db/schema.ts`** (append after `journalEntries`; reuse the already-imported `numeric`, `date`, `text`, `timestamp`, `pgTable`, `primaryKey`, `index`)

```ts
export const macroSeries = pgTable(
  'macro_series',
  {
    seriesId: text('series_id').notNull(),     // registry key: FRED id or yfinance symbol
    obsDate: date('obs_date').notNull(),
    value: numeric('value', { precision: 20, scale: 6 }).notNull(),
    source: text('source').notNull(),          // 'fred' | 'yfinance'
  },
  (t) => ({
    pk: primaryKey({ columns: [t.seriesId, t.obsDate] }),
    seriesIdx: index('macro_series_series_idx').on(t.seriesId, t.obsDate),
  })
);

export const macroFreshness = pgTable('macro_freshness', {
  seriesId: text('series_id').primaryKey(),
  lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }).notNull().defaultNow(),
  lastObsDate: date('last_obs_date'),
  status: text('status').notNull().default('ok'),  // 'ok' | 'error'
  error: text('error'),
});
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `lib/db/migrations/0007_<name>.sql` containing `CREATE TABLE "macro_series"` and `"macro_freshness"`. Open it and confirm both tables + the composite PK are present.

- [ ] **Step 3: Apply to both Neon branches**

Run:
```bash
DATABASE_URL=$DATABASE_URL_TEST_SERVICE_ROLE pnpm db:migrate
DATABASE_URL=$DATABASE_URL_SERVICE_ROLE pnpm db:migrate
```
Expected: each prints `apply 0007_<name>.sql` then `Done. Applied 1 new migration(s).` (idempotent on re-run: `skip ... (already applied)`).

- [ ] **Step 4: Write the schema test** (`tests/integration/macro-schema.test.ts`)

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { macroSeries, macroFreshness } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('macro schema', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await dbH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`);
  });

  it('upserts observations idempotently on (series_id, obs_date)', async () => {
    await dbH.db.insert(macroSeries).values({ seriesId: 'T10Y2Y', obsDate: '2026-06-01', value: '0.18', source: 'fred' });
    await dbH.db
      .insert(macroSeries)
      .values({ seriesId: 'T10Y2Y', obsDate: '2026-06-01', value: '0.22', source: 'fred' })
      .onConflictDoUpdate({ target: [macroSeries.seriesId, macroSeries.obsDate], set: { value: '0.22' } });
    const rows = await dbH.db.select().from(macroSeries);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.value)).toBeCloseTo(0.22);
  });

  it('stores a freshness row', async () => {
    await dbH.db.insert(macroFreshness).values({ seriesId: 'T10Y2Y', lastObsDate: '2026-06-01', status: 'ok' });
    const rows = await dbH.db.select().from(macroFreshness);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('ok');
  });
});
```

- [ ] **Step 5: Run the test**

Run: `pnpm test:integration -- macro-schema`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/db/schema.ts lib/db/migrations/0007_*.sql tests/integration/macro-schema.test.ts
git commit -m "feat(macro): macro_series + macro_freshness schema (0007)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: RLS — catalog read policy

**Files:**
- Create: `lib/db/migrations/9990_rls_macro_series.sql`
- Test: `tests/integration/macro-rls.test.ts`

- [ ] **Step 1: Write the RLS file** (`lib/db/migrations/9990_rls_macro_series.sql`) — mirrors `9989_rls_transcripts.sql`

```sql
-- RLS for the macro weather dashboard. Catalog data: any authenticated user can
-- SELECT; writes go through service_role (BYPASSRLS).

alter table public.macro_series enable row level security;
alter table public.macro_freshness enable row level security;

drop policy if exists "auth read macro_series" on public.macro_series;
create policy "auth read macro_series"
  on public.macro_series for select to authenticated using (true);

drop policy if exists "auth read macro_freshness" on public.macro_freshness;
create policy "auth read macro_freshness"
  on public.macro_freshness for select to authenticated using (true);

grant select on public.macro_series to authenticated;
grant select on public.macro_freshness to authenticated;
```

- [ ] **Step 2: Apply to both branches**

Run:
```bash
pnpm exec tsx _apply.ts --target test --file lib/db/migrations/9990_rls_macro_series.sql
pnpm exec tsx _apply.ts --target prod --file lib/db/migrations/9990_rls_macro_series.sql
```
Expected: `Applied ... to test OK` and `Applied ... to prod OK`.

- [ ] **Step 3: Write the RLS test** (`tests/integration/macro-rls.test.ts`)

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb, makeTestUserDb, newUserId } from '../helpers/test-db';
import { macroSeries } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('macro_series RLS', () => {
  let svcH: ReturnType<typeof makeTestServiceDb>;
  let userH: ReturnType<typeof makeTestUserDb>;
  beforeAll(() => { svcH = makeTestServiceDb(); userH = makeTestUserDb(); });
  afterAll(async () => { await svcH.close(); await userH.close(); });
  beforeEach(async () => {
    await svcH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`);
    await svcH.db.insert(macroSeries).values({ seriesId: 'VIX', obsDate: '2026-06-01', value: '15.8', source: 'yfinance' });
  });

  it('authenticated user can SELECT macro_series', async () => {
    const rows = await userH.asUser(newUserId(), async (tx) => tx.select().from(macroSeries));
    expect(rows).toHaveLength(1);
  });

  it('authenticated user cannot INSERT macro_series', async () => {
    let caught: unknown;
    try {
      await userH.asUser(newUserId(), async (tx) =>
        tx.insert(macroSeries).values({ seriesId: 'VIX', obsDate: '2026-06-02', value: '16.0', source: 'yfinance' })
      );
    } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    const msg = (caught as Error).message + String((caught as { cause?: unknown })?.cause ?? '');
    expect(msg).toMatch(/permission denied|policy/i);
  });
});
```

- [ ] **Step 4: Run the test**

Run: `pnpm test:integration -- macro-rls`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/db/migrations/9990_rls_macro_series.sql tests/integration/macro-rls.test.ts
git commit -m "feat(macro): RLS catalog read policy for macro tables" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: FRED provider (pure-TS, key + keyless)

**Files:**
- Create: `lib/providers/fred.ts`, `lib/providers/__fixtures__/fred-dgs10.csv`, `lib/providers/__fixtures__/fred-dgs10.json`
- Test: `tests/providers/fred.test.ts`

- [ ] **Step 1: Write fixtures**

`lib/providers/__fixtures__/fred-dgs10.csv`:
```
observation_date,DGS10
2026-05-28,4.20
2026-05-29,.
2026-06-01,4.21
```

`lib/providers/__fixtures__/fred-dgs10.json`:
```json
{"observations":[{"date":"2026-05-28","value":"4.20"},{"date":"2026-05-29","value":"."},{"date":"2026-06-01","value":"4.21"}]}
```

- [ ] **Step 2: Write the failing test** (`tests/providers/fred.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FredProvider } from '@/lib/providers/fred';

const csv = readFileSync(path.resolve(__dirname, '../../lib/providers/__fixtures__/fred-dgs10.csv'), 'utf8');
const json = readFileSync(path.resolve(__dirname, '../../lib/providers/__fixtures__/fred-dgs10.json'), 'utf8');

function fakeFetch(body: string, contentType: string): typeof fetch {
  return (async () => new Response(body, { status: 200, headers: { 'content-type': contentType } })) as unknown as typeof fetch;
}

describe('FredProvider', () => {
  it('parses keyless CSV and drops "." missing markers', async () => {
    const p = new FredProvider({ apiKey: undefined, fetch: fakeFetch(csv, 'text/csv') });
    const rows = await p.fetchSeries('DGS10', { start: '2026-05-01' });
    expect(rows).toEqual([
      { date: '2026-05-28', value: 4.2 },
      { date: '2026-06-01', value: 4.21 },
    ]);
  });

  it('parses the JSON API when a key is set', async () => {
    const p = new FredProvider({ apiKey: 'k', fetch: fakeFetch(json, 'application/json') });
    const rows = await p.fetchSeries('DGS10', { start: '2026-05-01' });
    expect(rows.map((r) => r.value)).toEqual([4.2, 4.21]);
  });

  it('uses the api.stlouisfed.org host when keyed, fredgraph when keyless', async () => {
    const seen: string[] = [];
    const spy: typeof fetch = (async (url: string) => {
      seen.push(String(url));
      return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } });
    }) as unknown as typeof fetch;
    await new FredProvider({ apiKey: undefined, fetch: spy }).fetchSeries('DGS10', { start: '2026-05-01' });
    await new FredProvider({ apiKey: 'k', fetch: spy }).fetchSeries('DGS10', { start: '2026-05-01' });
    expect(seen[0]).toContain('fredgraph.csv');
    expect(seen[1]).toContain('api.stlouisfed.org');
    expect(seen[1]).toContain('api_key=k');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test -- fred`
Expected: FAIL ("Cannot find module '@/lib/providers/fred'").

- [ ] **Step 4: Implement `lib/providers/fred.ts`**

```ts
import { ProviderError } from './types';

export interface FredPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

interface Options {
  apiKey?: string | undefined;
  fetch?: typeof fetch;
}

/**
 * FRED data provider — pure TypeScript (FRED is a plain REST/CSV GET).
 * Prefers the keyed JSON API when an api key is available; otherwise uses the
 * keyless fredgraph CSV endpoint. Always bound by `start` (cosd / observation_start).
 */
export class FredProvider {
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: Options = {}) {
    this.apiKey = opts.apiKey ?? process.env.FRED_API_KEY;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async fetchSeries(seriesId: string, opts: { start: string }): Promise<FredPoint[]> {
    const url = this.apiKey
      ? `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(seriesId)}` +
        `&observation_start=${opts.start}&file_type=json&api_key=${this.apiKey}`
      : `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}&cosd=${opts.start}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url);
    } catch (err) {
      throw new ProviderError(`FRED fetch failed for ${seriesId}: ${String(err)}`);
    }
    if (!res.ok) throw new ProviderError(`FRED ${seriesId} HTTP ${res.status}`);

    const body = await res.text();
    return this.apiKey ? parseJson(body) : parseCsv(body);
  }
}

function num(raw: string): number | null {
  const v = raw.trim();
  if (v === '' || v === '.') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseCsv(body: string): FredPoint[] {
  const lines = body.trim().split(/\r?\n/);
  const out: FredPoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const date = line.slice(0, comma).trim();
    const value = num(line.slice(comma + 1));
    if (date && value != null) out.push({ date, value });
  }
  return out;
}

export function parseJson(body: string): FredPoint[] {
  const parsed = JSON.parse(body) as { observations?: { date: string; value: string }[] };
  const out: FredPoint[] = [];
  for (const o of parsed.observations ?? []) {
    const value = num(o.value);
    if (o.date && value != null) out.push({ date: o.date, value });
  }
  return out;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test -- fred`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/providers/fred.ts lib/providers/__fixtures__/fred-dgs10.csv lib/providers/__fixtures__/fred-dgs10.json tests/providers/fred.test.ts
git commit -m "feat(macro): FRED provider (pure-TS, key + keyless CSV)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Signal compute + registry (the deterministic brain)

**Files:**
- Create: `lib/compute/macro-signals.ts`, `lib/compute/macro-registry.ts`
- Test: `tests/compute/macro-signals.test.ts`, `tests/compute/macro-registry.test.ts`

- [ ] **Step 1: Write the failing signals test** (`tests/compute/macro-signals.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import {
  curveClassifier, classifyHySpread, classifyVix, classifyNfci, classifyCpiYoY,
  classifySahm, classifyCopperMomentum, percentileClassifier,
  weatherFromVotes, percentileRank, sahmGap, pctChangeOverMonths, yoySeries,
} from '@/lib/compute/macro-signals';

const s = (vals: [string, number][]) => vals.map(([date, value]) => ({ date, value }));

describe('weatherFromVotes', () => {
  it('maps score to the 5 bands', () => {
    expect(weatherFromVotes([1, 1, 1, 1, 0, 0, 0]).label).toBe('SUNNY');   // +4
    expect(weatherFromVotes([1, 1, 0, 0, 0, 0, 0]).label).toBe('FAIR');    // +2
    expect(weatherFromVotes([1, 0, 0, 0, 0, 0, 0]).label).toBe('MIXED');   // +1
    expect(weatherFromVotes([-1, -1, 0, 0, 0, 0, 0]).label).toBe('CLOUDY'); // -2
    expect(weatherFromVotes([-1, -1, -1, -1, 0, 0, 0]).label).toBe('STORMY'); // -4
  });
});

describe('voting classifiers — boundaries', () => {
  it('2s10s curve (flatUpper 0.25)', () => {
    const c = curveClassifier(0.25);
    expect(c({ value: -0.01, series: [] }).level).toBe(-1);
    expect(c({ value: 0, series: [] }).level).toBe(0);
    expect(c({ value: 0.25, series: [] }).level).toBe(0);
    expect(c({ value: 0.26, series: [] }).level).toBe(1);
  });
  it('HY OAS spread', () => {
    expect(classifyHySpread({ value: 5.01, series: [] }).level).toBe(-1);
    expect(classifyHySpread({ value: 5, series: [] }).level).toBe(0);
    expect(classifyHySpread({ value: 3.5, series: [] }).level).toBe(0);
    expect(classifyHySpread({ value: 3.49, series: [] }).level).toBe(1);
  });
  it('VIX', () => {
    expect(classifyVix({ value: 24.1, series: [] }).level).toBe(-1);
    expect(classifyVix({ value: 16, series: [] }).level).toBe(0);
    expect(classifyVix({ value: 15.9, series: [] }).level).toBe(1);
  });
  it('NFCI', () => {
    expect(classifyNfci({ value: 0.21, series: [] }).level).toBe(-1);
    expect(classifyNfci({ value: 0, series: [] }).level).toBe(0);
    expect(classifyNfci({ value: -0.21, series: [] }).level).toBe(1);
  });
  it('CPI YoY', () => {
    expect(classifyCpiYoY({ value: 4.1, series: [] }).level).toBe(-1);
    expect(classifyCpiYoY({ value: 3, series: [] }).level).toBe(0);
    expect(classifyCpiYoY({ value: 2.5, series: [] }).level).toBe(1);
  });
  it('Sahm (unemployment)', () => {
    // base 3.5 for 9 months, then last-3 avg 4.4 → gap = 4.4 - 3.5 = 0.9 ≥ 0.5
    const base = Array.from({ length: 9 }, (_, i) => [`2025-${String(i + 1).padStart(2, '0')}-01`, 3.5] as [string, number]);
    const rising = s([...base, ['2025-10-01', 4.2], ['2025-11-01', 4.4], ['2025-12-01', 4.6]]);
    expect(classifySahm({ value: 4.6, series: rising }).level).toBe(-1);
  });
  it('Copper momentum', () => {
    const up = s([['2026-03-01', 5.0], ['2026-06-01', 5.6]]); // +12%
    expect(classifyCopperMomentum({ value: 5.6, series: up }).level).toBe(1);
    const down = s([['2026-03-01', 5.0], ['2026-06-01', 4.6]]); // -8%
    expect(classifyCopperMomentum({ value: 4.6, series: down }).level).toBe(-1);
  });
});

describe('helpers', () => {
  it('percentileRank', () => {
    expect(percentileRank([1, 2, 3, 4], 4)).toBeCloseTo(1);
    expect(percentileRank([1, 2, 3, 4], 1)).toBeCloseTo(0.25);
  });
  it('percentileClassifier thirds', () => {
    const c = percentileClassifier(['LOW', 'NORMAL', 'ELEVATED']);
    const series = s(Array.from({ length: 9 }, (_, i) => [`2026-0${i + 1}-01`, i + 1]));
    expect(c({ value: 1, series }).badge).toBe('LOW');
    expect(c({ value: 5, series }).badge).toBe('NORMAL');
    expect(c({ value: 9, series }).badge).toBe('ELEVATED');
  });
  it('yoySeries computes year-over-year percent', () => {
    // 13 valid months Jan-2025 … Jan-2026, values 100..112 → last YoY = (112-100)/100 = 12%
    const monthly = s(Array.from({ length: 13 }, (_, i) => {
      const y = 2025 + Math.floor(i / 12);
      const m = (i % 12) + 1;
      return [`${y}-${String(m).padStart(2, '0')}-01`, 100 + i] as [string, number];
    }));
    const yoy = yoySeries(monthly);
    expect(yoy[yoy.length - 1]!.value).toBeCloseTo(12);
  });
  it('pctChangeOverMonths', () => {
    const series = s([['2026-03-01', 100], ['2026-06-01', 110]]);
    expect(pctChangeOverMonths(series, 3)).toBeCloseTo(10);
  });
  it('sahmGap', () => {
    expect(sahmGap([3.5, 3.5, 3.6, 3.7, 3.8, 3.9, 4.0, 4.1, 4.2, 4.3, 4.4, 4.5])).toBeCloseTo((4.3 + 4.4 + 4.5) / 3 - 3.5);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- macro-signals`
Expected: FAIL ("Cannot find module '@/lib/compute/macro-signals'").

- [ ] **Step 3: Implement `lib/compute/macro-signals.ts`**

```ts
export type SignalLevel = -1 | 0 | 1;
export interface SeriesPoint { date: string; value: number }
export interface ClassifyInput { value: number; series: SeriesPoint[] }
export interface SignalResult { badge: string; level: SignalLevel; explain: string }
export type Classifier = (input: ClassifyInput) => SignalResult;

const f = (n: number, d = 2) => n.toFixed(d);

// ---- helpers ----

export function percentileRank(values: number[], v: number): number {
  if (values.length === 0) return 0.5;
  const below = values.filter((x) => x <= v).length;
  return below / values.length;
}

export function valueMonthsAgo(series: SeriesPoint[], months: number): number | null {
  if (series.length === 0) return null;
  const last = series[series.length - 1]!;
  const target = new Date(last.date);
  target.setMonth(target.getMonth() - months);
  let best: SeriesPoint | null = null;
  for (const p of series) {
    if (new Date(p.date).getTime() <= target.getTime()) best = p;
    else break;
  }
  return best ? best.value : series[0]!.value;
}

export function pctChangeOverMonths(series: SeriesPoint[], months: number): number {
  if (series.length === 0) return 0;
  const last = series[series.length - 1]!.value;
  const past = valueMonthsAgo(series, months);
  if (past == null || past === 0) return 0;
  return ((last - past) / past) * 100;
}

export function sahmGap(values: number[]): number {
  const last3 = values.slice(-3);
  const avg3 = last3.reduce((a, b) => a + b, 0) / Math.max(1, last3.length);
  const min12 = Math.min(...values.slice(-12));
  return avg3 - min12;
}

export function yoySeries(series: SeriesPoint[]): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (let i = 0; i < series.length; i++) {
    const prior = valueMonthsAgo(series.slice(0, i + 1), 12);
    if (prior != null && prior !== 0) {
      out.push({ date: series[i]!.date, value: ((series[i]!.value - prior) / prior) * 100 });
    }
  }
  return out;
}

// ---- voting classifiers ----

export function curveClassifier(flatUpper: number): Classifier {
  return ({ value }) => {
    if (value < 0) return { level: -1, badge: 'INVERTED', explain: `Spread ${f(value)} < 0 — inverted (recession signal).` };
    if (value <= flatUpper) return { level: 0, badge: 'FLAT', explain: `Spread ${f(value)} in [0, ${flatUpper}] — flat.` };
    return { level: 1, badge: 'POSITIVE', explain: `Spread ${f(value)} > ${flatUpper} — positively sloped.` };
  };
}

export const classifyHySpread: Classifier = ({ value }) => {
  if (value > 5) return { level: -1, badge: 'STRESSED', explain: `HY OAS ${f(value)}% > 5 — credit stress.` };
  if (value < 3.5) return { level: 1, badge: 'TIGHT', explain: `HY OAS ${f(value)}% < 3.5 — tight spreads.` };
  return { level: 0, badge: 'NORMAL', explain: `HY OAS ${f(value)}% in [3.5, 5].` };
};

export const classifyVix: Classifier = ({ value }) => {
  if (value > 24) return { level: -1, badge: 'STRESSED', explain: `VIX ${f(value)} > 24 — elevated fear.` };
  if (value < 16) return { level: 1, badge: 'CALM', explain: `VIX ${f(value)} < 16 — calm.` };
  return { level: 0, badge: 'NORMAL', explain: `VIX ${f(value)} in [16, 24].` };
};

export const classifyNfci: Classifier = ({ value }) => {
  if (value > 0.2) return { level: -1, badge: 'TIGHT', explain: `NFCI ${f(value)} > 0.2 — tight financial conditions.` };
  if (value < -0.2) return { level: 1, badge: 'LOOSE', explain: `NFCI ${f(value)} < -0.2 — loose conditions.` };
  return { level: 0, badge: 'NEUTRAL', explain: `NFCI ${f(value)} near 0.` };
};

export const classifyCpiYoY: Classifier = ({ value }) => {
  if (value > 4) return { level: -1, badge: 'HOT', explain: `CPI ${f(value, 1)}% YoY > 4 — hot.` };
  if (value <= 2.5) return { level: 1, badge: 'ON TARGET', explain: `CPI ${f(value, 1)}% YoY ≤ 2.5 — on target.` };
  return { level: 0, badge: 'ELEVATED', explain: `CPI ${f(value, 1)}% YoY in (2.5, 4].` };
};

export const classifySahm: Classifier = ({ series }) => {
  const gap = sahmGap(series.map((p) => p.value));
  if (gap >= 0.5) return { level: -1, badge: 'TRIGGER', explain: `Sahm gap ${f(gap, 2)} ≥ 0.5 — recession trigger.` };
  if (gap >= 0.2) return { level: 0, badge: 'TICKING UP', explain: `Sahm gap ${f(gap, 2)} in [0.2, 0.5).` };
  return { level: 1, badge: 'STABLE', explain: `Sahm gap ${f(gap, 2)} < 0.2 — labor stable.` };
};

export const classifyCopperMomentum: Classifier = ({ series }) => {
  const chg = pctChangeOverMonths(series, 3);
  if (chg > 5) return { level: 1, badge: 'FIRM', explain: `Copper +${f(chg, 1)}% over 3mo — firm (growth).` };
  if (chg < -5) return { level: -1, badge: 'SOFT', explain: `Copper ${f(chg, 1)}% over 3mo — soft (growth).` };
  return { level: 0, badge: 'STEADY', explain: `Copper ${f(chg, 1)}% over 3mo — steady.` };
};

// ---- context classifiers (level used for tile accent only) ----

export function percentileClassifier(labels: [string, string, string]): Classifier {
  return ({ value, series }) => {
    const p = percentileRank(series.map((s) => s.value), value);
    if (p < 1 / 3) return { level: -1, badge: labels[0], explain: `${Math.round(p * 100)}th pct over window (bottom third).` };
    if (p < 2 / 3) return { level: 0, badge: labels[1], explain: `${Math.round(p * 100)}th pct (middle third).` };
    return { level: 1, badge: labels[2], explain: `${Math.round(p * 100)}th pct (top third).` };
  };
}

export function bandClassifier(loUpper: number, hiLower: number, labels: [string, string, string]): Classifier {
  return ({ value }) => {
    if (value < loUpper) return { level: 1, badge: labels[0], explain: `${f(value)} < ${loUpper}.` };
    if (value <= hiLower) return { level: 0, badge: labels[1], explain: `${f(value)} in [${loUpper}, ${hiLower}].` };
    return { level: -1, badge: labels[2], explain: `${f(value)} > ${hiLower}.` };
  };
}

// ---- weather aggregation ----

export interface WeatherVerdict {
  score: number; label: string; icon: string;
}

export function weatherFromVotes(votes: SignalLevel[]): WeatherVerdict {
  const score = votes.reduce<number>((a, b) => a + b, 0);
  if (score >= 4) return { score, label: 'SUNNY', icon: '☀' };
  if (score >= 2) return { score, label: 'FAIR', icon: '🌤' };
  if (score >= -1) return { score, label: 'MIXED', icon: '⛅' };
  if (score >= -3) return { score, label: 'CLOUDY', icon: '☁' };
  return { score, label: 'STORMY', icon: '⛈' };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- macro-signals`
Expected: PASS.

- [ ] **Step 5: Write the registry** (`lib/compute/macro-registry.ts`)

```ts
import {
  curveClassifier, classifyHySpread, classifyVix, classifyNfci, classifyCpiYoY,
  classifySahm, classifyCopperMomentum, percentileClassifier, bandClassifier,
  type Classifier,
} from './macro-signals';

export type AssetClass = 'rates' | 'credit' | 'inflation_growth' | 'dollar_fx' | 'commodities' | 'vol_conditions';
export type MacroSource = 'fred' | 'yfinance';

export interface MacroSeriesDef {
  seriesId: string;       // storage key = FRED id or yfinance symbol
  label: string;
  assetClass: AssetClass;
  source: MacroSource;
  unit: string;           // '%', '$', 'idx'
  decimals: number;
  role: 'vote' | 'context';
  derive?: 'yoy';
  classify: Classifier;
}

export const ASSET_CLASS_ORDER: AssetClass[] = [
  'rates', 'credit', 'inflation_growth', 'dollar_fx', 'commodities', 'vol_conditions',
];
export const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  rates: 'Rates & Curve',
  credit: 'Credit',
  inflation_growth: 'Inflation & Growth',
  dollar_fx: 'Dollar & FX',
  commodities: 'Commodities',
  vol_conditions: 'Volatility & Conditions',
};

export const MACRO_REGISTRY: MacroSeriesDef[] = [
  // Rates & Curve
  { seriesId: 'T10Y2Y', label: '2s10s Spread', assetClass: 'rates', source: 'fred', unit: '%', decimals: 2, role: 'vote', classify: curveClassifier(0.25) },
  { seriesId: 'T10Y3M', label: '3m10y Spread', assetClass: 'rates', source: 'fred', unit: '%', decimals: 2, role: 'context', classify: curveClassifier(0.5) },
  { seriesId: 'DGS10', label: '10Y Yield', assetClass: 'rates', source: 'fred', unit: '%', decimals: 2, role: 'context', classify: percentileClassifier(['LOW', 'NORMAL', 'ELEVATED']) },
  { seriesId: 'DFF', label: 'Fed Funds', assetClass: 'rates', source: 'fred', unit: '%', decimals: 2, role: 'context', classify: bandClassifier(2.5, 4, ['ACCOMMODATIVE', 'NEUTRAL', 'RESTRICTIVE']) },
  // Credit
  { seriesId: 'BAMLH0A0HYM2', label: 'HY OAS Spread', assetClass: 'credit', source: 'fred', unit: '%', decimals: 2, role: 'vote', classify: classifyHySpread },
  // Inflation & Growth
  { seriesId: 'CPIAUCSL', label: 'CPI (YoY)', assetClass: 'inflation_growth', source: 'fred', unit: '%', decimals: 1, role: 'vote', derive: 'yoy', classify: classifyCpiYoY },
  { seriesId: 'UNRATE', label: 'Unemployment', assetClass: 'inflation_growth', source: 'fred', unit: '%', decimals: 1, role: 'vote', classify: classifySahm },
  // Dollar & FX
  { seriesId: 'DTWEXBGS', label: 'Broad USD Index', assetClass: 'dollar_fx', source: 'fred', unit: 'idx', decimals: 1, role: 'context', classify: percentileClassifier(['WEAK', 'MID', 'STRONG']) },
  // Commodities
  { seriesId: 'GC=F', label: 'Gold', assetClass: 'commodities', source: 'yfinance', unit: '$', decimals: 0, role: 'context', classify: percentileClassifier(['LOW', 'FIRM', 'ELEVATED']) },
  { seriesId: 'CL=F', label: 'WTI Crude', assetClass: 'commodities', source: 'yfinance', unit: '$', decimals: 1, role: 'context', classify: percentileClassifier(['CHEAP', 'RANGE', 'RICH']) },
  { seriesId: 'HG=F', label: 'Copper (Dr.)', assetClass: 'commodities', source: 'yfinance', unit: '$', decimals: 2, role: 'vote', classify: classifyCopperMomentum },
  // Volatility & Conditions
  { seriesId: '^VIX', label: 'VIX', assetClass: 'vol_conditions', source: 'yfinance', unit: '', decimals: 1, role: 'vote', classify: classifyVix },
  { seriesId: 'NFCI', label: 'Chicago Fed NFCI', assetClass: 'vol_conditions', source: 'fred', unit: '', decimals: 2, role: 'vote', classify: classifyNfci },
];
```

The 7 voters (`role: 'vote'`) are exactly: `T10Y2Y, BAMLH0A0HYM2, CPIAUCSL, UNRATE, HG=F, ^VIX, NFCI` — one per spec §6.1 theme. The other 6 are `context`.

- [ ] **Step 6: Write the registry-integrity test** (`tests/compute/macro-registry.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { MACRO_REGISTRY, ASSET_CLASS_ORDER } from '@/lib/compute/macro-registry';

describe('macro registry integrity', () => {
  it('has 13 tiles', () => {
    expect(MACRO_REGISTRY).toHaveLength(13);
  });
  it('has exactly 7 voting tiles', () => {
    expect(MACRO_REGISTRY.filter((d) => d.role === 'vote')).toHaveLength(7);
  });
  it('voters are the 7 spec themes', () => {
    const ids = MACRO_REGISTRY.filter((d) => d.role === 'vote').map((d) => d.seriesId).sort();
    expect(ids).toEqual(['BAMLH0A0HYM2', 'CPIAUCSL', 'HG=F', 'NFCI', 'T10Y2Y', 'UNRATE', '^VIX'].sort());
  });
  it('every series id is unique and every asset class is known', () => {
    const ids = new Set(MACRO_REGISTRY.map((d) => d.seriesId));
    expect(ids.size).toBe(13);
    for (const d of MACRO_REGISTRY) expect(ASSET_CLASS_ORDER).toContain(d.assetClass);
  });
});
```

- [ ] **Step 7: Run both compute tests**

Run: `pnpm test -- macro-signals macro-registry`
Expected: PASS (all).

- [ ] **Step 8: Typecheck + commit**

Run: `pnpm typecheck` (expect no errors).
```bash
git add lib/compute/macro-signals.ts lib/compute/macro-registry.ts tests/compute/macro-signals.test.ts tests/compute/macro-registry.test.ts
git commit -m "feat(macro): rule-based signal compute + 13-tile registry" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: MacroService (refreshAll + getBoard + getSeriesDetail)

**Files:**
- Create: `lib/services/macro.ts`
- Test: `tests/integration/macro-service.test.ts`

- [ ] **Step 1: Implement `lib/services/macro.ts`**

```ts
import { asc, eq, sql } from 'drizzle-orm';
import { macroSeries, macroFreshness } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type { FredProvider } from '@/lib/providers/fred';
import type { YFinanceProvider } from '@/lib/providers/yfinance';
import {
  yoySeries, weatherFromVotes, type SeriesPoint, type SignalLevel, type WeatherVerdict,
} from '@/lib/compute/macro-signals';
import {
  MACRO_REGISTRY, ASSET_CLASS_ORDER, ASSET_CLASS_LABEL, type AssetClass, type MacroSeriesDef,
} from '@/lib/compute/macro-registry';
import { logger } from '@/lib/logger';

interface Deps {
  db: ServiceDb;
  fred?: FredProvider;
  yf?: YFinanceProvider;
}

export interface MacroRefreshSummary { attempted: number; ok: number; failed: number }

export interface BoardTile {
  seriesId: string; label: string; assetClass: AssetClass;
  value: number | null; unit: string; decimals: number; change: number | null;
  role: 'vote' | 'context'; badge: string; level: SignalLevel; explain: string;
}
export interface BoardGroup { assetClass: AssetClass; label: string; tiles: BoardTile[] }
export interface MacroBoard {
  weather: WeatherVerdict & { benign: number; neutral: number; caution: number; flashing: string[] };
  asOf: string | null;
  groups: BoardGroup[];
}

function isoDaysAgo(days: number): string {
  const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10);
}
function isoYearsAgo(years: number): string {
  const d = new Date(); d.setFullYear(d.getFullYear() - years); return d.toISOString().slice(0, 10);
}

export class MacroService {
  constructor(private readonly deps: Deps) {}

  // ----- refresh (cron + backfill) -----
  async refreshAll(mode: 'daily' | 'backfill'): Promise<MacroRefreshSummary> {
    if (!this.deps.fred || !this.deps.yf) throw new Error('MacroService.refreshAll requires fred + yf providers');
    const fredStart = mode === 'backfill' ? isoYearsAgo(5) : isoDaysAgo(35);
    const yfRange: '1Y' | '5Y' = mode === 'backfill' ? '5Y' : '1Y';
    let ok = 0, failed = 0;

    for (const def of MACRO_REGISTRY) {
      try {
        const points: SeriesPoint[] = def.source === 'fred'
          ? await this.deps.fred.fetchSeries(def.seriesId, { start: fredStart })
          : (await this.deps.yf.prices(def.seriesId, yfRange)).map((p) => ({ date: p.date, value: p.close }));
        await this.upsert(def.seriesId, def.source, points);
        await this.setFreshness(def.seriesId, points, 'ok', null);
        ok++;
      } catch (err) {
        logger.warn({ seriesId: def.seriesId, err: String(err) }, 'macro: series refresh failed');
        await this.setFreshness(def.seriesId, [], 'error', String(err).slice(0, 500));
        failed++;
      }
    }
    return { attempted: MACRO_REGISTRY.length, ok, failed };
  }

  private async upsert(seriesId: string, source: string, points: SeriesPoint[]): Promise<void> {
    if (points.length === 0) return;
    const rows = points.map((p) => ({ seriesId, obsDate: p.date, value: String(p.value), source }));
    await this.deps.db
      .insert(macroSeries)
      .values(rows)
      .onConflictDoUpdate({
        target: [macroSeries.seriesId, macroSeries.obsDate],
        set: { value: sql`excluded.value`, source: sql`excluded.source` },
      });
  }

  private async setFreshness(seriesId: string, points: SeriesPoint[], status: string, error: string | null): Promise<void> {
    const lastObsDate = points.length ? points[points.length - 1]!.date : null;
    await this.deps.db
      .insert(macroFreshness)
      .values({ seriesId, lastObsDate, status, error })
      .onConflictDoUpdate({
        target: macroFreshness.seriesId,
        set: { lastFetchedAt: sql`now()`, lastObsDate: sql`excluded.last_obs_date`, status, error },
      });
  }

  // ----- read (board) -----
  async getBoard(): Promise<MacroBoard> {
    const rows = await this.deps.db.select().from(macroSeries).orderBy(asc(macroSeries.obsDate));
    const bySeries = new Map<string, SeriesPoint[]>();
    for (const r of rows) {
      const arr = bySeries.get(r.seriesId) ?? [];
      arr.push({ date: r.obsDate, value: Number(r.value) });
      bySeries.set(r.seriesId, arr);
    }

    const tiles: BoardTile[] = MACRO_REGISTRY.map((def) => this.buildTile(def, bySeries.get(def.seriesId) ?? []));

    const voters = tiles.filter((t) => t.role === 'vote');
    const weather = weatherFromVotes(voters.map((t) => t.level));
    const counts = { benign: 0, neutral: 0, caution: 0 };
    const flashing: string[] = [];
    for (const v of voters) {
      if (v.level > 0) counts.benign++;
      else if (v.level < 0) { counts.caution++; flashing.push(v.label); }
      else counts.neutral++;
    }

    const freshRows = await this.deps.db.select().from(macroFreshness);
    const asOf = freshRows
      .map((r) => r.lastObsDate)
      .filter((d): d is string => !!d)
      .sort()
      .pop() ?? null;

    const groups: BoardGroup[] = ASSET_CLASS_ORDER.map((ac) => ({
      assetClass: ac,
      label: ASSET_CLASS_LABEL[ac],
      tiles: tiles.filter((t) => t.assetClass === ac),
    })).filter((g) => g.tiles.length > 0);

    return { weather: { ...weather, ...counts, flashing }, asOf, groups };
  }

  private buildTile(def: MacroSeriesDef, raw: SeriesPoint[]): BoardTile {
    const display = def.derive === 'yoy' ? yoySeries(raw) : raw;
    const n = display.length;
    const value = n ? display[n - 1]!.value : null;
    const change = n >= 2 ? display[n - 1]!.value - display[n - 2]!.value : null;
    const sig = value == null
      ? { badge: 'NO DATA', level: 0 as SignalLevel, explain: 'No data yet.' }
      : def.classify({ value, series: display });
    return {
      seriesId: def.seriesId, label: def.label, assetClass: def.assetClass,
      value, unit: def.unit, decimals: def.decimals, change,
      role: def.role, badge: sig.badge, level: sig.level, explain: sig.explain,
    };
  }

  // ----- read (detail) -----
  async getSeriesDetail(seriesId: string, range: '1y' | '3y' | '5y'): Promise<{
    seriesId: string; label: string; unit: string; decimals: number;
    points: SeriesPoint[]; badge: string; explain: string; asOf: string | null;
  }> {
    const def = MACRO_REGISTRY.find((d) => d.seriesId === seriesId);
    if (!def) throw new Error('unknown series'); // mapped to 404 by the route
    const years = range === '1y' ? 1 : range === '3y' ? 3 : 5;
    const cutoff = isoYearsAgo(years);
    const rows = await this.deps.db
      .select()
      .from(macroSeries)
      .where(eq(macroSeries.seriesId, seriesId))
      .orderBy(asc(macroSeries.obsDate));
    const raw: SeriesPoint[] = rows.map((r) => ({ date: r.obsDate, value: Number(r.value) }));
    const display = def.derive === 'yoy' ? yoySeries(raw) : raw;
    const windowed = display.filter((p) => p.date >= cutoff);
    const value = display.length ? display[display.length - 1]!.value : null;
    const sig = value == null ? { badge: 'NO DATA', explain: 'No data yet.' } : def.classify({ value, series: display });
    const asOf = display.length ? display[display.length - 1]!.date : null;
    return { seriesId, label: def.label, unit: def.unit, decimals: def.decimals, points: windowed, badge: sig.badge, explain: sig.explain, asOf };
  }
}
```

- [ ] **Step 2: Write the integration test** (`tests/integration/macro-service.test.ts`) — uses a fake provider, real test DB

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { macroFreshness } from '@/lib/db/schema';
import { MacroService } from '@/lib/services/macro';
import type { FredProvider } from '@/lib/providers/fred';
import type { YFinanceProvider } from '@/lib/providers/yfinance';

config({ path: '.env.local' });

// Fakes: FRED returns a flat series; yfinance returns price points.
const fakeFred = {
  fetchSeries: async (id: string) => {
    if (id === 'T10Y2Y') return [{ date: '2026-05-29', value: 0.1 }, { date: '2026-06-01', value: -0.5 }]; // inverted
    return [{ date: '2026-06-01', value: 1 }];
  },
} as unknown as FredProvider;
const fakeYf = {
  prices: async () => [{ date: '2026-06-01', open: null, high: null, low: null, close: 15.8, adjClose: null, volume: null }],
} as unknown as YFinanceProvider;

describe('MacroService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await dbH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`);
  });

  it('refreshAll upserts series + freshness for all 13 tiles', async () => {
    const svc = new MacroService({ db: dbH.db, fred: fakeFred, yf: fakeYf });
    const summary = await svc.refreshAll('daily');
    expect(summary.attempted).toBe(13);
    expect(summary.ok).toBe(13);
    const fresh = await dbH.db.select().from(macroFreshness);
    expect(fresh.length).toBe(13);
  });

  it('getBoard returns grouped tiles + a weather verdict', async () => {
    const svc = new MacroService({ db: dbH.db, fred: fakeFred, yf: fakeYf });
    await svc.refreshAll('daily');
    const board = await svc.getBoard();
    expect(board.groups.length).toBe(6);
    const twos = board.groups.flatMap((g) => g.tiles).find((t) => t.seriesId === 'T10Y2Y');
    expect(twos!.badge).toBe('INVERTED');
    expect(twos!.level).toBe(-1);
    expect(['SUNNY', 'FAIR', 'MIXED', 'CLOUDY', 'STORMY']).toContain(board.weather.label);
  });

  it('getSeriesDetail throws for an unknown series', async () => {
    const svc = new MacroService({ db: dbH.db, fred: fakeFred, yf: fakeYf });
    await expect(svc.getSeriesDetail('NOPE', '3y')).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run it**

Run: `pnpm test:integration -- macro-service`
Expected: PASS (3 tests).

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm typecheck`.
```bash
git add lib/services/macro.ts tests/integration/macro-service.test.ts
git commit -m "feat(macro): MacroService — refreshAll, getBoard, getSeriesDetail" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Cron wiring + backfill script

**Files:**
- Modify: `lib/ingest/refresh-runner.ts`, `app/api/cron/refresh/route.ts`, `vercel.json`, `package.json`
- Create: `scripts/seed-macro.ts`

- [ ] **Step 1: Extend `lib/ingest/refresh-runner.ts`**

Change the kind union and `Deps`, and short-circuit macro before the ticker loop.

```ts
// at top imports:
import type { MacroService } from '@/lib/services/macro';

// update the union:
export type RefreshKind = 'snapshot' | 'fundamentals' | 'prices' | 'earnings' | 'macro';

// add to interface Deps:
  macroSvc?: MacroService;
```

Then replace the **top of `runRefresh`** (from `export async function runRefresh` down to and including the `const tickers = await getRefreshTickers(deps.db);` line) with this — `summary` is constructed first, the macro kind short-circuits before `getRefreshTickers` (macro is not per-ticker):

```ts
export async function runRefresh(deps: Deps): Promise<RefreshSummary> {
  const started = Date.now();
  const budget = deps.budgetMs ?? 50_000;

  const summary: RefreshSummary = {
    kind: deps.kind,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0
  };

  if (deps.kind === 'macro') {
    if (!deps.macroSvc) throw new Error('macroSvc required for macro refresh');
    const r = await deps.macroSvc.refreshAll('daily');
    summary.attempted = r.attempted;
    summary.succeeded = r.ok;
    summary.failed = r.failed;
    summary.durationMs = Date.now() - started;
    logger.info(summary, 'refresh-runner: macro done');
    return summary;
  }

  const tickers = await getRefreshTickers(deps.db);
```

Then delete the now-duplicate `const summary: RefreshSummary = { ... }` block that previously sat below `getRefreshTickers` (it has moved above).

- [ ] **Step 2: Wire the cron route** (`app/api/cron/refresh/route.ts`)

```ts
// add imports:
import { MacroService } from '@/lib/services/macro';
import { FredProvider } from '@/lib/providers/fred';

// add 'macro' to VALID_KINDS:
const VALID_KINDS: readonly RefreshKind[] = ['snapshot', 'fundamentals', 'prices', 'earnings', 'macro'];

// extend cachedDeps type + buildDeps to include macro:
//   cachedDeps: { snapshot, financials, prices, macro }
// inside buildDeps(), after the yf/redis lines:
  const macro = new MacroService({ db, fred: new FredProvider(), yf });
//   ...and add `macro` to the returned object.

// in GET, pass it to runRefresh:
  const summary = await runRefresh({
    db: getServiceDb(),
    kind,
    snapshotSvc: deps.snapshot,
    financialsSvc: deps.financials,
    pricesSvc: deps.prices,
    macroSvc: deps.macro,
    budgetMs: 50_000,
  });
```

- [ ] **Step 3: Add the cron schedule** (`vercel.json` → `crons` array)

```json
{ "path": "/api/cron/refresh?kind=macro", "schedule": "0 22 * * *" }
```

- [ ] **Step 4: Write the backfill script** (`scripts/seed-macro.ts`)

```ts
import { config } from 'dotenv';
config({ path: '.env.local', override: false });

import { getServiceDb } from '@/lib/db/client';
import { FredProvider } from '@/lib/providers/fred';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { MacroService } from '@/lib/services/macro';

const svc = new MacroService({ db: getServiceDb(), fred: new FredProvider(), yf: new YFinanceProvider() });
const summary = await svc.refreshAll('backfill');
console.log('macro backfill:', JSON.stringify(summary));
process.exit(summary.failed > 0 ? 1 : 0);
```

- [ ] **Step 5: Add the npm script** (`package.json` → `scripts`)

```json
"seed-macro": "tsx scripts/seed-macro.ts"
```

- [ ] **Step 6: Typecheck, run backfill against the prod branch, verify board renders**

Run: `pnpm typecheck` (expect no errors).
Run: `pnpm seed-macro` (uses `DATABASE_URL_SERVICE_ROLE`; expect `macro backfill: {"attempted":13,"ok":13,...}`; a transient yfinance/FRED failure on 1–2 tiles is acceptable — re-run).
Run (optional, to populate the test branch for later E2E): `DATABASE_URL_SERVICE_ROLE=$DATABASE_URL_TEST_SERVICE_ROLE pnpm seed-macro`.

- [ ] **Step 7: Commit**

```bash
git add lib/ingest/refresh-runner.ts app/api/cron/refresh/route.ts vercel.json package.json scripts/seed-macro.ts
git commit -m "feat(macro): daily cron kind + seed-macro backfill" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Board + detail APIs

**Files:**
- Create: `app/api/macro/route.ts`, `app/api/macro/[seriesId]/route.ts`
- Test: `tests/integration/api-macro.test.ts`

- [ ] **Step 1: Implement the board route** (`app/api/macro/route.ts`)

```ts
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { MacroService } from '@/lib/services/macro';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireUserId();
    const svc = new MacroService({ db: getServiceDb() });
    const board = await svc.getBoard();
    return NextResponse.json(board, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (err) {
    return errorResponse(err, { route: 'macro' });
  }
}
```

- [ ] **Step 2: Implement the detail route** (`app/api/macro/[seriesId]/route.ts`)

```ts
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { NotFoundError, ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { MacroService } from '@/lib/services/macro';

export const dynamic = 'force-dynamic';

const RANGES = ['1y', '3y', '5y'] as const;
type Range = (typeof RANGES)[number];

interface Ctx { params: { seriesId: string } }

export async function GET(req: Request, ctx: Ctx) {
  try {
    await requireUserId();
    const seriesId = decodeURIComponent(ctx.params.seriesId);
    const rangeRaw = new URL(req.url).searchParams.get('range') ?? '3y';
    if (!RANGES.includes(rangeRaw as Range)) throw new ValidationError(`range must be one of ${RANGES.join(', ')}`);
    const svc = new MacroService({ db: getServiceDb() });
    try {
      const detail = await svc.getSeriesDetail(seriesId, rangeRaw as Range);
      return NextResponse.json(detail, { headers: { 'Cache-Control': 'private, max-age=300' } });
    } catch {
      throw new NotFoundError(`Unknown series: ${seriesId}`);
    }
  } catch (err) {
    return errorResponse(err, { route: 'macro/[seriesId]' });
  }
}
```

- [ ] **Step 3: Write the API test** (`tests/integration/api-macro.test.ts`) — calls the service path (auth is integration-mocked in this repo's other API tests via the service layer; assert shape)

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { MacroService } from '@/lib/services/macro';
import type { FredProvider } from '@/lib/providers/fred';
import type { YFinanceProvider } from '@/lib/providers/yfinance';

config({ path: '.env.local' });

const fakeFred = { fetchSeries: async () => [{ date: '2026-06-01', value: 1 }] } as unknown as FredProvider;
const fakeYf = { prices: async () => [{ date: '2026-06-01', open: null, high: null, low: null, close: 10, adjClose: null, volume: null }] } as unknown as YFinanceProvider;

describe('macro board shape', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => { await dbH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`); });

  it('produces weather + 6 groups + 13 tiles', async () => {
    const svc = new MacroService({ db: dbH.db, fred: fakeFred, yf: fakeYf });
    await svc.refreshAll('daily');
    const board = await svc.getBoard();
    expect(board.weather.label).toBeTypeOf('string');
    expect(board.groups).toHaveLength(6);
    expect(board.groups.flatMap((g) => g.tiles)).toHaveLength(13);
  });
});
```

- [ ] **Step 4: Run it**

Run: `pnpm test:integration -- api-macro`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck`.
```bash
git add app/api/macro/route.ts "app/api/macro/[seriesId]/route.ts" tests/integration/api-macro.test.ts
git commit -m "feat(macro): board + series-detail API routes" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Board UI — page, hero, tiles (Variant A)

**Files:**
- Create: `app/(app)/macro/page.tsx`, `app/(app)/macro/_components/macro-board.tsx`, `app/(app)/macro/_components/macro-tile.tsx`
- Modify: `app/(app)/_components/nav.tsx`

- [ ] **Step 1: Add the nav link** (`app/(app)/_components/nav.tsx`) — after the Watchlist `<Link>`

```tsx
          <Link href="/macro" className="text-sm text-muted-foreground hover:text-foreground">
            Macro
          </Link>
```

- [ ] **Step 2: Server page** (`app/(app)/macro/page.tsx`)

```tsx
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { MacroService } from '@/lib/services/macro';
import { MacroBoard } from './_components/macro-board';

export const dynamic = 'force-dynamic';

export default async function MacroPage() {
  await requireUserId();
  const board = await new MacroService({ db: getServiceDb() }).getBoard();
  return (
    <main className="container mx-auto px-4 py-6">
      <h1 className="text-xl font-semibold tracking-tight mb-4">Macro Weather</h1>
      <MacroBoard board={board} />
    </main>
  );
}
```

- [ ] **Step 3: Tile component** (`app/(app)/macro/_components/macro-tile.tsx`)

```tsx
'use client';

import type { BoardTile } from '@/lib/services/macro';

const VOTE_BADGE: Record<number, string> = {
  [-1]: 'bg-red-950 text-red-300 border-red-900',
  [0]: 'bg-slate-800 text-slate-300 border-slate-700',
  [1]: 'bg-emerald-950 text-emerald-300 border-emerald-900',
};

function fmt(t: BoardTile): string {
  if (t.value == null) return '—';
  const v = t.value.toLocaleString(undefined, { minimumFractionDigits: t.decimals, maximumFractionDigits: t.decimals });
  return t.unit === '$' ? `$${v}` : t.unit === '%' ? `${v}%` : v;
}

export function MacroTile({ tile, onOpen }: { tile: BoardTile; onOpen: (seriesId: string) => void }) {
  const isVote = tile.role === 'vote';
  const badgeClass = isVote
    ? VOTE_BADGE[tile.level]
    : tile.level !== 0
      ? 'bg-amber-950 text-amber-300 border-amber-900'
      : 'bg-slate-800 text-slate-400 border-slate-700';
  return (
    <button
      onClick={() => onOpen(tile.seriesId)}
      className={`text-left rounded-xl border p-3 transition hover:border-foreground/40 ${isVote ? 'bg-card border-border' : 'bg-card/60 border-dashed border-border'}`}
    >
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {isVote && <span className={`inline-block w-1.5 h-1.5 rounded-full ${tile.level < 0 ? 'bg-red-400' : tile.level > 0 ? 'bg-emerald-400' : 'bg-slate-400'}`} />}
          {tile.label}
        </span>
      </div>
      <div className="text-xl font-bold mt-1">{fmt(tile)}</div>
      {tile.change != null && (
        <div className={`text-[11px] mt-0.5 ${tile.change > 0 ? 'text-emerald-400' : tile.change < 0 ? 'text-red-400' : 'text-muted-foreground'}`}>
          {tile.change > 0 ? '▲' : tile.change < 0 ? '▼' : '—'} {Math.abs(tile.change).toFixed(tile.decimals)}
        </div>
      )}
      <span className={`inline-block mt-2 rounded-full border px-2 py-0.5 text-[9px] font-bold tracking-wide ${badgeClass}`}>{tile.badge}</span>
    </button>
  );
}
```

- [ ] **Step 4: Board component** (`app/(app)/macro/_components/macro-board.tsx`)

```tsx
'use client';

import { useState } from 'react';
import type { MacroBoard as MacroBoardData } from '@/lib/services/macro';
import { MacroTile } from './macro-tile';
import { MacroDetail } from './macro-detail';

export function MacroBoard({ board }: { board: MacroBoardData }) {
  const [open, setOpen] = useState<string | null>(null);
  const w = board.weather;
  return (
    <div>
      <div className="rounded-2xl border border-amber-700/60 bg-gradient-to-r from-amber-950/40 to-card p-4 mb-5">
        <div className="text-2xl font-extrabold">
          {w.icon} {w.label} <span className="text-sm font-semibold text-amber-400">· score {w.score >= 0 ? '+' : ''}{w.score} / 7</span>
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          {w.benign} benign · {w.neutral} neutral · {w.caution} caution
          {w.flashing.length > 0 && <> · flashing: <b>{w.flashing.join(', ')}</b></>}
        </div>
        {board.asOf && <div className="text-[11px] text-muted-foreground mt-1">as of {board.asOf}</div>}
      </div>

      {board.groups.map((g) => (
        <section key={g.assetClass} className="mb-4">
          <h2 className="text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border pb-1 mb-2">{g.label}</h2>
          <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(176px,1fr))' }}>
            {g.tiles.map((t) => <MacroTile key={t.seriesId} tile={t} onOpen={setOpen} />)}
          </div>
        </section>
      ))}

      <MacroDetail seriesId={open} onClose={() => setOpen(null)} />
    </div>
  );
}
```

- [ ] **Step 5: Temporary stub for the drawer so the board compiles** (`app/(app)/macro/_components/macro-detail.tsx`)

```tsx
'use client';
// Temporary stub so macro-board compiles; replaced by the real drawer in Task 9.
export function MacroDetail(_props: { seriesId: string | null; onClose: () => void }) {
  return null;
}
```

(Task 9 replaces this file with the real recharts drawer.)

- [ ] **Step 6: Typecheck + visual check**

Run: `pnpm typecheck` (expect no errors).
Run: `pnpm dev`, open `http://localhost:3000/macro`, confirm the hero + six sections + 13 tiles render (after Task 6 backfill populated data). Confirm the "Macro" nav link works.

- [ ] **Step 7: Commit**

```bash
git add "app/(app)/macro/page.tsx" "app/(app)/macro/_components/macro-board.tsx" "app/(app)/macro/_components/macro-tile.tsx" "app/(app)/macro/_components/macro-detail.tsx" "app/(app)/_components/nav.tsx"
git commit -m "feat(macro): /macro board UI (Variant A) + nav entry" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Detail drawer (Radix dialog + recharts)

**Files:**
- Replace: `app/(app)/macro/_components/macro-detail.tsx`

- [ ] **Step 1: Implement the drawer**

```tsx
'use client';

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface Detail {
  seriesId: string; label: string; unit: string; decimals: number;
  points: { date: string; value: number }[]; badge: string; explain: string; asOf: string | null;
}
const RANGES = ['1y', '3y', '5y'] as const;
type Range = (typeof RANGES)[number];

export function MacroDetail({ seriesId, onClose }: { seriesId: string | null; onClose: () => void }) {
  const [range, setRange] = useState<Range>('3y');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!seriesId) { setDetail(null); return; }
    let alive = true;
    setLoading(true);
    fetch(`/api/macro/${encodeURIComponent(seriesId)}?range=${range}`)
      .then((r) => r.json())
      .then((d) => { if (alive) setDetail(d as Detail); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [seriesId, range]);

  return (
    <Dialog.Root open={!!seriesId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed right-0 top-0 h-full w-full max-w-lg bg-background border-l border-border p-5 overflow-y-auto">
          <Dialog.Title className="text-lg font-semibold">{detail?.label ?? seriesId}</Dialog.Title>
          <Dialog.Description className="text-xs text-muted-foreground mb-3">{detail?.explain ?? ''}</Dialog.Description>

          <div className="flex gap-1.5 mb-3">
            {RANGES.map((r) => (
              <button key={r} onClick={() => setRange(r)}
                className={`rounded-md border px-2 py-1 text-xs ${range === r ? 'bg-foreground text-background' : 'border-border text-muted-foreground'}`}>
                {r.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="h-64">
            {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
            {!loading && detail && detail.points.length > 0 && (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={detail.points}>
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={40} />
                  <YAxis tick={{ fontSize: 10 }} width={44} domain={['auto', 'auto']} />
                  <Tooltip />
                  <Line type="monotone" dataKey="value" stroke="#60a5fa" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            )}
            {!loading && detail && detail.points.length === 0 && <div className="text-sm text-muted-foreground">No data in range.</div>}
          </div>

          {detail?.asOf && <div className="text-[11px] text-muted-foreground mt-3">as of {detail.asOf} · current signal: <b>{detail.badge}</b></div>}

          <Dialog.Close className="absolute top-4 right-4 text-muted-foreground hover:text-foreground text-sm">✕</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 2: Typecheck + visual check**

Run: `pnpm typecheck`.
Run: `pnpm dev`, open `/macro`, click a tile → drawer opens with the history chart + rule explanation + range toggle + as-of. Click another tile, toggle ranges, close.

- [ ] **Step 3: Commit**

```bash
git add "app/(app)/macro/_components/macro-detail.tsx"
git commit -m "feat(macro): tile detail drawer (recharts history + rule + as-of)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: E2E skip spec + stale/empty states + final checks

**Files:**
- Create: `tests/e2e/macro.spec.ts`
- Modify: `app/(app)/macro/_components/macro-board.tsx` (stale/empty banner)

- [ ] **Step 1: Add empty + stale handling to the board** (`macro-board.tsx`)

At the top of `MacroBoard`, before the hero:

```tsx
  const allEmpty = board.groups.every((g) => g.tiles.every((t) => t.value == null));
  if (allEmpty) {
    return <div className="rounded-xl border border-border p-6 text-sm text-muted-foreground">No macro data yet. Run <code>pnpm seed-macro</code> to backfill, then the daily cron keeps it fresh.</div>;
  }
```

And a stale hint under the hero `asOf` line (a series is "stale" if `asOf` is more than 5 days old):

```tsx
        {board.asOf && Date.now() - new Date(board.asOf).getTime() > 5 * 864e5 && (
          <div className="text-[11px] text-amber-400 mt-1">⚠ data looks stale — last refresh {board.asOf}</div>
        )}
```

- [ ] **Step 2: Add the E2E skip spec** (`tests/e2e/macro.spec.ts`) — matches the skipped-authed convention

```ts
import { test, expect } from '@playwright/test';

// Authed E2E specs are skipped pending the Stack Auth ESM fixture fix (see handoff).
test.skip('macro board renders and a tile opens the detail drawer', async ({ page }) => {
  await page.goto('/macro');
  await expect(page.getByText('Macro Weather')).toBeVisible();
  await expect(page.getByText(/SUNNY|FAIR|MIXED|CLOUDY|STORMY/)).toBeVisible();
  await page.getByRole('button', { name: /2s10s Spread/ }).click();
  await expect(page.getByText(/as of/)).toBeVisible();
});
```

- [ ] **Step 3: Full verification pass**

Run: `pnpm typecheck` (no errors).
Run: `pnpm test` (all pure unit suites pass, including macro-signals + macro-registry + fred).
Run: `pnpm test:integration` (macro-schema, macro-rls, macro-service, api-macro pass).
Run: `pnpm lint` (no new errors).
Run: `pnpm build` (compiles; `/macro` appears in the route list).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/macro.spec.ts "app/(app)/macro/_components/macro-board.tsx"
git commit -m "feat(macro): empty/stale states + skipped E2E happy-path" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Deploy verification**

Push happens automatically via direct-to-master commits. Confirm Vercel build is green and the `kind=macro` cron is registered (Vercel dashboard → Cron). Confirm `FRED_API_KEY` is set in Vercel env if you obtained a key (optional — keyless works without it).

---

## Notes for the executor

- **FRED_API_KEY** is optional. Without it, `FredProvider` uses the keyless CSV endpoint. If you add one, set it in `.env.local` and Vercel env — no code change needed (the provider reads `process.env.FRED_API_KEY`).
- **FRED throttling:** `refreshAll` already fetches series **sequentially**, which avoids the keyless-endpoint rate limiting observed during design. Do not parallelize the FRED loop.
- **yfinance tickers** (`GC=F`, `CL=F`, `HG=F`, `^VIX`) go through the existing subprocess provider; they were verified live during design. `CL=F` uses the identical futures path as the verified `GC=F`/`HG=F`.
- **Both Neon branches:** every schema migration (Task 1) and RLS file (Task 2) must be applied to **test and prod**. Integration tests run against the test branch.
- **Commit trailer** must be exactly the 4.7 line shown in every commit above.
