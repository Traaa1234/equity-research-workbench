# Country Scorecard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a ranked heatmap country scorecard at `/macro/countries` — ~16 countries scored 0–100 on 5 percentile-ranked dimensions (growth, inflation, rates, labor, equity momentum), reusing the A1 macro foundation.

**Architecture:** Country FRED-international series + country-ETF prices land in the **existing `macro_series`** table (no new table/migration/RLS). A code registry maps each country to its series; pure cross-country percentile scoring (`lib/compute/country-score.ts`) computes the composite on read; a `CountryScorecardService` + two API routes + a sortable heatmap UI surface it. A weekly `countries` cron refreshes; a batched yfinance fetch keeps it within budget.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Drizzle + Neon, Vitest, recharts, Radix dialog, Python (yfinance subprocess + Vercel fallback). pnpm.

**Spec:** `docs/superpowers/specs/2026-06-03-country-scorecard-design.md`.

**Reference implementations to mirror (shipped in A1 this session):** `lib/compute/macro-signals.ts` + `macro-registry.ts`, `lib/services/macro.ts`, `app/api/macro/route.ts` + `app/api/macro/[seriesId]/route.ts`, `app/(app)/macro/page.tsx` + `_components/{macro-board,macro-tile,macro-detail}.tsx`, `lib/ingest/refresh-runner.ts` (the `macro` kind), `scripts/seed-macro.ts`.

**Conventions:** direct commit to master; trailer exactly `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`; `numeric` reads as string → `Number(...)`; pure tests in `tests/compute`/`tests/providers` run via `pnpm test`, DB tests in `tests/integration` via `pnpm test:integration`; `pnpm typecheck` must pass before each commit.

---

## File structure

**Create:**
- `lib/compute/country-registry.ts` — 16 countries + ETFs + FRED series ids.
- `lib/compute/country-score.ts` — pure derivations + cross-country percentile scoring.
- `lib/services/country-scorecard.ts` — `refreshAll` / `getScorecard` / `getCountryDetail`.
- `scripts/seed-countries.ts` — 5yr backfill.
- `app/api/countries/route.ts`, `app/api/countries/[code]/route.ts`.
- `app/(app)/macro/countries/page.tsx` + `_components/country-scorecard.tsx` + `country-detail.tsx`.
- Tests: `tests/compute/country-score.test.ts`, `tests/compute/country-registry.test.ts`, `tests/providers/yfinance-batch.test.ts`, `tests/integration/country-scorecard-service.test.ts`, `tests/integration/api-countries.test.ts`, `tests/e2e/countries.spec.ts`.

**Modify:**
- `scripts/yfinance_fetch.py` + `api/fallback/yfinance.py` — add `prices_batch_1y`/`prices_batch_5y`.
- `lib/providers/yfinance.ts` — `pricesBatch()` method + Kind union.
- `lib/ingest/refresh-runner.ts` — add `'countries'` kind + `countrySvc` dep.
- `app/api/cron/refresh/route.ts` — build `CountryScorecardService`, allow `kind=countries`.
- `vercel.json` — weekly countries cron. `package.json` — `seed-countries` script.
- `app/(app)/_components/nav.tsx` — "Countries" nav entry.

---

## Task 1: Country registry (+ live series verification)

**Files:** Create `lib/compute/country-registry.ts`, `tests/compute/country-registry.test.ts`; temporary `scripts/_verify-country-series.ts`.

- [ ] **Step 1: Write the registry** (`lib/compute/country-registry.ts`). Uniform FRED families: CLI `<ISO3>LOLITOAASTSAM`, unemployment `LRHUTTTT<ISO2>M156S`, long rate `IRLTLT01<ISO2>M156N`. `cpi` is best-effort (verified in Step 3; `null` ⇒ neutral inflation).

```ts
export interface CountryDef {
  code: string;          // ISO2 app key, e.g. 'US'
  name: string;
  flag: string;          // emoji
  etf: string;           // yfinance symbol
  series: {
    cli: string | null;          // OECD CLI
    unemployment: string | null; // harmonized unemployment
    longRate: string | null;     // 10y gov yield
    cpi: string | null;          // current CPI index → YoY (best-effort)
  };
}

export const COUNTRY_REGISTRY: CountryDef[] = [
  { code: 'US', name: 'United States', flag: '🇺🇸', etf: 'SPY',  series: { cli: 'USALOLITOAASTSAM', unemployment: 'LRHUTTTTUSM156S', longRate: 'IRLTLT01USM156N', cpi: 'CPIAUCSL' } },
  { code: 'CA', name: 'Canada',        flag: '🇨🇦', etf: 'EWC',  series: { cli: 'CANLOLITOAASTSAM', unemployment: 'LRHUTTTTCAM156S', longRate: 'IRLTLT01CAM156N', cpi: null } },
  { code: 'GB', name: 'United Kingdom',flag: '🇬🇧', etf: 'EWU',  series: { cli: 'GBRLOLITOAASTSAM', unemployment: 'LRHUTTTTGBM156S', longRate: 'IRLTLT01GBM156N', cpi: null } },
  { code: 'DE', name: 'Germany',       flag: '🇩🇪', etf: 'EWG',  series: { cli: 'DEULOLITOAASTSAM', unemployment: 'LRHUTTTTDEM156S', longRate: 'IRLTLT01DEM156N', cpi: null } },
  { code: 'FR', name: 'France',        flag: '🇫🇷', etf: 'EWQ',  series: { cli: 'FRALOLITOAASTSAM', unemployment: 'LRHUTTTTFRM156S', longRate: 'IRLTLT01FRM156N', cpi: null } },
  { code: 'IT', name: 'Italy',         flag: '🇮🇹', etf: 'EWI',  series: { cli: 'ITALOLITOAASTSAM', unemployment: 'LRHUTTTTITM156S', longRate: 'IRLTLT01ITM156N', cpi: null } },
  { code: 'ES', name: 'Spain',         flag: '🇪🇸', etf: 'EWP',  series: { cli: 'ESPLOLITOAASTSAM', unemployment: 'LRHUTTTTESM156S', longRate: 'IRLTLT01ESM156N', cpi: null } },
  { code: 'JP', name: 'Japan',         flag: '🇯🇵', etf: 'EWJ',  series: { cli: 'JPNLOLITOAASTSAM', unemployment: 'LRHUTTTTJPM156S', longRate: 'IRLTLT01JPM156N', cpi: null } },
  { code: 'AU', name: 'Australia',     flag: '🇦🇺', etf: 'EWA',  series: { cli: 'AUSLOLITOAASTSAM', unemployment: 'LRHUTTTTAUM156S', longRate: 'IRLTLT01AUM156N', cpi: null } },
  { code: 'KR', name: 'South Korea',   flag: '🇰🇷', etf: 'EWY',  series: { cli: 'KORLOLITOAASTSAM', unemployment: 'LRHUTTTTKRM156S', longRate: 'IRLTLT01KRM156N', cpi: null } },
  { code: 'CN', name: 'China',         flag: '🇨🇳', etf: 'MCHI', series: { cli: 'CHNLOLITOAASTSAM', unemployment: null, longRate: null, cpi: null } },
  { code: 'IN', name: 'India',         flag: '🇮🇳', etf: 'INDA', series: { cli: 'INDLOLITOAASTSAM', unemployment: null, longRate: null, cpi: null } },
  { code: 'BR', name: 'Brazil',        flag: '🇧🇷', etf: 'EWZ',  series: { cli: 'BRALOLITOAASTSAM', unemployment: null, longRate: null, cpi: null } },
  { code: 'MX', name: 'Mexico',        flag: '🇲🇽', etf: 'EWW',  series: { cli: 'MEXLOLITOAASTSAM', unemployment: null, longRate: null, cpi: null } },
  { code: 'TW', name: 'Taiwan',        flag: '🇹🇼', etf: 'EWT',  series: { cli: null, unemployment: null, longRate: null, cpi: null } },
  { code: 'ZA', name: 'South Africa',  flag: '🇿🇦', etf: 'EZA',  series: { cli: 'ZAFLOLITOAASTSAM', unemployment: null, longRate: null, cpi: null } },
];

/** Every distinct, non-null FRED series id across the registry (for refresh). */
export function countryFredIds(): string[] {
  const ids = new Set<string>();
  for (const c of COUNTRY_REGISTRY) for (const v of Object.values(c.series)) if (v) ids.add(v);
  return [...ids];
}
/** Every ETF symbol (for the batched price fetch). */
export function countryEtfs(): string[] {
  return COUNTRY_REGISTRY.map((c) => c.etf);
}
```

- [ ] **Step 2: Write the verification script** `scripts/_verify-country-series.ts` (temporary — do NOT commit). It probes every registry FRED id (current?), and for each country with `cpi: null` tries candidate current-CPI patterns, printing a coverage report.

```ts
import { config } from 'dotenv'; config({ path: '.env.local', override: false });
import { COUNTRY_REGISTRY, countryFredIds } from '@/lib/compute/country-registry';

async function lastRow(id: string): Promise<string> {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=2025-01-01`);
  if (!res.ok) return `HTTP ${res.status}`;
  const lines = (await res.text()).trim().split(/\r?\n/).filter((l) => l && !l.endsWith(','));
  return lines[lines.length - 1] ?? '<none>';
}
for (const id of countryFredIds()) { console.log(id.padEnd(20), await lastRow(id)); await new Promise(r=>setTimeout(r,700)); }
console.log('--- CPI candidates for null-cpi countries ---');
for (const c of COUNTRY_REGISTRY) {
  if (c.series.cpi) continue;
  for (const cand of [`${c.code}CPIALLMINMEI`, `CPALTT01${c.code}M657N`, `CPALTT01${c.code}M661N`]) {
    console.log(c.code, cand, await lastRow(cand)); await new Promise(r=>setTimeout(r,700));
  }
}
process.exit(0);
```

- [ ] **Step 3: Run verification, finalize the registry**
Run: `pnpm tsx scripts/_verify-country-series.ts`. For each FRED id that returns `<none>`/`HTTP 4xx`/a stale date (> 4 months old), set it to `null` in the registry (so it scores neutral). For each `cpi: null` country where a candidate returns CURRENT data, set `cpi` to that id. Document in a comment which countries ended up with which dims. Then `rm scripts/_verify-country-series.ts`. (Inflation will be partial — that's the accepted best-effort outcome.)

- [ ] **Step 4: Registry integrity test** (`tests/compute/country-registry.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { COUNTRY_REGISTRY, countryFredIds, countryEtfs } from '@/lib/compute/country-registry';

describe('country registry', () => {
  it('has 16 countries with unique codes + ETFs', () => {
    expect(COUNTRY_REGISTRY).toHaveLength(16);
    expect(new Set(COUNTRY_REGISTRY.map((c) => c.code)).size).toBe(16);
    expect(new Set(COUNTRY_REGISTRY.map((c) => c.etf)).size).toBe(16);
  });
  it('every country has name/flag/etf and a series object', () => {
    for (const c of COUNTRY_REGISTRY) {
      expect(c.name && c.flag && c.etf).toBeTruthy();
      expect(c.series).toHaveProperty('cli');
    }
  });
  it('countryFredIds dedupes and excludes null', () => {
    expect(countryFredIds().every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(countryEtfs()).toContain('SPY');
  });
});
```

- [ ] **Step 5: Typecheck + commit**
Run `pnpm test -- country-registry` and `pnpm typecheck`. Then:
```
git add lib/compute/country-registry.ts tests/compute/country-registry.test.ts
git commit -m "feat(countries): country registry (16 countries, FRED series + ETFs, verified)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Cross-country scoring (the brain)

**Files:** Create `lib/compute/country-score.ts`, `tests/compute/country-score.test.ts`.

- [ ] **Step 1: Write the failing test** (`tests/compute/country-score.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { percentile, orientedPercentile, changeOverMonths, pctReturnOverMonths, pctVsMA, scoreCountries } from '@/lib/compute/country-score';

const s = (vals: [string, number][]) => vals.map(([date, value]) => ({ date, value }));

describe('helpers', () => {
  it('percentile', () => {
    expect(percentile([1, 2, 3, 4], 4)).toBeCloseTo(100);
    expect(percentile([1, 2, 3, 4], 1)).toBeCloseTo(25);
    expect(percentile([], 5)).toBe(50);
  });
  it('orientedPercentile inverts for lower-is-better', () => {
    expect(orientedPercentile([1, 2, 3, 4], 1, 'lower')).toBeCloseTo(75);
    expect(orientedPercentile([1, 2, 3, 4], 4, 'lower')).toBeCloseTo(0);
  });
  it('changeOverMonths / pctReturnOverMonths', () => {
    const series = s([['2026-01-01', 100], ['2026-07-01', 112]]);
    expect(changeOverMonths(series, 6)).toBeCloseTo(12);
    expect(pctReturnOverMonths(series, 6)).toBeCloseTo(12);
  });
  it('pctVsMA', () => {
    const series = s(Array.from({ length: 250 }, (_, i) => [`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, 100] as [string, number]));
    series[series.length - 1] = { date: '2026-09-01', value: 110 };
    expect(pctVsMA(series, 200)!).toBeGreaterThan(0);
  });
});

describe('scoreCountries', () => {
  const mk = (code: string, cli: number, etf6mo: number) => ({
    code, name: code, flag: '🏳️', series: {
      cli: s([['2026-01-01', cli - 2], ['2026-07-01', cli]]),
      unemployment: [], longRate: [], cpi: [],
      etf: s([['2026-01-01', 100], ['2026-07-01', 100 * (1 + etf6mo / 100)]]),
    },
  });
  it('ranks higher-growth + higher-momentum countries above', () => {
    const rows = scoreCountries([mk('AAA', 102, 20), mk('BBB', 98, -10), mk('CCC', 100, 5)]);
    expect(rows[0]!.code).toBe('AAA');
    expect(rows[rows.length - 1]!.code).toBe('BBB');
    expect(rows[0]!.rank).toBe(1);
  });
  it('missing dimension scores 50 (neutral), not 0', () => {
    const rows = scoreCountries([mk('AAA', 102, 20), mk('BBB', 98, -10)]);
    // inflation/rates/labor series are empty for all → those dims are 50 for everyone
    const aaa = rows.find((r) => r.code === 'AAA')!;
    expect(aaa.dims.inflation).toBe(50);
    expect(aaa.dims.rates).toBe(50);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm test -- country-score` → FAIL (module missing).

- [ ] **Step 3: Implement `lib/compute/country-score.ts`**

```ts
export interface SeriesPoint { date: string; value: number }
export type Direction = 'higher' | 'lower';

export interface CountryInput {
  code: string; name: string; flag: string;
  series: { cli: SeriesPoint[]; unemployment: SeriesPoint[]; longRate: SeriesPoint[]; cpi: SeriesPoint[]; etf: SeriesPoint[] };
}
export interface RankedRow {
  code: string; name: string; flag: string; composite: number; rank: number;
  dims: { growth: number; inflation: number; rates: number; labor: number; equity: number };
}

// ---- helpers ----
export function percentile(values: number[], v: number): number {
  if (values.length === 0) return 50;
  return (values.filter((x) => x <= v).length / values.length) * 100;
}
export function orientedPercentile(values: number[], v: number, dir: Direction): number {
  const p = percentile(values, v);
  return dir === 'lower' ? 100 - p : p;
}
function last(series: SeriesPoint[]): number | null { return series.length ? series[series.length - 1]!.value : null; }
function valueMonthsAgo(series: SeriesPoint[], months: number): number | null {
  if (series.length === 0) return null;
  const target = new Date(series[series.length - 1]!.date); target.setMonth(target.getMonth() - months);
  let best: SeriesPoint | null = null;
  for (const p of series) { if (new Date(p.date).getTime() <= target.getTime()) best = p; else break; }
  return best ? best.value : series[0]!.value;
}
export function changeOverMonths(series: SeriesPoint[], months: number): number | null {
  const l = last(series), past = valueMonthsAgo(series, months);
  return l == null || past == null ? null : l - past;
}
export function pctReturnOverMonths(series: SeriesPoint[], months: number): number | null {
  const l = last(series), past = valueMonthsAgo(series, months);
  return l == null || past == null || past === 0 ? null : ((l - past) / past) * 100;
}
export function pctVsMA(series: SeriesPoint[], days: number): number | null {
  if (series.length < Math.min(days, 20)) return null;
  const window = series.slice(-days);
  const ma = window.reduce((a, b) => a + b.value, 0) / window.length;
  const l = last(series);
  return l == null || ma === 0 ? null : ((l - ma) / ma) * 100;
}
function yoyLatest(series: SeriesPoint[]): number | null {
  const l = last(series), prior = valueMonthsAgo(series, 12);
  return l == null || prior == null || prior === 0 ? null : ((l - prior) / prior) * 100;
}
function yoySeries(series: SeriesPoint[]): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (let i = 12; i < series.length; i++) {
    const prior = valueMonthsAgo(series.slice(0, i + 1), 12);
    if (prior != null && prior !== 0) out.push({ date: series[i]!.date, value: ((series[i]!.value - prior) / prior) * 100 });
  }
  return out;
}

// ---- metric extraction (raw value per country per metric; null if unavailable) ----
type MetricKey =
  | 'growthLevel' | 'growthMom' | 'inflLevel' | 'inflMom' | 'ratesLevel' | 'ratesMom'
  | 'laborLevel' | 'laborMom' | 'equityLevel' | 'equityMom';

const DIRECTION: Record<MetricKey, Direction> = {
  growthLevel: 'higher', growthMom: 'higher',
  inflLevel: 'lower', inflMom: 'lower',
  ratesLevel: 'lower', ratesMom: 'lower',
  laborLevel: 'lower', laborMom: 'lower',
  equityLevel: 'higher', equityMom: 'higher',
};
const DIMS: Record<keyof RankedRow['dims'], [MetricKey, MetricKey]> = {
  growth: ['growthLevel', 'growthMom'],
  inflation: ['inflLevel', 'inflMom'],
  rates: ['ratesLevel', 'ratesMom'],
  labor: ['laborLevel', 'laborMom'],
  equity: ['equityLevel', 'equityMom'],
};

function rawMetrics(c: CountryInput): Record<MetricKey, number | null> {
  const infl = yoySeries(c.series.cpi);
  return {
    growthLevel: last(c.series.cli),
    growthMom: changeOverMonths(c.series.cli, 6),
    inflLevel: yoyLatest(c.series.cpi),
    inflMom: changeOverMonths(infl, 6),
    ratesLevel: last(c.series.longRate),
    ratesMom: changeOverMonths(c.series.longRate, 6),
    laborLevel: last(c.series.unemployment),
    laborMom: changeOverMonths(c.series.unemployment, 12),
    equityLevel: pctReturnOverMonths(c.series.etf, 6),
    equityMom: pctVsMA(c.series.etf, 200),
  };
}

// ---- cross-country scoring ----
export function scoreCountries(countries: CountryInput[]): RankedRow[] {
  const raw = countries.map((c) => ({ c, m: rawMetrics(c) }));
  // per-metric pools of present values, across countries
  const pools = {} as Record<MetricKey, number[]>;
  (Object.keys(DIRECTION) as MetricKey[]).forEach((k) => {
    pools[k] = raw.map((r) => r.m[k]).filter((v): v is number => v != null);
  });
  const rows: RankedRow[] = raw.map(({ c, m }) => {
    const metricPct = (k: MetricKey): number => (m[k] == null ? 50 : orientedPercentile(pools[k], m[k]!, DIRECTION[k]));
    const dims = {} as RankedRow['dims'];
    (Object.keys(DIMS) as (keyof RankedRow['dims'])[]).forEach((d) => {
      const [lv, mo] = DIMS[d];
      dims[d] = Math.round((metricPct(lv) + metricPct(mo)) / 2);
    });
    const composite = Math.round((dims.growth + dims.inflation + dims.rates + dims.labor + dims.equity) / 5);
    return { code: c.code, name: c.name, flag: c.flag, composite, rank: 0, dims };
  });
  rows.sort((a, b) => b.composite - a.composite || a.code.localeCompare(b.code));
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}
```

- [ ] **Step 4: Run to verify it passes** — `pnpm test -- country-score` → PASS.

- [ ] **Step 5: Typecheck + commit**
```
git add lib/compute/country-score.ts tests/compute/country-score.test.ts
git commit -m "feat(countries): cross-country percentile scoring engine" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: yfinance batch price fetch

**Files:** Modify `scripts/yfinance_fetch.py`, `api/fallback/yfinance.py`, `lib/providers/yfinance.ts`. Test `tests/providers/yfinance-batch.test.ts`.

- [ ] **Step 1: Add `fetch_prices_batch` + dispatch to `scripts/yfinance_fetch.py`**
After `fetch_prices`, add:
```python
def fetch_prices_batch(tickers_csv: str, years: int) -> dict:
    tickers = [t.strip().upper() for t in tickers_csv.split(",") if t.strip()]
    out = {}
    for tk in tickers:
        try:
            out[tk] = fetch_prices(tk, years).get("prices", [])
        except Exception:
            out[tk] = []
    return {"series": out}
```
In `main()`, before the final `else: fail(...)`, add:
```python
        elif kind == "prices_batch_1y":
            print(json.dumps(fetch_prices_batch(ticker, 1)))
        elif kind == "prices_batch_5y":
            print(json.dumps(fetch_prices_batch(ticker, 5)))
```

- [ ] **Step 2: Mirror in `api/fallback/yfinance.py`**
After `fetch_prices`, add the SAME `fetch_prices_batch` function. In `dispatch()`, before `return 400, {"error": f"Unknown kind...`, add:
```python
        if kind == "prices_batch_1y":
            return 200, fetch_prices_batch(ticker, 1)
        if kind == "prices_batch_5y":
            return 200, fetch_prices_batch(ticker, 5)
```
(The GET handler already `.upper()`s the `ticker` param; a comma list survives upper-casing and `fetch_prices_batch` re-splits it.)

- [ ] **Step 3: Add the provider method + Kind to `lib/providers/yfinance.ts`**
Add `'prices_batch_1y'` and `'prices_batch_5y'` to the `Kind` union. Add a method (after `prices`):
```ts
  async pricesBatch(symbols: string[], range: '1Y' | '5Y'): Promise<Record<string, PricePoint[]>> {
    const kind: Kind = range === '1Y' ? 'prices_batch_1y' : 'prices_batch_5y';
    const out = await this.run(symbols.join(','), kind);
    return (out?.series ?? {}) as Record<string, PricePoint[]>;
  }
```
(`run()` already upper-cases and, in HTTP mode, `encodeURIComponent`s the ticker arg — the comma list is passed as the `ticker`.)

- [ ] **Step 4: Write the provider test** (`tests/providers/yfinance-batch.test.ts`) — subprocess path with a mocked spawn returning a batch JSON.

```ts
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { YFinanceProvider } from '@/lib/providers/yfinance';

function fakeSpawn(stdout: string) {
  return () => {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setTimeout(() => { proc.stdout.emit('data', Buffer.from(stdout)); proc.emit('close', 0); }, 0);
    return proc;
  };
}

describe('YFinanceProvider.pricesBatch', () => {
  it('parses the {series:{SYM:[...]}} batch shape', async () => {
    const body = JSON.stringify({ series: { EWJ: [{ date: '2026-06-01', open: null, high: null, low: null, close: 70, adjClose: null, volume: null }], EWG: [] } });
    const yf = new YFinanceProvider({ useHttp: false, spawn: fakeSpawn(body) as any });
    const out = await yf.pricesBatch(['EWJ', 'EWG'], '1Y');
    expect(Object.keys(out)).toEqual(['EWJ', 'EWG']);
    expect(out.EWJ![0]!.close).toBe(70);
    expect(out.EWG).toEqual([]);
  });
});
```

- [ ] **Step 5: Run + verify live (optional) + commit**
Run `pnpm test -- yfinance-batch` (PASS) and `pnpm typecheck`. Optionally verify live: `python scripts/yfinance_fetch.py "EWJ,EWG,EWZ" prices_batch_1y` returns `{"series":{"EWJ":[...],...}}`. Then:
```
git add scripts/yfinance_fetch.py api/fallback/yfinance.py lib/providers/yfinance.ts tests/providers/yfinance-batch.test.ts
git commit -m "feat(countries): yfinance prices_batch (one call for N ETFs)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: CountryScorecardService

**Files:** Create `lib/services/country-scorecard.ts`, `tests/integration/country-scorecard-service.test.ts`. **Mirror `lib/services/macro.ts`** for the refresh/upsert/freshness plumbing.

- [ ] **Step 1: Implement `lib/services/country-scorecard.ts`**

```ts
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { macroSeries, macroFreshness } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type { FredProvider } from '@/lib/providers/fred';
import type { YFinanceProvider } from '@/lib/providers/yfinance';
import { COUNTRY_REGISTRY, countryFredIds, countryEtfs } from '@/lib/compute/country-registry';
import { scoreCountries, type SeriesPoint, type RankedRow } from '@/lib/compute/country-score';
import { logger } from '@/lib/logger';

interface Deps { db: ServiceDb; fred?: FredProvider; yf?: YFinanceProvider; fredDelayMs?: number }
export interface CountryRefreshSummary { fredOk: number; fredFailed: number; etfOk: number }

function isoDaysAgo(d: number): string { const x = new Date(); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10); }
function isoYearsAgo(y: number): string { const x = new Date(); x.setFullYear(x.getFullYear() - y); return x.toISOString().slice(0, 10); }
function sleep(ms: number): Promise<void> { return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve(); }

export class CountryScorecardService {
  constructor(private readonly deps: Deps) {}

  async refreshAll(mode: 'daily' | 'backfill'): Promise<CountryRefreshSummary> {
    if (!this.deps.fred || !this.deps.yf) throw new Error('refreshAll requires fred + yf');
    const start = mode === 'backfill' ? isoYearsAgo(5) : isoDaysAgo(40);
    const delay = this.deps.fredDelayMs ?? 500;
    let fredOk = 0, fredFailed = 0, etfOk = 0;

    for (const id of countryFredIds()) {
      try { await sleep(delay); const pts = await this.deps.fred.fetchSeries(id, { start }); await this.upsert(id, 'fred', pts); await this.fresh(id, pts, 'ok', null); fredOk++; }
      catch (err) { logger.warn({ id, err: String(err) }, 'country fred refresh failed'); await this.fresh(id, [], 'error', String(err).slice(0, 500)); fredFailed++; }
    }
    const batch = await this.deps.yf.pricesBatch(countryEtfs(), mode === 'backfill' ? '5Y' : '1Y');
    for (const [sym, pts] of Object.entries(batch)) {
      const sp = pts.map((p) => ({ date: p.date, value: p.close }));
      await this.upsert(sym, 'yfinance', sp); await this.fresh(sym, sp, 'ok', null); if (sp.length) etfOk++;
    }
    return { fredOk, fredFailed, etfOk };
  }

  private async upsert(seriesId: string, source: string, points: SeriesPoint[]): Promise<void> {
    if (!points.length) return;
    await this.deps.db.insert(macroSeries)
      .values(points.map((p) => ({ seriesId, obsDate: p.date, value: String(p.value), source })))
      .onConflictDoUpdate({ target: [macroSeries.seriesId, macroSeries.obsDate], set: { value: sql`excluded.value`, source: sql`excluded.source` } });
  }
  private async fresh(seriesId: string, pts: SeriesPoint[], status: string, error: string | null): Promise<void> {
    await this.deps.db.insert(macroFreshness)
      .values({ seriesId, lastObsDate: pts.length ? pts[pts.length - 1]!.date : null, status, error })
      .onConflictDoUpdate({ target: macroFreshness.seriesId, set: { lastFetchedAt: sql`now()`, lastObsDate: sql`excluded.last_obs_date`, status, error } });
  }

  /** Load all country series, build CountryInput[], score. */
  private async loadInputs() {
    const ids = [...countryFredIds(), ...countryEtfs()];
    const rows = ids.length ? await this.deps.db.select().from(macroSeries).where(inArray(macroSeries.seriesId, ids)).orderBy(asc(macroSeries.obsDate)) : [];
    const by = new Map<string, SeriesPoint[]>();
    for (const r of rows) { const a = by.get(r.seriesId) ?? []; a.push({ date: r.obsDate, value: Number(r.value) }); by.set(r.seriesId, a); }
    const get = (id: string | null) => (id ? by.get(id) ?? [] : []);
    return COUNTRY_REGISTRY.map((c) => ({
      code: c.code, name: c.name, flag: c.flag,
      series: { cli: get(c.series.cli), unemployment: get(c.series.unemployment), longRate: get(c.series.longRate), cpi: get(c.series.cpi), etf: get(c.etf) },
    }));
  }

  async getScorecard(): Promise<{ asOf: string | null; countries: RankedRow[] }> {
    const rows = scoreCountries(await this.loadInputs());
    const fresh = await this.deps.db.select().from(macroFreshness);
    const asOf = fresh.map((r) => r.lastObsDate).filter((d): d is string => !!d).sort().pop() ?? null;
    return { asOf, countries: rows };
  }

  async getCountryDetail(code: string): Promise<{ code: string; name: string; flag: string; row: RankedRow | null; series: Record<string, SeriesPoint[]> }> {
    const def = COUNTRY_REGISTRY.find((c) => c.code === code);
    if (!def) throw new Error('unknown country');
    const inputs = await this.loadInputs();
    const ranked = scoreCountries(inputs);
    const row = ranked.find((r) => r.code === code) ?? null;
    const me = inputs.find((c) => c.code === code)!;
    return { code: def.code, name: def.name, flag: def.flag, row, series: me.series as unknown as Record<string, SeriesPoint[]> };
  }
}
```

- [ ] **Step 2: Integration test** (`tests/integration/country-scorecard-service.test.ts`) — fake providers + real test DB. Mirror `tests/integration/macro-service.test.ts`.

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { CountryScorecardService } from '@/lib/services/country-scorecard';
import { countryEtfs } from '@/lib/compute/country-registry';
import type { FredProvider } from '@/lib/providers/fred';
import type { YFinanceProvider } from '@/lib/providers/yfinance';

config({ path: '.env.local' });

const fakeFred = { fetchSeries: async (id: string) => [{ date: '2026-01-01', value: id.startsWith('USA') ? 102 : 99 }, { date: '2026-07-01', value: id.startsWith('USA') ? 104 : 98 }] } as unknown as FredProvider;
const fakeYf = { pricesBatch: async () => Object.fromEntries(countryEtfs().map((s, i) => [s, [{ date: '2026-01-01', open: null, high: null, low: null, close: 100, adjClose: null, volume: null }, { date: '2026-07-01', open: null, high: null, low: null, close: 100 + i, adjClose: null, volume: null }]])) } as unknown as YFinanceProvider;

describe('CountryScorecardService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => { await dbH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`); });

  it('refreshAll upserts country series + ETFs', async () => {
    const svc = new CountryScorecardService({ db: dbH.db, fred: fakeFred, yf: fakeYf, fredDelayMs: 0 });
    const r = await svc.refreshAll('daily');
    expect(r.fredFailed).toBe(0);
    expect(r.etfOk).toBe(16);
  });
  it('getScorecard returns 16 ranked rows', async () => {
    const svc = new CountryScorecardService({ db: dbH.db, fred: fakeFred, yf: fakeYf, fredDelayMs: 0 });
    await svc.refreshAll('daily');
    const board = await svc.getScorecard();
    expect(board.countries).toHaveLength(16);
    expect(board.countries[0]!.rank).toBe(1);
    expect(board.countries.every((c) => c.composite >= 0 && c.composite <= 100)).toBe(true);
  });
  it('getCountryDetail throws for unknown code', async () => {
    const svc = new CountryScorecardService({ db: dbH.db, fred: fakeFred, yf: fakeYf, fredDelayMs: 0 });
    await expect(svc.getCountryDetail('ZZ')).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run + commit**
Run `pnpm test:integration -- country-scorecard-service` (3 pass) + `pnpm typecheck`. Then:
```
git add lib/services/country-scorecard.ts tests/integration/country-scorecard-service.test.ts
git commit -m "feat(countries): CountryScorecardService (refresh, scorecard, detail)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Cron kind + backfill

**Files:** Modify `lib/ingest/refresh-runner.ts`, `app/api/cron/refresh/route.ts`, `vercel.json`, `package.json`. Create `scripts/seed-countries.ts`. **Mirror the `macro` kind exactly.**

- [ ] **Step 1: `refresh-runner.ts`** — add `import type { CountryScorecardService } from '@/lib/services/country-scorecard';`; add `'countries'` to `RefreshKind`; add `countrySvc?: CountryScorecardService` to `Deps`; add a short-circuit right after the existing `macro` block:
```ts
  if (deps.kind === 'countries') {
    if (!deps.countrySvc) throw new Error('countrySvc required for countries refresh');
    const r = await deps.countrySvc.refreshAll('daily');
    summary.attempted = r.fredOk + r.fredFailed + r.etfOk;
    summary.succeeded = r.fredOk + r.etfOk;
    summary.failed = r.fredFailed;
    summary.durationMs = Date.now() - started;
    logger.info(summary, 'refresh-runner: countries done');
    return summary;
  }
```

- [ ] **Step 2: `app/api/cron/refresh/route.ts`** — import `CountryScorecardService`; add `'countries'` to `VALID_KINDS`; in `buildDeps` add `const countries = new CountryScorecardService({ db, fred: new FredProvider(), yf });` and include `countries` in `cachedDeps`; pass `countrySvc: deps.countries` to `runRefresh`.

- [ ] **Step 3: `vercel.json`** — add `{ "path": "/api/cron/refresh?kind=countries", "schedule": "0 6 * * 0" }`.

- [ ] **Step 4: `scripts/seed-countries.ts`** (mirror `seed-macro.ts`)
```ts
import { config } from 'dotenv'; config({ path: '.env.local', override: false });
import { getServiceDb } from '@/lib/db/client';
import { FredProvider } from '@/lib/providers/fred';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { CountryScorecardService } from '@/lib/services/country-scorecard';

const svc = new CountryScorecardService({ db: getServiceDb(), fred: new FredProvider(), yf: new YFinanceProvider() });
const r = await svc.refreshAll('backfill');
console.log('country backfill:', JSON.stringify(r));
process.exit(r.fredFailed > 0 ? 1 : 0);
```
Add `"seed-countries": "tsx scripts/seed-countries.ts"` to `package.json` scripts.

- [ ] **Step 5: Typecheck, backfill, commit**
Run `pnpm typecheck`. Run `pnpm seed-countries` (prod branch; re-run if FRED 429s — idempotent). Verify counts with a throwaway query (per-`series_id` row counts) then delete it. Then:
```
git add lib/ingest/refresh-runner.ts app/api/cron/refresh/route.ts vercel.json package.json scripts/seed-countries.ts
git commit -m "feat(countries): weekly cron kind + seed-countries backfill" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Scorecard + detail APIs

**Files:** Create `app/api/countries/route.ts`, `app/api/countries/[code]/route.ts`, `tests/integration/api-countries.test.ts`. **Mirror `app/api/macro/*`.**

- [ ] **Step 1: `app/api/countries/route.ts`**
```ts
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { CountryScorecardService } from '@/lib/services/country-scorecard';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireUserId();
    const svc = new CountryScorecardService({ db: getServiceDb() });
    const board = await svc.getScorecard();
    return NextResponse.json(board, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (err) { return errorResponse(err, { route: 'countries' }); }
}
```

- [ ] **Step 2: `app/api/countries/[code]/route.ts`** (validate against the registry → 404, mirroring the macro detail route's registry check)
```ts
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { NotFoundError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { CountryScorecardService } from '@/lib/services/country-scorecard';
import { COUNTRY_REGISTRY } from '@/lib/compute/country-registry';

export const dynamic = 'force-dynamic';
interface Ctx { params: { code: string } }

export async function GET(_req: Request, ctx: Ctx) {
  try {
    await requireUserId();
    const code = ctx.params.code.toUpperCase();
    if (!COUNTRY_REGISTRY.some((c) => c.code === code)) throw new NotFoundError(`Unknown country: ${code}`);
    const detail = await new CountryScorecardService({ db: getServiceDb() }).getCountryDetail(code);
    return NextResponse.json(detail, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (err) { return errorResponse(err, { route: 'countries/[code]' }); }
}
```

- [ ] **Step 3: Test** (`tests/integration/api-countries.test.ts`) — mirror `api-macro.test.ts`; assert `getScorecard()` returns 16 sorted rows (composite descending) via the service path (fakes + real DB, `fredDelayMs: 0`). Run `pnpm test:integration -- api-countries`, `pnpm typecheck`, `pnpm lint`.

- [ ] **Step 4: Commit**
```
git add "app/api/countries/route.ts" "app/api/countries/[code]/route.ts" tests/integration/api-countries.test.ts
git commit -m "feat(countries): scorecard + country-detail API routes" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Heatmap-table UI + nav

**Files:** Create `app/(app)/macro/countries/page.tsx`, `_components/country-scorecard.tsx`, `_components/country-detail.tsx` (stub). Modify `app/(app)/_components/nav.tsx`. **Mirror `app/(app)/macro/page.tsx` + `_components/macro-board.tsx`/`macro-tile.tsx`.**

- [ ] **Step 1: Nav** — in `nav.tsx`, after the "Macro" link, add `<Link href="/macro/countries" className="text-sm text-muted-foreground hover:text-foreground">Countries</Link>`.

- [ ] **Step 2: Page** (`app/(app)/macro/countries/page.tsx`) — mirror the macro page:
```tsx
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { CountryScorecardService } from '@/lib/services/country-scorecard';
import { CountryScorecard } from './_components/country-scorecard';

export const dynamic = 'force-dynamic';

export default async function CountriesPage() {
  await requireUserId();
  const board = await new CountryScorecardService({ db: getServiceDb() }).getScorecard();
  return (
    <main className="container mx-auto px-4 py-6">
      <h1 className="text-xl font-semibold tracking-tight mb-4">Country Scorecard</h1>
      <CountryScorecard board={board} />
    </main>
  );
}
```

- [ ] **Step 3: `_components/country-scorecard.tsx`** (client) — a sortable heatmap table. Columns: rank/flag/name + composite + growth/inflation/rates/labor/equity. Header click sets `sortKey` (default composite desc). Cell color helper: `≥67 emerald / ≥50 amber / else red` (reuse the macro-tile color tokens). On row click set `open=code`, render `<CountryDetail code={open} onClose=…/>`. Empty-state when `board.countries` is empty: "Run `pnpm seed-countries`". Stale banner when `board.asOf` > 8 days old (weekly cron) — reuse the macro stale-banner pattern.

```tsx
'use client';
import { useState } from 'react';
import type { RankedRow } from '@/lib/compute/country-score';
import { CountryDetail } from './country-detail';

type DimKey = keyof RankedRow['dims'];
const DIMS: { key: DimKey; label: string }[] = [
  { key: 'growth', label: 'Growth' }, { key: 'inflation', label: 'Infl' }, { key: 'rates', label: 'Rates' }, { key: 'labor', label: 'Labor' }, { key: 'equity', label: 'Equity' },
];
function cellClass(v: number): string {
  return v >= 67 ? 'bg-emerald-950 text-emerald-300' : v >= 50 ? 'bg-amber-950 text-amber-300' : 'bg-red-950 text-red-300';
}

export function CountryScorecard({ board }: { board: { asOf: string | null; countries: RankedRow[] } }) {
  const [sortKey, setSortKey] = useState<'composite' | DimKey>('composite');
  const [open, setOpen] = useState<string | null>(null);
  if (board.countries.length === 0) {
    return <div className="rounded-xl border border-border p-6 text-sm text-muted-foreground">No country data yet. Run <code>pnpm seed-countries</code>.</div>;
  }
  const rows = [...board.countries].sort((a, b) => (sortKey === 'composite' ? b.composite - a.composite : b.dims[sortKey] - a.dims[sortKey]));
  const th = (label: string, key: 'composite' | DimKey) => (
    <th onClick={() => setSortKey(key)} className={`px-2 py-1.5 text-[10px] uppercase tracking-wide cursor-pointer ${sortKey === key ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</th>
  );
  return (
    <div>
      {board.asOf && <div className="text-[11px] text-muted-foreground mb-2">as of {board.asOf}</div>}
      <table className="w-full text-sm border-collapse">
        <thead><tr className="border-b border-border">
          <th className="px-2 py-1.5 text-left text-[10px] uppercase text-muted-foreground">#</th>
          <th className="px-2 py-1.5 text-left text-[10px] uppercase text-muted-foreground">Country</th>
          {th('Comp', 'composite')}{DIMS.map((d) => <span key={d.key}>{th(d.label, d.key)}</span>)}
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.code} onClick={() => setOpen(r.code)} className="border-b border-border/50 hover:bg-card cursor-pointer">
              <td className="px-2 py-1.5 text-muted-foreground">{r.rank}</td>
              <td className="px-2 py-1.5 whitespace-nowrap">{r.flag} {r.name}</td>
              <td className="px-1 py-1"><span className={`inline-block w-9 rounded text-center font-bold py-0.5 ${cellClass(r.composite)}`}>{r.composite}</span></td>
              {DIMS.map((d) => <td key={d.key} className="px-1 py-1"><span className={`inline-block w-9 rounded text-center py-0.5 ${cellClass(r.dims[d.key])}`}>{r.dims[d.key]}</span></td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <CountryDetail code={open} onClose={() => setOpen(null)} />
    </div>
  );
}
```
(The row markup is inline above — no separate `country-row.tsx` component.)

- [ ] **Step 4: Temporary detail stub** (`_components/country-detail.tsx`) so it compiles (real drawer in Task 8):
```tsx
'use client';
export function CountryDetail(_props: { code: string | null; onClose: () => void }) { return null; }
```

- [ ] **Step 5: Verify + commit** — `pnpm typecheck`, `pnpm lint`, `pnpm build` (confirm `/macro/countries` in route list). Then:
```
git add "app/(app)/macro/countries/page.tsx" "app/(app)/macro/countries/_components/country-scorecard.tsx" "app/(app)/macro/countries/_components/country-detail.tsx" "app/(app)/_components/nav.tsx"
git commit -m "feat(countries): sortable heatmap scorecard UI + nav entry" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Country detail drawer

**Files:** Replace `app/(app)/macro/countries/_components/country-detail.tsx`. **Mirror `app/(app)/macro/_components/macro-detail.tsx`** (Radix dialog + recharts + the error/loading states it already has).

- [ ] **Step 1: Implement the drawer** — fetch `/api/countries/<code>`, render: the country's composite + rank, the 5 dimension scores (colored), and for each underlying series (CLI, CPI, long rate, unemployment, ETF) a small recharts line chart of its history (`detail.series[key]`). Reuse the macro-detail fetch pattern exactly (the `alive` flag, `.catch` error state, non-empty `Dialog.Description`, range not needed — show full stored history). Loading + error + "no data" states as in macro-detail.

```tsx
'use client';
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface Detail { code: string; name: string; flag: string; row: { composite: number; rank: number; dims: Record<string, number> } | null; series: Record<string, { date: string; value: number }[]> }
const SERIES_LABEL: Record<string, string> = { cli: 'OECD CLI', cpi: 'CPI (index)', longRate: '10y Yield', unemployment: 'Unemployment', etf: 'ETF price' };

export function CountryDetail({ code, onClose }: { code: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!code) { setDetail(null); setError(null); return; }
    let alive = true; setLoading(true); setError(null);
    fetch(`/api/countries/${encodeURIComponent(code)}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { if (alive) setDetail(d as Detail); })
      .catch((e) => { if (alive) setError(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [code]);
  return (
    <Dialog.Root open={!!code} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed right-0 top-0 h-full w-full max-w-lg bg-background border-l border-border p-5 overflow-y-auto">
          <Dialog.Title className="text-lg font-semibold">{detail ? `${detail.flag} ${detail.name}` : code}</Dialog.Title>
          <Dialog.Description className="text-xs text-muted-foreground mb-3">{detail?.row ? `Composite ${detail.row.composite} · rank #${detail.row.rank}` : 'Country detail'}</Dialog.Description>
          {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {error && <div className="text-sm text-red-400">Failed to load: {error}</div>}
          {detail && Object.entries(detail.series).filter(([, pts]) => pts.length).map(([key, pts]) => (
            <div key={key} className="mb-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{SERIES_LABEL[key] ?? key}</div>
              <div className="h-32"><ResponsiveContainer width="100%" height="100%">
                <LineChart data={pts}><XAxis dataKey="date" tick={{ fontSize: 9 }} minTickGap={40} /><YAxis tick={{ fontSize: 9 }} width={40} domain={['auto', 'auto']} /><Tooltip /><Line type="monotone" dataKey="value" stroke="#60a5fa" dot={false} strokeWidth={2} /></LineChart>
              </ResponsiveContainer></div>
            </div>
          ))}
          <Dialog.Close className="absolute top-4 right-4 text-muted-foreground hover:text-foreground text-sm">✕</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 2: Verify + commit** — `pnpm typecheck`, `pnpm build`. Then:
```
git add "app/(app)/macro/countries/_components/country-detail.tsx"
git commit -m "feat(countries): country detail drawer (per-series recharts)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: E2E-skip + final verification

**Files:** Create `tests/e2e/countries.spec.ts`.

- [ ] **Step 1: E2E skip spec** (matching the skipped-authed convention)
```ts
import { test, expect } from '@playwright/test';
// Authed E2E specs are skipped pending the Stack Auth ESM fixture fix (see handoff).
test.skip('country scorecard renders and a row opens detail', async ({ page }) => {
  await page.goto('/macro/countries');
  await expect(page.getByText('Country Scorecard')).toBeVisible();
  await expect(page.getByText('United States')).toBeVisible();
  await page.getByText('United States').click();
  await expect(page.getByText(/Composite/)).toBeVisible();
});
```

- [ ] **Step 2: Full verification pass** — run and confirm each:
`pnpm typecheck` (clean) · `pnpm test` (all unit incl. country-score, country-registry, yfinance-batch) · `pnpm test:integration` (incl. country-scorecard-service, api-countries) · `pnpm lint` · `pnpm build` (`/macro/countries` present).

- [ ] **Step 3: Commit**
```
git add tests/e2e/countries.spec.ts
git commit -m "feat(countries): skipped E2E happy-path + final verification" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the executor

- **No new migration/RLS** — country series live in the existing `macro_series` (catalog RLS `9990` already covers them).
- **FRED 429s** are expected keyless and self-heal (the service marks failures and continues; re-run `seed-countries`). A `FRED_API_KEY` (already supported via `process.env`) removes them and lets the weekly cron drop the delay.
- **Inflation is best-effort** — countries with `cpi: null` (or stale-pruned in T1) score neutral (50) on inflation; that's by design.
- **Taiwan / some EM** will have several null macro dims → they score on equity momentum with the rest neutral. Expected, documented in the spec.
- **Commit trailer** must be exactly the 4.7 line on every commit.
