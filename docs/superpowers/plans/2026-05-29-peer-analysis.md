# Peer Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/stock/[TICKER]/peers` tab that shows the target ticker side-by-side with its 5 most-comparable peers (semantic + size-band), with metrics sourced from existing snapshot/fundamentals/quality services. Promote-on-demand: peers missing from the deep universe get auto-ingested on first visit.

**Architecture:** Pure compute helpers for quartile ranking + fallback-chain selection. New `PeersService` bridges the broad universe (`companies_universe` — has embeddings) and the deep universe (`companies` + `snapshots` + `fundamentals` — has metrics). UI is a new server-rendered tab with a single page-level Suspense boundary (whole-table loading; per-row streaming deferred to v2 because quartile coloring requires cross-row data).

**Tech Stack:** Next.js 14 App Router + TypeScript strict, Drizzle ORM + Neon Postgres + pgvector HNSW, Stack Auth, vitest (unit + integration), Playwright (E2E).

**Spec source:** `docs/superpowers/specs/2026-05-29-peer-analysis-design.md`

**Deviations from spec:**
- API path is `/api/tickers/[symbol]/peers` (not `/api/stock/[ticker]/peers`) to match existing convention used by all other per-ticker routes (`/api/tickers/[symbol]/insiders`, `/api/tickers/[symbol]/snapshot`, etc.).
- Whole-table Suspense instead of per-row Suspense streaming. Quartile coloring needs cross-row knowledge; deferring per-row streaming to v2 keeps the v1 mental model clean.
- F-score column reads via existing `loadQuality(db, ticker)` rather than a cached column. The spec talked about `qualityService` as an injected dep; we just import `loadQuality` directly since it's a free function, not a class.

---

## File Structure

**Create (14 files):**

- `lib/compute/quartile-helpers.ts` — pure functions: rank metrics within peer set, return Tailwind color class
- `lib/compute/peer-fallback.ts` — pure function: fallback-chain selector (calls back into a query function)
- `lib/services/peers.ts` — `PeersService` with `getPeers(target, k)` orchestrator
- `app/api/tickers/[symbol]/peers/route.ts` — `GET` handler returning `PeersResult` JSON
- `app/(app)/stock/[ticker]/peers/page.tsx` — server-rendered tab page
- `app/(app)/stock/[ticker]/peers/_components/peers-table.tsx` — table shell + body (desktop)
- `app/(app)/stock/[ticker]/peers/_components/peer-row.tsx` — one peer row (desktop)
- `app/(app)/stock/[ticker]/peers/_components/peer-row-mobile.tsx` — one peer card (mobile)
- `app/(app)/stock/[ticker]/peers/_components/peer-cell.tsx` — pure cell renderer (value + quartile color)
- `app/(app)/stock/[ticker]/peers/_components/peers-empty.tsx` — empty / error states
- `app/(app)/stock/[ticker]/peers/_components/peers-skeleton.tsx` — loading skeleton for whole-table Suspense
- `tests/compute/quartile-helpers.test.ts` — unit tests
- `tests/compute/peer-fallback.test.ts` — unit tests
- `tests/integration/peers-service.test.ts` — integration tests
- `tests/integration/api-tickers-peers.test.ts` — route tests
- `tests/e2e/peers.spec.ts` — Playwright E2E

**Modify (1 file):**

- `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx` — add `'peers'` to `DashboardTab` union and `TABS` array (between `quality` and `ask`)

---

## Task 1: `quartile-helpers.ts` pure compute

**Files:**
- Create: `lib/compute/quartile-helpers.ts`
- Test: `tests/compute/quartile-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/compute/quartile-helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { quartileClass, type QuartileDirection } from '@/lib/compute/quartile-helpers';

describe('quartileClass', () => {
  it('higher-is-better: top quartile gets green', () => {
    const values = [10, 20, 30, 40];   // 40 is best
    expect(quartileClass(40, values, 'higher-is-better')).toBe('text-emerald-600');
    expect(quartileClass(10, values, 'higher-is-better')).toBe('text-rose-600');
  });

  it('lower-is-better: bottom quartile gets green', () => {
    const values = [10, 20, 30, 40];   // 10 is best (cheapest)
    expect(quartileClass(10, values, 'lower-is-better')).toBe('text-emerald-600');
    expect(quartileClass(40, values, 'lower-is-better')).toBe('text-rose-600');
  });

  it('null value returns empty class', () => {
    const values = [10, 20, 30];
    expect(quartileClass(null, values, 'higher-is-better')).toBe('');
  });

  it('all-null peer set returns empty class', () => {
    expect(quartileClass(5, [null, null, null], 'higher-is-better')).toBe('');
  });

  it('single-value peer set returns neutral class', () => {
    expect(quartileClass(42, [42], 'higher-is-better')).toBe('');
  });

  it('middle quartiles get neutral class', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80];
    expect(quartileClass(30, values, 'higher-is-better')).toBe('');
    expect(quartileClass(50, values, 'higher-is-better')).toBe('');
  });

  it('ties are handled deterministically (first occurrence wins)', () => {
    const values = [10, 10, 20, 30];
    // Two values tied at 10. With higher-is-better, both 10s land in bottom quartile.
    expect(quartileClass(10, values, 'higher-is-better')).toBe('text-rose-600');
  });
});

describe('QuartileDirection type', () => {
  it('compiles with both literal values', () => {
    const a: QuartileDirection = 'higher-is-better';
    const b: QuartileDirection = 'lower-is-better';
    expect([a, b]).toEqual(['higher-is-better', 'lower-is-better']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test tests/compute/quartile-helpers.test.ts
```

Expected: FAIL with "Cannot find module '@/lib/compute/quartile-helpers'" or similar.

- [ ] **Step 3: Implement quartile-helpers.ts**

Create `lib/compute/quartile-helpers.ts`:

```ts
/**
 * Quartile-based color coding for peer comparison tables.
 *
 * Given a value and the full set of peer values for the same metric, return
 * a Tailwind text-color class that highlights "best" (green) and "worst" (red)
 * quartiles. Middle quartiles stay neutral. Null values stay neutral.
 *
 * Direction:
 *   - 'higher-is-better' (growth, ROE, F-score, margins) — top quartile = green
 *   - 'lower-is-better'  (P/E, EV/EBITDA when positive) — bottom quartile = green
 */

export type QuartileDirection = 'higher-is-better' | 'lower-is-better';

const GREEN = 'text-emerald-600';
const RED = 'text-rose-600';
const NEUTRAL = '';

export function quartileClass(
  value: number | null,
  allValues: Array<number | null>,
  direction: QuartileDirection
): string {
  if (value == null) return NEUTRAL;

  // Filter out nulls; need at least 2 non-null values to distinguish quartiles.
  const finite = allValues.filter((v): v is number => v != null && Number.isFinite(v));
  if (finite.length < 2) return NEUTRAL;

  // Sort ascending; rank = how many values are strictly less than `value`.
  const sorted = [...finite].sort((a, b) => a - b);
  const rank = sorted.findIndex((v) => v >= value);
  const position = rank < 0 ? sorted.length - 1 : rank;
  const quartile = position / (sorted.length - 1);   // 0..1 normalized

  // Top quartile = position 0.75..1, bottom = 0..0.25.
  if (direction === 'higher-is-better') {
    if (quartile >= 0.75) return GREEN;
    if (quartile <= 0.25) return RED;
  } else {
    if (quartile <= 0.25) return GREEN;
    if (quartile >= 0.75) return RED;
  }
  return NEUTRAL;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test tests/compute/quartile-helpers.test.ts
```

Expected: PASS (7 tests passing — one for each `it` block plus the type-test block).

- [ ] **Step 5: Commit**

```bash
git add lib/compute/quartile-helpers.ts tests/compute/quartile-helpers.test.ts
git commit -m "$(cat <<'EOF'
feat(peers): quartile-helpers pure compute + 7 unit tests

Color-code metric values by quartile rank within a peer set. Top
quartile gets green, bottom gets red, middles stay neutral. Direction
flag flips the meaning for higher-vs-lower-is-better metrics. Nulls
and degenerate peer sets (< 2 finite values) return neutral.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `peer-fallback.ts` pure fallback-chain selector

**Files:**
- Create: `lib/compute/peer-fallback.ts`
- Test: `tests/compute/peer-fallback.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/compute/peer-fallback.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { selectFallback, type FallbackLevel, type FilterSet } from '@/lib/compute/peer-fallback';

describe('selectFallback', () => {
  const fullFilters: FilterSet = { country: 'US', sizeBand: { min: 100, max: 1000 } };

  it('returns strict when first attempt yields >= K rows', async () => {
    const tryQuery = vi.fn().mockImplementation(async (filters: FilterSet) => {
      if (filters.country === 'US' && filters.sizeBand) return ['A', 'B', 'C', 'D', 'E'];
      return [];
    });
    const result = await selectFallback({ k: 5, filters: fullFilters, tryQuery });
    expect(result).toEqual({ level: 'strict', tickers: ['A', 'B', 'C', 'D', 'E'] });
    expect(tryQuery).toHaveBeenCalledTimes(1);
  });

  it('falls back to no_country when strict yields < K', async () => {
    const tryQuery = vi.fn().mockImplementation(async (filters: FilterSet) => {
      if (filters.country == null && filters.sizeBand) return ['A', 'B', 'C', 'D', 'E'];
      if (filters.country === 'US' && filters.sizeBand) return ['A'];   // < K
      return [];
    });
    const result = await selectFallback({ k: 5, filters: fullFilters, tryQuery });
    expect(result.level).toBe('no_country');
    expect(result.tickers).toHaveLength(5);
  });

  it('falls back to no_size when no_country still yields < K', async () => {
    const tryQuery = vi.fn().mockImplementation(async (filters: FilterSet) => {
      if (filters.country === 'US' && !filters.sizeBand) return ['A', 'B', 'C', 'D', 'E'];
      if (filters.country == null && filters.sizeBand) return ['A', 'B'];   // < K
      if (filters.country === 'US' && filters.sizeBand) return ['A'];       // < K
      return [];
    });
    const result = await selectFallback({ k: 5, filters: fullFilters, tryQuery });
    expect(result.level).toBe('no_size');
    expect(result.tickers).toHaveLength(5);
  });

  it('falls back to global when no_size still yields < K', async () => {
    const tryQuery = vi.fn().mockImplementation(async (filters: FilterSet) => {
      if (filters.country == null && !filters.sizeBand) return ['A', 'B', 'C', 'D', 'E'];
      return ['A'];   // every level above global returns just 1
    });
    const result = await selectFallback({ k: 5, filters: fullFilters, tryQuery });
    expect(result.level).toBe('global');
    expect(result.tickers).toHaveLength(5);
  });

  it('returns global with whatever it found, even if < K', async () => {
    const tryQuery = vi.fn().mockResolvedValue(['A', 'B']);    // every level returns 2
    const result = await selectFallback({ k: 5, filters: fullFilters, tryQuery });
    expect(result.level).toBe('global');
    expect(result.tickers).toEqual(['A', 'B']);
  });

  it('strict accepts boundary K exactly', async () => {
    const tryQuery = vi.fn().mockImplementation(async () => ['A', 'B', 'C', 'D', 'E']);
    const result = await selectFallback({ k: 5, filters: fullFilters, tryQuery });
    expect(result.level).toBe('strict');
  });
});

describe('FallbackLevel type', () => {
  it('has the expected literal values', () => {
    const levels: FallbackLevel[] = ['strict', 'no_country', 'no_size', 'global'];
    expect(levels).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test tests/compute/peer-fallback.test.ts
```

Expected: FAIL with "Cannot find module '@/lib/compute/peer-fallback'".

- [ ] **Step 3: Implement peer-fallback.ts**

Create `lib/compute/peer-fallback.ts`:

```ts
/**
 * Peer-candidate fallback chain.
 *
 * Given a target's hard filters (country, size band), try the strict query
 * first. If it returns fewer than K rows, progressively relax filters until
 * we hit K or run out of relaxation steps.
 *
 * The actual SQL is injected via `tryQuery` to keep this module pure-
 * functional and testable without a DB.
 */

export type FallbackLevel = 'strict' | 'no_country' | 'no_size' | 'global';

export interface FilterSet {
  country: string | null;                                         // null = no country filter
  sizeBand: { min: number; max: number } | null;                  // null = no size filter
}

export interface FallbackResult {
  level: FallbackLevel;
  tickers: string[];
}

export interface SelectFallbackInput {
  k: number;
  filters: FilterSet;                                             // strict filters from target
  tryQuery: (filters: FilterSet) => Promise<string[]>;            // injected SQL runner
}

export async function selectFallback(input: SelectFallbackInput): Promise<FallbackResult> {
  const { k, filters, tryQuery } = input;

  const attempts: Array<{ level: FallbackLevel; filters: FilterSet }> = [
    { level: 'strict',     filters: { country: filters.country, sizeBand: filters.sizeBand } },
    { level: 'no_country', filters: { country: null,            sizeBand: filters.sizeBand } },
    { level: 'no_size',    filters: { country: filters.country, sizeBand: null            } },
    { level: 'global',     filters: { country: null,            sizeBand: null            } }
  ];

  let last: FallbackResult = { level: 'global', tickers: [] };
  for (const attempt of attempts) {
    const tickers = await tryQuery(attempt.filters);
    last = { level: attempt.level, tickers };
    if (tickers.length >= k) return last;
  }
  return last;   // best-effort: return last attempt even if < K
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test tests/compute/peer-fallback.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/compute/peer-fallback.ts tests/compute/peer-fallback.test.ts
git commit -m "$(cat <<'EOF'
feat(peers): peer-fallback chain selector + 7 unit tests

Pure function that runs strict → no_country → no_size → global
relaxation in sequence, stopping at the first level that returns
>= K rows. The actual SQL is injected via a callback so the helper
stays DB-free.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `PeersService` + integration tests

**Files:**
- Create: `lib/services/peers.ts`
- Test: `tests/integration/peers-service.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/peers-service.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, companiesUniverse, snapshots, fundamentals } from '@/lib/db/schema';
import { PeersService } from '@/lib/services/peers';
import type { Provider } from '@/lib/providers/types';

config({ path: '.env.local' });

function vec(seed: 'A' | 'B' | 'C' | 'D'): number[] {
  const v = new Array(1024).fill(0);
  if (seed === 'A') v[0] = 1;
  if (seed === 'B') v[1] = 1;
  if (seed === 'C') v[2] = 1;
  if (seed === 'D') v[3] = 1;
  return v;
}

function mockProvider(overrides?: Partial<Provider>): Provider {
  return {
    name: 'mock' as any,
    company: vi.fn().mockResolvedValue({ ticker: 'X', name: 'X', cik: null, exchange: null, sector: null, industry: null }),
    snapshot: vi.fn().mockResolvedValue({
      ticker: 'X', price: 100, marketCap: 1e9, week52High: null, week52Low: null,
      pe: 20, ps: null, pb: null, evEbitda: 12, peg: null, asOf: new Date()
    }),
    statements: vi.fn().mockResolvedValue({ ticker: 'X', statementType: 'income', periodType: 'annual', rows: [] }),
    prices: vi.fn().mockResolvedValue({ ticker: 'X', range: '1Y', candles: [] }),
    insiderTrades: vi.fn(),
    news: vi.fn(),
    ...overrides
  } as unknown as Provider;
}

const mockRedis = {
  get: async () => null,
  set: async () => undefined,
  delete: async () => undefined
} as any;

describe('PeersService.getPeers', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });

  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.execute(sql`TRUNCATE TABLE companies_universe`);

    // Universe: 1 target + 5 same-country same-size peers + 1 outlier
    await dbH.db.insert(companiesUniverse).values([
      { ticker: 'TGT',  name: 'Target Inc',    country: 'US', exchange: 'NYSE',   sector: 'Technology', description: 'target', descriptionEmbedding: vec('A'), marketCap: '500', sources: ['nyse'] },
      { ticker: 'PER1', name: 'Peer One',      country: 'US', exchange: 'NYSE',   sector: 'Technology', description: 'p1',     descriptionEmbedding: vec('A'), marketCap: '300', sources: ['nyse'] },
      { ticker: 'PER2', name: 'Peer Two',      country: 'US', exchange: 'NYSE',   sector: 'Technology', description: 'p2',     descriptionEmbedding: vec('A'), marketCap: '600', sources: ['nyse'] },
      { ticker: 'PER3', name: 'Peer Three',    country: 'US', exchange: 'NYSE',   sector: 'Technology', description: 'p3',     descriptionEmbedding: vec('A'), marketCap: '400', sources: ['nyse'] },
      { ticker: 'PER4', name: 'Peer Four',     country: 'US', exchange: 'NYSE',   sector: 'Technology', description: 'p4',     descriptionEmbedding: vec('A'), marketCap: '700', sources: ['nyse'] },
      { ticker: 'PER5', name: 'Peer Five',     country: 'US', exchange: 'NYSE',   sector: 'Technology', description: 'p5',     descriptionEmbedding: vec('A'), marketCap: '450', sources: ['nyse'] },
      { ticker: 'WAY1', name: 'Wrong Country', country: 'BR', exchange: 'NYSE',   sector: 'Technology', description: 'br',     descriptionEmbedding: vec('A'), marketCap: '500', sources: ['nyse'] },
      { ticker: 'WAY2', name: 'Wrong Size',    country: 'US', exchange: 'NYSE',   sector: 'Technology', description: 'huge',   descriptionEmbedding: vec('A'), marketCap: '5000', sources: ['nyse'] }
    ]);
  });

  it('returns target + 5 peers when strict query yields enough', async () => {
    const yf = mockProvider();
    const svc = new PeersService({ db: dbH.db, primary: yf, fallback: yf, redis: mockRedis });
    const result = await svc.getPeers('TGT', 5);
    expect(result.target.ticker).toBe('TGT');
    expect(result.peers).toHaveLength(5);
    expect(result.fallback).toBe('strict');
    expect(result.peers.map((p) => p.ticker).sort()).toEqual(['PER1', 'PER2', 'PER3', 'PER4', 'PER5']);
    expect(result.peers.every((p) => p.similarity != null && p.similarity > 0.99)).toBe(true);
  });

  it('promotes missing peers into companies + snapshots tables', async () => {
    const yf = mockProvider();
    const svc = new PeersService({ db: dbH.db, primary: yf, fallback: yf, redis: mockRedis });
    await svc.getPeers('TGT', 5);

    const rows = await dbH.db.select().from(companies);
    expect(rows.map((r) => r.ticker).sort()).toEqual(['PER1', 'PER2', 'PER3', 'PER4', 'PER5', 'TGT']);
    const snaps = await dbH.db.select().from(snapshots);
    // Every promoted ticker got a snapshot row (mocked yfinance always succeeds)
    expect(snaps).toHaveLength(6);
  });

  it('skips yfinance for peers whose companies.last_refreshed_at is < 24h', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000);   // 1h ago
    await dbH.db.insert(companies).values([
      { ticker: 'TGT',  name: 'Target Inc', lastRefreshedAt: recent },
      { ticker: 'PER1', name: 'Peer One',   lastRefreshedAt: recent },
      { ticker: 'PER2', name: 'Peer Two',   lastRefreshedAt: recent },
      { ticker: 'PER3', name: 'Peer Three', lastRefreshedAt: recent },
      { ticker: 'PER4', name: 'Peer Four',  lastRefreshedAt: recent },
      { ticker: 'PER5', name: 'Peer Five',  lastRefreshedAt: recent }
    ]);
    const yf = mockProvider();
    const svc = new PeersService({ db: dbH.db, primary: yf, fallback: yf, redis: mockRedis });
    await svc.getPeers('TGT', 5);
    expect(yf.snapshot).not.toHaveBeenCalled();
  });

  it('partial failure: yfinance throws for one peer → that row marked unavailable, others render', async () => {
    const yf = mockProvider({
      snapshot: vi.fn().mockImplementation(async (t: string) => {
        if (t === 'PER3') throw new Error('delisted');
        return {
          ticker: t, price: 100, marketCap: 1e9, week52High: null, week52Low: null,
          pe: 20, ps: null, pb: null, evEbitda: 12, peg: null, asOf: new Date()
        };
      })
    });
    const svc = new PeersService({ db: dbH.db, primary: yf, fallback: yf, redis: mockRedis });
    const result = await svc.getPeers('TGT', 5);
    expect(result.peers).toHaveLength(5);
    const per3 = result.peers.find((p) => p.ticker === 'PER3');
    expect(per3?.dataStatus).toBe('unavailable');
    const others = result.peers.filter((p) => p.ticker !== 'PER3');
    expect(others.every((p) => p.dataStatus === 'available')).toBe(true);
  });

  it('falls back to no_country when strict yields < K', async () => {
    // Remove four of the five US peers — only PER1 remains in-country
    await dbH.db.execute(sql`DELETE FROM companies_universe WHERE ticker IN ('PER2','PER3','PER4','PER5')`);
    // Backfill with BR peers (wrong country but right size)
    await dbH.db.insert(companiesUniverse).values([
      { ticker: 'BR1', name: 'BR One',  country: 'BR', exchange: 'NYSE', sector: 'Technology', description: 'br1', descriptionEmbedding: vec('A'), marketCap: '300', sources: ['nyse'] },
      { ticker: 'BR2', name: 'BR Two',  country: 'BR', exchange: 'NYSE', sector: 'Technology', description: 'br2', descriptionEmbedding: vec('A'), marketCap: '600', sources: ['nyse'] },
      { ticker: 'BR3', name: 'BR Three',country: 'BR', exchange: 'NYSE', sector: 'Technology', description: 'br3', descriptionEmbedding: vec('A'), marketCap: '400', sources: ['nyse'] },
      { ticker: 'BR4', name: 'BR Four', country: 'BR', exchange: 'NYSE', sector: 'Technology', description: 'br4', descriptionEmbedding: vec('A'), marketCap: '700', sources: ['nyse'] }
    ]);

    const yf = mockProvider();
    const svc = new PeersService({ db: dbH.db, primary: yf, fallback: yf, redis: mockRedis });
    const result = await svc.getPeers('TGT', 5);
    expect(result.fallback).toBe('no_country');
    expect(result.peers).toHaveLength(5);
    expect(result.peers.map((p) => p.ticker).sort()).toEqual(['BR1', 'BR2', 'BR3', 'BR4', 'PER1']);
  });

  it('returns target_missing when target absent from companies_universe', async () => {
    const yf = mockProvider();
    const svc = new PeersService({ db: dbH.db, primary: yf, fallback: yf, redis: mockRedis });
    const result = await svc.getPeers('NOSUCH', 5);
    expect(result.fallback).toBe('target_missing');
    expect(result.peers).toEqual([]);
    expect(result.target.ticker).toBe('NOSUCH');
    expect(result.target.dataStatus).toBe('unavailable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test:integration tests/integration/peers-service.test.ts
```

Expected: FAIL with "Cannot find module '@/lib/services/peers'".

- [ ] **Step 3: Implement PeersService**

Create `lib/services/peers.ts`:

```ts
import { and, eq, sql } from 'drizzle-orm';
import type { ServiceDb } from '@/lib/db/client';
import type { Provider } from '@/lib/providers/types';
import type { RedisCache } from '@/lib/cache/redis';
import { companies, companiesUniverse, snapshots } from '@/lib/db/schema';
import { SnapshotService } from '@/lib/services/snapshot';
import { FinancialsService } from '@/lib/services/financials';
import { loadQuality } from '@/lib/services/quality';
import {
  selectFallback,
  type FallbackLevel,
  type FilterSet
} from '@/lib/compute/peer-fallback';
import { logger } from '@/lib/logger';

const STALENESS_MS = 24 * 60 * 60 * 1000;
const SIZE_BAND_LOW = 0.3;
const SIZE_BAND_HIGH = 3.0;
const PEER_TIMEOUT_MS = 30_000;

export type PeerFallback = FallbackLevel | 'target_missing';

export interface PeerRow {
  ticker: string;
  name: string;
  country: string | null;
  sector: string | null;
  marketCap: number | null;
  pe: number | null;
  evEbitda: number | null;
  revGrowthYoy: number | null;
  grossMargin: number | null;
  roe: number | null;
  fScore: number | null;
  similarity: number | null;
  dataStatus: 'available' | 'unavailable';
}

export interface PeersResult {
  target: PeerRow;
  peers: PeerRow[];
  fallback: PeerFallback;
  k: number;
}

interface Deps {
  db: ServiceDb;
  primary: Provider;
  fallback: Provider;
  redis: RedisCache;
}

interface TargetMeta {
  ticker: string;
  name: string;
  country: string | null;
  marketCap: number | null;
  embeddingLiteral: string;
}

export class PeersService {
  private snapshotSvc: SnapshotService;
  private financialsSvc: FinancialsService;

  constructor(private readonly deps: Deps) {
    this.snapshotSvc = new SnapshotService({
      db: deps.db, primary: deps.primary, fallback: deps.fallback, redis: deps.redis
    });
    this.financialsSvc = new FinancialsService({
      db: deps.db, primary: deps.primary, fallback: deps.fallback, redis: deps.redis
    });
  }

  async getPeers(targetTicker: string, k = 5): Promise<PeersResult> {
    const target = targetTicker.toUpperCase();

    const meta = await this.lookupTarget(target);
    if (!meta) {
      return {
        target: emptyRow(target),
        peers: [],
        fallback: 'target_missing',
        k
      };
    }

    const peerTickers = await this.findCandidates(meta, k);

    const allTickers = [meta.ticker, ...peerTickers.tickers];
    await Promise.allSettled(allTickers.map((t) => this.ensureDeepData(t)));

    const target_row = await this.buildRow(meta.ticker, meta.name, meta.country, meta.marketCap, null);
    const peer_rows = await Promise.all(
      peerTickers.tickers.map(async (t) => {
        const m = await this.readUniverseMeta(t);
        const sim = await this.computeSimilarity(meta.embeddingLiteral, t);
        return this.buildRow(t, m?.name ?? t, m?.country ?? null, m?.marketCap ?? null, sim);
      })
    );

    return {
      target: target_row,
      peers: peer_rows,
      fallback: peerTickers.level,
      k
    };
  }

  private async lookupTarget(ticker: string): Promise<TargetMeta | null> {
    const rows = await this.deps.db.execute(sql`
      SELECT
        ticker, name, country,
        market_cap::text AS market_cap_text,
        description_embedding::text AS embedding_text
      FROM companies_universe
      WHERE ticker = ${ticker}
        AND description_embedding IS NOT NULL
      LIMIT 1
    `);
    const r = (rows as unknown as Array<Record<string, unknown>>)[0];
    if (!r) return null;
    return {
      ticker: r.ticker as string,
      name: r.name as string,
      country: (r.country as string | null) ?? null,
      marketCap: r.market_cap_text != null ? Number(r.market_cap_text) : null,
      embeddingLiteral: r.embedding_text as string
    };
  }

  private async findCandidates(
    meta: TargetMeta,
    k: number
  ): Promise<{ level: FallbackLevel; tickers: string[] }> {
    const sizeBand =
      meta.marketCap != null
        ? { min: meta.marketCap * SIZE_BAND_LOW, max: meta.marketCap * SIZE_BAND_HIGH }
        : null;
    const filters: FilterSet = { country: meta.country, sizeBand };
    return selectFallback({
      k,
      filters,
      tryQuery: (f) => this.runVectorQuery(meta.ticker, meta.embeddingLiteral, f, k)
    });
  }

  private async runVectorQuery(
    targetTicker: string,
    embeddingLiteral: string,
    filters: FilterSet,
    k: number
  ): Promise<string[]> {
    const countryFilter = filters.country ? sql`AND country = ${filters.country}` : sql``;
    const sizeFilter = filters.sizeBand
      ? sql`AND market_cap BETWEEN ${filters.sizeBand.min} AND ${filters.sizeBand.max}`
      : sql``;

    const rows = await this.deps.db.execute(sql`
      SELECT ticker
      FROM companies_universe
      WHERE description_embedding IS NOT NULL
        AND ticker != ${targetTicker}
        ${countryFilter}
        ${sizeFilter}
      ORDER BY description_embedding <=> ${embeddingLiteral}::vector
      LIMIT ${k}
    `);
    return (rows as unknown as Array<{ ticker: string }>).map((r) => r.ticker);
  }

  private async readUniverseMeta(
    ticker: string
  ): Promise<{ name: string; country: string | null; marketCap: number | null } | null> {
    const rows = await this.deps.db
      .select({
        name: companiesUniverse.name,
        country: companiesUniverse.country,
        marketCap: companiesUniverse.marketCap
      })
      .from(companiesUniverse)
      .where(eq(companiesUniverse.ticker, ticker))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      name: r.name,
      country: r.country ?? null,
      marketCap: r.marketCap != null ? Number(r.marketCap) : null
    };
  }

  private async computeSimilarity(
    targetEmbeddingLiteral: string,
    peerTicker: string
  ): Promise<number | null> {
    const rows = await this.deps.db.execute(sql`
      SELECT 1 - (description_embedding <=> ${targetEmbeddingLiteral}::vector) AS sim
      FROM companies_universe
      WHERE ticker = ${peerTicker}
      LIMIT 1
    `);
    const r = (rows as unknown as Array<{ sim: number | string }>)[0];
    if (!r) return null;
    return Number(r.sim);
  }

  private async ensureDeepData(ticker: string): Promise<void> {
    const t = ticker.toUpperCase();

    const existing = await this.deps.db
      .select({ lastRefreshedAt: companies.lastRefreshedAt })
      .from(companies)
      .where(eq(companies.ticker, t))
      .limit(1);
    const row = existing[0];

    if (row?.lastRefreshedAt) {
      const age = Date.now() - new Date(row.lastRefreshedAt).getTime();
      if (age < STALENESS_MS) return;   // fresh enough, skip
    }

    if (!row) {
      await this.deps.db.insert(companies).values({ ticker: t, name: t }).onConflictDoNothing();
    }

    const work = Promise.allSettled([
      this.snapshotSvc.refresh(t),
      this.financialsSvc.refresh(t, 'income', 'annual'),
      this.financialsSvc.refresh(t, 'balance', 'annual'),
      this.financialsSvc.refresh(t, 'cash_flow', 'annual')
    ]);
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), PEER_TIMEOUT_MS)
    );
    const winner = await Promise.race([work, timeout]);
    if (winner === 'timeout') {
      logger.warn({ ticker: t }, 'peers: ensureDeepData timed out');
      return;
    }

    await this.deps.db
      .update(companies)
      .set({ lastRefreshedAt: new Date() })
      .where(eq(companies.ticker, t));
  }

  private async buildRow(
    ticker: string,
    name: string,
    country: string | null,
    universeMarketCap: number | null,
    similarity: number | null
  ): Promise<PeerRow> {
    const snap = await this.deps.db
      .select({
        marketCap: snapshots.marketCap,
        pe: snapshots.pe,
        evEbitda: snapshots.evEbitda,
        sector: companies.sector
      })
      .from(snapshots)
      .leftJoin(companies, eq(companies.ticker, snapshots.ticker))
      .where(eq(snapshots.ticker, ticker))
      .limit(1);
    const s = snap[0];

    if (!s) {
      return {
        ticker, name, country,
        sector: null,
        marketCap: universeMarketCap,
        pe: null, evEbitda: null,
        revGrowthYoy: null, grossMargin: null, roe: null, fScore: null,
        similarity, dataStatus: 'unavailable'
      };
    }

    const [revGrowthYoy, grossMargin, roe] = await this.computeFundamentalsMetrics(ticker);

    let fScore: number | null = null;
    try {
      const q = await loadQuality(this.deps.db, ticker);
      fScore = q.current.piotroskiF?.score ?? null;
    } catch {
      fScore = null;
    }

    return {
      ticker,
      name,
      country,
      sector: (s.sector as string | null) ?? null,
      marketCap: s.marketCap != null ? Number(s.marketCap) : universeMarketCap,
      pe: s.pe != null ? Number(s.pe) : null,
      evEbitda: s.evEbitda != null ? Number(s.evEbitda) : null,
      revGrowthYoy, grossMargin, roe, fScore,
      similarity,
      dataStatus: 'available'
    };
  }

  /**
   * Compute YoY revenue growth, gross margin, and ROE from the two most-
   * recent annual fundamentals periods. Returns nulls when data is missing.
   */
  private async computeFundamentalsMetrics(
    ticker: string
  ): Promise<[number | null, number | null, number | null]> {
    const rows = await this.deps.db.execute(sql`
      SELECT period_end, line_item, value::float8 AS value
      FROM fundamentals
      WHERE ticker = ${ticker}
        AND period_type = 'annual'
        AND line_item IN ('revenue', 'gross_profit', 'net_income', 'total_assets', 'total_liabilities')
      ORDER BY period_end DESC
    `);
    const data = rows as unknown as Array<{ period_end: string; line_item: string; value: number | null }>;

    const byPeriod = new Map<string, Record<string, number | null>>();
    for (const r of data) {
      if (!byPeriod.has(r.period_end)) byPeriod.set(r.period_end, {});
      byPeriod.get(r.period_end)![r.line_item] = r.value;
    }
    const periods = Array.from(byPeriod.keys()).sort().reverse();
    if (periods.length < 1) return [null, null, null];

    const latest = byPeriod.get(periods[0]!)!;
    const prior = periods.length >= 2 ? byPeriod.get(periods[1]!)! : null;

    const rev = latest.revenue;
    const priorRev = prior?.revenue ?? null;
    const revGrowth = (rev != null && priorRev != null && priorRev !== 0)
      ? (rev - priorRev) / priorRev
      : null;

    const gp = latest.gross_profit;
    const grossMargin = (gp != null && rev != null && rev !== 0) ? gp / rev : null;

    const ni = latest.net_income;
    const equity = (latest.total_assets != null && latest.total_liabilities != null)
      ? latest.total_assets - latest.total_liabilities
      : null;
    const roe = (ni != null && equity != null && equity !== 0) ? ni / equity : null;

    return [revGrowth, grossMargin, roe];
  }
}

function emptyRow(ticker: string): PeerRow {
  return {
    ticker, name: ticker, country: null, sector: null,
    marketCap: null, pe: null, evEbitda: null,
    revGrowthYoy: null, grossMargin: null, roe: null, fScore: null,
    similarity: null, dataStatus: 'unavailable'
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test:integration tests/integration/peers-service.test.ts
```

Expected: PASS (6 tests). If a test fails because `loadQuality` errors with insufficient data — that's expected; the service catches and returns null for fScore. The test fixtures don't seed fundamentals.

- [ ] **Step 5: Commit**

```bash
git add lib/services/peers.ts tests/integration/peers-service.test.ts
git commit -m "$(cat <<'EOF'
feat(peers): PeersService.getPeers + 6 integration tests

Bridges companies_universe (semantic embeddings + size band) with
companies/snapshots/fundamentals (metric columns). Promote-on-demand
ingests missing peers via existing SnapshotService + FinancialsService
in parallel with a 30s per-peer timeout. Skips re-ingest when
companies.last_refreshed_at < 24h.

Tests cover: strict happy path, promote-on-demand, idempotency,
partial yfinance failure (PER3 unavailable, others render), fallback
to no_country, and target_missing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `GET /api/tickers/[symbol]/peers` route + tests

**Files:**
- Create: `app/api/tickers/[symbol]/peers/route.ts`
- Test: `tests/integration/api-tickers-peers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/api-tickers-peers.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companiesUniverse } from '@/lib/db/schema';

config({ path: '.env.local' });

vi.mock('@/lib/auth/current-user', () => ({
  requireUserId: vi.fn()
}));
vi.mock('@/lib/db/client', () => ({
  getServiceDb: vi.fn()
}));
vi.mock('@/lib/cache/redis', () => ({
  getRedisCache: vi.fn(() => ({
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined
  }))
}));

import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { GET } from '@/app/api/tickers/[symbol]/peers/route';

function vec(): number[] {
  const v = new Array(1024).fill(0);
  v[0] = 1;
  return v;
}

describe('GET /api/tickers/[symbol]/peers', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => {
    dbH = makeTestServiceDb();
    vi.mocked(getServiceDb).mockReturnValue(dbH.db as any);
    vi.mocked(requireUserId).mockResolvedValue('00000000-0000-0000-0000-000000000001');
  });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.execute(sql`TRUNCATE TABLE companies_universe`);
    await dbH.db.insert(companiesUniverse).values([
      { ticker: 'TGT',  name: 'Target',  country: 'US', sector: 'Tech', description: 't',  descriptionEmbedding: vec(), marketCap: '500', sources: ['nyse'] },
      { ticker: 'PER1', name: 'Peer 1',  country: 'US', sector: 'Tech', description: 'p1', descriptionEmbedding: vec(), marketCap: '300', sources: ['nyse'] },
      { ticker: 'PER2', name: 'Peer 2',  country: 'US', sector: 'Tech', description: 'p2', descriptionEmbedding: vec(), marketCap: '600', sources: ['nyse'] },
      { ticker: 'PER3', name: 'Peer 3',  country: 'US', sector: 'Tech', description: 'p3', descriptionEmbedding: vec(), marketCap: '400', sources: ['nyse'] },
      { ticker: 'PER4', name: 'Peer 4',  country: 'US', sector: 'Tech', description: 'p4', descriptionEmbedding: vec(), marketCap: '700', sources: ['nyse'] },
      { ticker: 'PER5', name: 'Peer 5',  country: 'US', sector: 'Tech', description: 'p5', descriptionEmbedding: vec(), marketCap: '450', sources: ['nyse'] }
    ]);
  });

  it('returns 200 with PeersResult JSON for a valid ticker', async () => {
    const req = new Request('http://localhost/api/tickers/TGT/peers?k=5');
    const res = await GET(req, { params: { symbol: 'TGT' } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.target.ticker).toBe('TGT');
    expect(Array.isArray(json.peers)).toBe(true);
    expect(json.fallback).toBe('strict');
    expect(json.k).toBe(5);
  });

  it('normalizes lowercase ticker to uppercase', async () => {
    const req = new Request('http://localhost/api/tickers/tgt/peers');
    const res = await GET(req, { params: { symbol: 'tgt' } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.target.ticker).toBe('TGT');
  });

  it('rejects invalid ticker with 400', async () => {
    const req = new Request('http://localhost/api/tickers/has-dash/peers');
    const res = await GET(req, { params: { symbol: 'has-dash' } });
    expect(res.status).toBe(400);
  });

  it('rejects k > 10 with 400', async () => {
    const req = new Request('http://localhost/api/tickers/TGT/peers?k=99');
    const res = await GET(req, { params: { symbol: 'TGT' } });
    expect(res.status).toBe(400);
  });

  it('rejects k < 1 with 400', async () => {
    const req = new Request('http://localhost/api/tickers/TGT/peers?k=0');
    const res = await GET(req, { params: { symbol: 'TGT' } });
    expect(res.status).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireUserId).mockRejectedValueOnce(new Error('no auth'));
    const req = new Request('http://localhost/api/tickers/TGT/peers');
    const res = await GET(req, { params: { symbol: 'TGT' } });
    expect(res.status).toBe(401);
  });

  it('sets Cache-Control: private, max-age=300', async () => {
    const req = new Request('http://localhost/api/tickers/TGT/peers');
    const res = await GET(req, { params: { symbol: 'TGT' } });
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test:integration tests/integration/api-tickers-peers.test.ts
```

Expected: FAIL with "Cannot find module '@/app/api/tickers/[symbol]/peers/route'".

- [ ] **Step 3: Implement the route**

Create `app/api/tickers/[symbol]/peers/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { PeersService } from '@/lib/services/peers';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const DEFAULT_K = 5;
const MAX_K = 10;
const MIN_K = 1;

interface RouteContext {
  params: { symbol: string };
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    try {
      await requireUserId();
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) {
      throw new ValidationError(`Invalid symbol: ${ctx.params.symbol}`);
    }

    const url = new URL(req.url);
    const kRaw = url.searchParams.get('k');
    const k = kRaw == null ? DEFAULT_K : Number(kRaw);
    if (!Number.isInteger(k) || k < MIN_K || k > MAX_K) {
      throw new ValidationError(`k must be an integer in [${MIN_K}, ${MAX_K}]`);
    }

    const env = loadServerEnv();
    const db = getServiceDb();
    const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
    const yf = new YFinanceProvider();
    const redis = getRedisCache();

    const svc = new PeersService({ db, primary: yf, fallback: fd, redis });
    const result = await svc.getPeers(symbol, k);

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'private, max-age=300' }
    });
  } catch (err) {
    return errorResponse(err, { route: 'tickers/peers' });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test:integration tests/integration/api-tickers-peers.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/tickers/[symbol]/peers/route.ts tests/integration/api-tickers-peers.test.ts
git commit -m "$(cat <<'EOF'
feat(peers): GET /api/tickers/[symbol]/peers route + 7 tests

Standard Next.js route handler. Auth via requireUserId, validates
ticker format and k range [1, 10]. Returns PeersResult JSON with
Cache-Control: private, max-age=300. yfinance is primary, FD is
fallback, consistent with the rest of the per-ticker routes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `peer-cell.tsx` pure cell renderer

**Files:**
- Create: `app/(app)/stock/[ticker]/peers/_components/peer-cell.tsx`

This is a pure rendering component — no DB, no async work. Inline visual verification via the page in later tasks. No isolated test file (matches how the existing Watchlist Roll-up cells are tested only via E2E + visual checks).

- [ ] **Step 1: Implement peer-cell.tsx**

Create `app/(app)/stock/[ticker]/peers/_components/peer-cell.tsx`:

```tsx
import { cn } from '@/lib/utils';
import { quartileClass, type QuartileDirection } from '@/lib/compute/quartile-helpers';

interface Props {
  value: number | null;
  allValues: Array<number | null>;
  direction: QuartileDirection;
  format: 'currency' | 'multiple' | 'percent' | 'integer' | 'similarity';
  title?: string;
}

function formatValue(value: number | null, format: Props['format']): string {
  if (value == null || !Number.isFinite(value)) return '—';
  switch (format) {
    case 'currency': {
      // Compact USD: $3.2T, $890B, $245M
      if (value >= 1e12) return `$${(value / 1e12).toFixed(1)}T`;
      if (value >= 1e9)  return `$${(value / 1e9).toFixed(1)}B`;
      if (value >= 1e6)  return `$${(value / 1e6).toFixed(1)}M`;
      return `$${value.toFixed(0)}`;
    }
    case 'multiple':
      return `${value.toFixed(1)}x`;
    case 'percent':
      return `${(value * 100).toFixed(1)}%`;
    case 'integer':
      return value.toFixed(0);
    case 'similarity':
      return `${Math.round(value * 100)}%`;
  }
}

export function PeerCell({ value, allValues, direction, format, title }: Props) {
  const text = formatValue(value, format);
  const colorClass = value == null ? '' : quartileClass(value, allValues, direction);
  return (
    <span
      className={cn('tabular-nums', colorClass)}
      title={title ?? (value == null ? 'Data unavailable' : undefined)}
    >
      {text}
    </span>
  );
}
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm typecheck
```

Expected: PASS (no errors). If `cn` is missing, check the existing import paths via `grep "from '@/lib/utils'" app/`.

- [ ] **Step 3: Commit**

```bash
git add app/\(app\)/stock/\[ticker\]/peers/_components/peer-cell.tsx
git commit -m "$(cat <<'EOF'
feat(peers): peer-cell pure renderer with quartile coloring

Formats the value (currency/multiple/percent/integer/similarity) and
applies the quartile-helpers color class. Renders "—" with a tooltip
when value is null.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Row + skeleton + mobile components

**Files:**
- Create: `app/(app)/stock/[ticker]/peers/_components/peer-row.tsx`
- Create: `app/(app)/stock/[ticker]/peers/_components/peer-row-mobile.tsx`
- Create: `app/(app)/stock/[ticker]/peers/_components/peers-skeleton.tsx`

- [ ] **Step 1: Implement peer-row.tsx (desktop)**

Create `app/(app)/stock/[ticker]/peers/_components/peer-row.tsx`:

```tsx
import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { PeerRow as PeerRowData } from '@/lib/services/peers';
import { PeerCell } from './peer-cell';

interface Props {
  row: PeerRowData;
  allRows: PeerRowData[];   // for quartile context (target + peers)
  emphasis?: 'target' | 'peer';
}

export function PeerRow({ row, allRows, emphasis = 'peer' }: Props) {
  const marketCaps = allRows.map((r) => r.marketCap);
  const pes        = allRows.map((r) => r.pe);
  const evEbitdas  = allRows.map((r) => r.evEbitda);
  const revGrowths = allRows.map((r) => r.revGrowthYoy);
  const grossMargs = allRows.map((r) => r.grossMargin);
  const roes       = allRows.map((r) => r.roe);
  const fScores    = allRows.map((r) => r.fScore);

  return (
    <li
      className={cn(
        'grid grid-cols-12 gap-3 items-baseline px-3 py-2 border-b border-border last:border-0 hover:bg-muted/50',
        emphasis === 'target' && 'bg-muted/30 font-medium'
      )}
    >
      <Link
        href={`/stock/${row.ticker}`}
        className="col-span-2 font-mono font-medium tabular-nums hover:text-primary"
      >
        {row.ticker}
      </Link>
      <div className="col-span-2 truncate text-sm" title={row.name}>{row.name}</div>
      <div className="col-span-1 text-xs text-muted-foreground">{row.country ?? '—'}</div>

      <div className="col-span-1 text-right">
        <PeerCell value={row.marketCap} allValues={marketCaps} direction="higher-is-better" format="currency" />
      </div>
      <div className="col-span-1 text-right">
        <PeerCell value={row.pe} allValues={pes} direction="lower-is-better" format="multiple" />
      </div>
      <div className="col-span-1 text-right">
        <PeerCell value={row.evEbitda} allValues={evEbitdas} direction="lower-is-better" format="multiple" />
      </div>
      <div className="col-span-1 text-right">
        <PeerCell value={row.revGrowthYoy} allValues={revGrowths} direction="higher-is-better" format="percent" />
      </div>
      <div className="col-span-1 text-right">
        <PeerCell value={row.grossMargin} allValues={grossMargs} direction="higher-is-better" format="percent" />
      </div>
      <div className="col-span-1 text-right">
        <PeerCell value={row.roe} allValues={roes} direction="higher-is-better" format="percent" />
      </div>
      <div className="col-span-1 text-right">
        <PeerCell value={row.fScore} allValues={fScores} direction="higher-is-better" format="integer" />
      </div>
    </li>
  );
}
```

- [ ] **Step 2: Implement peer-row-mobile.tsx**

Create `app/(app)/stock/[ticker]/peers/_components/peer-row-mobile.tsx`:

```tsx
import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { PeerRow as PeerRowData } from '@/lib/services/peers';
import { PeerCell } from './peer-cell';

interface Props {
  row: PeerRowData;
  allRows: PeerRowData[];
  emphasis?: 'target' | 'peer';
}

export function PeerRowMobile({ row, allRows, emphasis = 'peer' }: Props) {
  const marketCaps = allRows.map((r) => r.marketCap);
  const pes        = allRows.map((r) => r.pe);
  const evEbitdas  = allRows.map((r) => r.evEbitda);
  const revGrowths = allRows.map((r) => r.revGrowthYoy);
  const grossMargs = allRows.map((r) => r.grossMargin);
  const roes       = allRows.map((r) => r.roe);
  const fScores    = allRows.map((r) => r.fScore);

  return (
    <li className={cn('rounded border border-border p-3 mb-2 last:mb-0', emphasis === 'target' && 'bg-muted/30')}>
      <div className="flex items-baseline justify-between">
        <Link href={`/stock/${row.ticker}`} className="font-mono font-medium text-lg hover:text-primary">
          {row.ticker}
        </Link>
        {row.similarity != null && (
          <span className="text-xs text-muted-foreground">
            {Math.round(row.similarity * 100)}% match
          </span>
        )}
      </div>
      <div className="text-sm text-muted-foreground mb-2">{row.name}</div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-muted-foreground">Market Cap</div>
          <PeerCell value={row.marketCap} allValues={marketCaps} direction="higher-is-better" format="currency" />
        </div>
        <div>
          <div className="text-muted-foreground">P/E</div>
          <PeerCell value={row.pe} allValues={pes} direction="lower-is-better" format="multiple" />
        </div>
        <div>
          <div className="text-muted-foreground">EV/EBITDA</div>
          <PeerCell value={row.evEbitda} allValues={evEbitdas} direction="lower-is-better" format="multiple" />
        </div>
        <div>
          <div className="text-muted-foreground">Rev Growth</div>
          <PeerCell value={row.revGrowthYoy} allValues={revGrowths} direction="higher-is-better" format="percent" />
        </div>
        <div>
          <div className="text-muted-foreground">Gross Margin</div>
          <PeerCell value={row.grossMargin} allValues={grossMargs} direction="higher-is-better" format="percent" />
        </div>
        <div>
          <div className="text-muted-foreground">ROE</div>
          <PeerCell value={row.roe} allValues={roes} direction="higher-is-better" format="percent" />
        </div>
        <div>
          <div className="text-muted-foreground">F-Score</div>
          <PeerCell value={row.fScore} allValues={fScores} direction="higher-is-better" format="integer" />
        </div>
      </div>
    </li>
  );
}
```

- [ ] **Step 3: Implement peers-skeleton.tsx**

Create `app/(app)/stock/[ticker]/peers/_components/peers-skeleton.tsx`:

```tsx
export function PeersSkeleton() {
  return (
    <div className="space-y-2 animate-pulse">
      <div className="hidden sm:block">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="grid grid-cols-12 gap-3 px-3 py-2 border-b border-border">
            <div className="col-span-2 h-4 bg-muted rounded" />
            <div className="col-span-2 h-4 bg-muted rounded" />
            <div className="col-span-1 h-4 bg-muted rounded" />
            <div className="col-span-1 h-4 bg-muted rounded" />
            <div className="col-span-1 h-4 bg-muted rounded" />
            <div className="col-span-1 h-4 bg-muted rounded" />
            <div className="col-span-1 h-4 bg-muted rounded" />
            <div className="col-span-1 h-4 bg-muted rounded" />
            <div className="col-span-1 h-4 bg-muted rounded" />
            <div className="col-span-1 h-4 bg-muted rounded" />
          </div>
        ))}
      </div>
      <div className="sm:hidden space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded border border-border p-3 h-32 bg-muted/40" />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/\(app\)/stock/\[ticker\]/peers/_components/peer-row.tsx \
  app/\(app\)/stock/\[ticker\]/peers/_components/peer-row-mobile.tsx \
  app/\(app\)/stock/\[ticker\]/peers/_components/peers-skeleton.tsx
git commit -m "$(cat <<'EOF'
feat(peers): row + mobile + skeleton components

Desktop row uses a 12-col grid; each metric cell wraps PeerCell with
the appropriate direction (higher- vs lower-is-better) and format.
Mobile collapses into a 2-col grid card. Skeleton mirrors both
layouts for the page-level Suspense fallback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `peers-table.tsx` + `peers-empty.tsx`

**Files:**
- Create: `app/(app)/stock/[ticker]/peers/_components/peers-table.tsx`
- Create: `app/(app)/stock/[ticker]/peers/_components/peers-empty.tsx`

- [ ] **Step 1: Implement peers-table.tsx**

Create `app/(app)/stock/[ticker]/peers/_components/peers-table.tsx`:

```tsx
import type { PeersResult } from '@/lib/services/peers';
import { PeerRow } from './peer-row';
import { PeerRowMobile } from './peer-row-mobile';

interface Props {
  result: PeersResult;
}

function fallbackNote(result: PeersResult): string {
  const country = result.target.country;
  const k = result.peers.length;
  switch (result.fallback) {
    case 'strict':
      return `${k} peers semantically similar to ${result.target.ticker}, market cap 0.3x–3x${country ? `, ${country}-listed` : ''}.`;
    case 'no_country':
      return `${k} peers semantically similar to ${result.target.ticker}, market cap 0.3x–3x. Not enough same-country matches; showing global peers within size band.`;
    case 'no_size':
      return `${k} peers semantically similar to ${result.target.ticker}${country ? `, ${country}-listed` : ''}. Not enough same-size matches; showing same-country peers regardless of market cap.`;
    case 'global':
      return `${k} peers semantically similar to ${result.target.ticker} (global). Not enough same-country, same-size matches.`;
    case 'target_missing':
      return `No description data for ${result.target.ticker} yet. Try refreshing the universe or wait for tomorrow's sync.`;
  }
}

export function PeersTable({ result }: Props) {
  const allRows = [result.target, ...result.peers];

  return (
    <div className="space-y-4">
      <div className="hidden sm:block rounded border border-border overflow-hidden">
        <header className="grid grid-cols-12 gap-3 px-3 py-2 bg-muted text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <div className="col-span-2">Ticker</div>
          <div className="col-span-2">Name</div>
          <div className="col-span-1">Country</div>
          <div className="col-span-1 text-right">Mkt Cap</div>
          <div className="col-span-1 text-right">P/E</div>
          <div className="col-span-1 text-right">EV/EBITDA</div>
          <div className="col-span-1 text-right">Rev YoY</div>
          <div className="col-span-1 text-right">Gross %</div>
          <div className="col-span-1 text-right">ROE</div>
          <div className="col-span-1 text-right">F-Score</div>
        </header>
        <ul>
          <PeerRow row={result.target} allRows={allRows} emphasis="target" />
          {result.peers.map((p) => (
            <PeerRow key={p.ticker} row={p} allRows={allRows} emphasis="peer" />
          ))}
        </ul>
      </div>

      <ul className="sm:hidden">
        <PeerRowMobile row={result.target} allRows={allRows} emphasis="target" />
        {result.peers.map((p) => (
          <PeerRowMobile key={p.ticker} row={p} allRows={allRows} emphasis="peer" />
        ))}
      </ul>

      <p className="text-xs text-muted-foreground">{fallbackNote(result)}</p>
    </div>
  );
}
```

- [ ] **Step 2: Implement peers-empty.tsx**

Create `app/(app)/stock/[ticker]/peers/_components/peers-empty.tsx`:

```tsx
interface Props {
  ticker: string;
  reason: 'target_missing';
}

export function PeersEmpty({ ticker, reason }: Props) {
  if (reason === 'target_missing') {
    return (
      <div className="rounded border border-dashed border-border p-8 text-center space-y-3">
        <p className="text-sm text-muted-foreground">
          We don't have description data for <span className="font-mono font-medium">{ticker}</span> yet.
        </p>
        <p className="text-xs text-muted-foreground">
          The peers tab needs a description embedding to find semantic neighbors.
          This ticker may not be in the universe seed yet — check back after the next sync.
        </p>
      </div>
    );
  }
  return null;
}
```

- [ ] **Step 3: Verify typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/\(app\)/stock/\[ticker\]/peers/_components/peers-table.tsx \
  app/\(app\)/stock/\[ticker\]/peers/_components/peers-empty.tsx
git commit -m "$(cat <<'EOF'
feat(peers): peers-table shell + peers-empty target-missing state

Table renders the target row emphasized + K peer rows on desktop
(12-col grid) and as cards on mobile. Footer notes which fallback
level fired. Empty state shows when target lacks a description
embedding in companies_universe.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Page + dashboard-tabs wiring

**Files:**
- Create: `app/(app)/stock/[ticker]/peers/page.tsx`
- Modify: `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx`

- [ ] **Step 1: Add `'peers'` to the DashboardTab union**

Open `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx`.

Replace this block:

```ts
export type DashboardTab =
  | 'overview'
  | 'financials'
  | 'technical'
  | 'news'
  | 'insiders'
  | 'holdings'
  | 'filings'
  | 'quality'
  | 'ask';
```

with:

```ts
export type DashboardTab =
  | 'overview'
  | 'financials'
  | 'technical'
  | 'news'
  | 'insiders'
  | 'holdings'
  | 'filings'
  | 'quality'
  | 'peers'
  | 'ask';
```

- [ ] **Step 2: Add Peers to the TABS array**

In the same file, replace this block:

```ts
const TABS: Array<{ value: DashboardTab; label: string; href: (t: string) => string }> = [
  { value: 'overview',   label: 'Overview',   href: (t) => `/stock/${t}` },
  { value: 'financials', label: 'Financials', href: (t) => `/stock/${t}/financials` },
  { value: 'technical',  label: 'Technical',  href: (t) => `/stock/${t}/technical` },
  { value: 'news',       label: 'News',       href: (t) => `/stock/${t}/news` },
  { value: 'insiders',   label: 'Insiders',   href: (t) => `/stock/${t}/insiders` },
  { value: 'holdings',   label: 'Holdings',   href: (t) => `/stock/${t}/holdings` },
  { value: 'filings',    label: 'Filings',    href: (t) => `/stock/${t}/filings` },
  { value: 'quality',    label: 'Quality',    href: (t) => `/stock/${t}/quality` },
  { value: 'ask',        label: 'Ask',        href: (t) => `/stock/${t}/ask` }
];
```

with:

```ts
const TABS: Array<{ value: DashboardTab; label: string; href: (t: string) => string }> = [
  { value: 'overview',   label: 'Overview',   href: (t) => `/stock/${t}` },
  { value: 'financials', label: 'Financials', href: (t) => `/stock/${t}/financials` },
  { value: 'technical',  label: 'Technical',  href: (t) => `/stock/${t}/technical` },
  { value: 'news',       label: 'News',       href: (t) => `/stock/${t}/news` },
  { value: 'insiders',   label: 'Insiders',   href: (t) => `/stock/${t}/insiders` },
  { value: 'holdings',   label: 'Holdings',   href: (t) => `/stock/${t}/holdings` },
  { value: 'filings',    label: 'Filings',    href: (t) => `/stock/${t}/filings` },
  { value: 'quality',    label: 'Quality',    href: (t) => `/stock/${t}/quality` },
  { value: 'peers',      label: 'Peers',      href: (t) => `/stock/${t}/peers` },
  { value: 'ask',        label: 'Ask',        href: (t) => `/stock/${t}/ask` }
];
```

- [ ] **Step 3: Implement the page**

Create `app/(app)/stock/[ticker]/peers/page.tsx`:

```tsx
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { PeersService } from '@/lib/services/peers';
import { DashboardTabs } from '../_components/dashboard-tabs';
import { PeersTable } from './_components/peers-table';
import { PeersEmpty } from './_components/peers-empty';
import { PeersSkeleton } from './_components/peers-skeleton';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface PageProps {
  params: { ticker: string };
}

async function PeersContent({ ticker }: { ticker: string }) {
  const db = getServiceDb();
  const env = loadServerEnv();
  const redis = getRedisCache();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const svc = new PeersService({ db, primary: yf, fallback: fd, redis });

  const result = await svc.getPeers(ticker, 5);

  if (result.fallback === 'target_missing') {
    return <PeersEmpty ticker={ticker} reason="target_missing" />;
  }
  return <PeersTable result={result} />;
}

export default async function PeersPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();

  return (
    <article className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
          <p className="text-sm text-muted-foreground">Peer Comparison</p>
        </div>
        <DashboardTabs ticker={ticker} active="peers" />
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Comparable companies</CardTitle>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<PeersSkeleton />}>
            <PeersContent ticker={ticker} />
          </Suspense>
        </CardContent>
      </Card>
    </article>
  );
}
```

- [ ] **Step 4: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS. The `peers` literal is now in the `DashboardTab` union, so `active="peers"` is valid.

- [ ] **Step 5: Manual smoke test**

```bash
pnpm dev
```

Then in browser:
1. Log in.
2. Visit `/stock/NVDA/peers` (or any watchlist ticker).
3. See "Comparable companies" card.
4. Initial visit shows the skeleton; after ~10s the table renders with the target row + up to 5 peer rows.
5. Quartile color coding: top-quartile value in each metric column is green, bottom is red.
6. Click a peer ticker → navigates to that peer's Overview tab.
7. Visit a delisted/unknown ticker that's in the universe but lacks fundamentals data: cells show "—" for that row.

Stop the dev server when done.

- [ ] **Step 6: Commit**

```bash
git add app/\(app\)/stock/\[ticker\]/peers/page.tsx \
  app/\(app\)/stock/\[ticker\]/_components/dashboard-tabs.tsx
git commit -m "$(cat <<'EOF'
feat(peers): /stock/[TICKER]/peers page + tab nav entry

Server component does the SQL candidate query + ensureDeepData
within a single Suspense boundary (page-level skeleton fallback).
target_missing falls through to the PeersEmpty state. New 'Peers'
tab slotted between Quality and Ask in DashboardTabs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: E2E + push + CI + smoke

**Files:**
- Create: `tests/e2e/peers.spec.ts`

- [ ] **Step 1: Write the E2E spec**

Create `tests/e2e/peers.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { signInAsTestUser } from './fixtures/auth';

test.describe('Peers tab', () => {
  test('navigates from a watchlist ticker to peers and back', async ({ page }) => {
    await signInAsTestUser(page);

    // Use AAPL — top-cap names will be in the universe + companies_universe
    await page.goto('/stock/AAPL');

    // Click Peers tab
    await page.getByRole('link', { name: 'Peers' }).click();
    await expect(page).toHaveURL(/\/stock\/AAPL\/peers/);

    // Page header
    await expect(page.getByRole('heading', { name: 'AAPL' })).toBeVisible();
    await expect(page.getByText('Peer Comparison')).toBeVisible();

    // Table renders within 20s (cold cache ingest ~10-15s)
    await expect(page.getByText('Comparable companies')).toBeVisible();
    // The target row's ticker chip is always visible once data resolves
    await expect(page.getByRole('link', { name: 'AAPL' }).first()).toBeVisible({ timeout: 25_000 });
  });
});
```

- [ ] **Step 2: Run the E2E locally**

```bash
pnpm test:e2e tests/e2e/peers.spec.ts
```

Expected: PASS (1 test). If the test times out at 25s on cold cache, raise to 45s — yfinance can be slow under load.

- [ ] **Step 3: Run the full test suite**

```bash
pnpm test && pnpm test:integration
```

Expected: all green. The new compute/integration tests are in the existing config; nothing else should regress.

- [ ] **Step 4: Run typecheck + lint**

```bash
pnpm typecheck
pnpm lint
```

Expected: clean.

- [ ] **Step 5: Commit the E2E**

```bash
git add tests/e2e/peers.spec.ts
git commit -m "$(cat <<'EOF'
test(peers): E2E happy path — watchlist → peers tab → table renders

Authenticated user navigates from AAPL Overview to Peers tab, sees
'Comparable companies' card, and confirms the AAPL target row renders
within 25s (allowing for cold-cache yfinance ingest).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Push to master**

```bash
git push origin master
```

- [ ] **Step 7: Wait for CI green**

Watch GitHub Actions for the master push. CI runs typecheck + unit + integration + E2E. All must pass.

- [ ] **Step 8: Vercel browser smoke**

Once Vercel deploys the master push:
1. Visit the live `/stock/AAPL/peers` page on the Vercel URL.
2. Confirm the table renders (cold ingest can take up to 20s).
3. Confirm quartile colors are visible.
4. Confirm clicking a peer ticker navigates correctly.
5. Try an obscure ticker not yet in the universe (e.g., `/stock/SMCI/peers`) — confirm the `target_missing` empty state shows.

---

## Self-Review

**Spec coverage check** — every requirement from the spec maps to a task:

- "Top-K semantic neighbors with size band + same country" → Task 3 `runVectorQuery` + Task 2 `selectFallback`.
- "Fallback chain strict → no_country → no_size → global" → Task 2 (pure) + Task 3 (integration).
- "Target not in universe → target_missing" → Task 3 (test #6) + Task 7 (PeersEmpty).
- "Promote-on-demand peer ingest" → Task 3 `ensureDeepData` + tests #2-3.
- "Partial failure: one peer unavailable, others render" → Task 3 test #4.
- "Idempotency: skip yfinance < 24h" → Task 3 test #3.
- "Per-peer timeout 30s" → Task 3 `PEER_TIMEOUT_MS` constant + `Promise.race` in `ensureDeepData`.
- "Auth + ticker validation + k range" → Task 4 tests #3-6.
- "Cache-Control 5min" → Task 4 test #7.
- "PeerRow type with all 11 columns + dataStatus + similarity" → Task 3 type + Task 6 row rendering.
- "Quartile coloring higher- vs lower-is-better" → Task 1 + Task 5 + Task 6.
- "Desktop table + mobile cards" → Task 6.
- "New /stock/[TICKER]/peers tab + DashboardTabs entry" → Task 8.
- "Server-component Suspense (whole-table v1)" → Task 8 `PeersContent` inside Suspense.
- "E2E navigate to Peers tab and confirm render" → Task 9.

No gaps. Spec sections "RLS" (no new policies needed) and "Schema" (no new tables) are trivially covered by their absence in the task list.

**Placeholder scan:** No "TBD" / "TODO" / "etc." anywhere. Every step has the actual code, command, or content the engineer needs.

**Type consistency:**
- `PeerRow` type defined in Task 3 (`lib/services/peers.ts`) — referenced in Task 6 (`peer-row.tsx`), Task 7 (`peers-table.tsx`). Same shape: `{ ticker, name, country, sector, marketCap, pe, evEbitda, revGrowthYoy, grossMargin, roe, fScore, similarity, dataStatus }`. ✓
- `PeersResult` defined in Task 3, used in Task 4 (route returns it) and Task 7 (`PeersTable` accepts it). Same shape: `{ target, peers, fallback, k }`. ✓
- `QuartileDirection` defined in Task 1, used in Task 5 (`peer-cell.tsx`). ✓
- `FallbackLevel` defined in Task 2, used in Task 3 (re-exported via `PeerFallback = FallbackLevel | 'target_missing'`). ✓
- `quartileClass` signature `(value, allValues, direction) → string` consistent between Task 1 and Task 5. ✓
- `selectFallback` signature in Task 2 matches usage in Task 3. ✓
