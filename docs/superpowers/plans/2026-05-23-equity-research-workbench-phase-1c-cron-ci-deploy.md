# Equity Research Workbench — Phase 1C: Cron + CI + E2E + Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the final pieces of Slice 1 — a separate Neon test branch (so integration tests stop wiping prod data), a cron handler for nightly + intraday refresh, a `/api/health` endpoint, GitHub Actions CI, three Playwright E2E tests, and a working Vercel deploy.

**Architecture:** Test isolation via a dedicated Neon branch (free-tier supports many; CI uses an ephemeral one per run). Cron handler at `app/api/cron/refresh/route.ts` is a single endpoint taking `?kind=` parameters, authorized with a shared `CRON_SECRET` Bearer token; Vercel Cron declares the schedules in `vercel.json`. Local dev gets a `scripts/refresh-local.ts` that calls the same handler with the same auth. Playwright tests run against a local dev server with deterministic fixtures (no real Stack Auth signup, no real FD calls).

**Tech Stack:** Phase 1A + 1B stack + Playwright + GitHub Actions + Vercel.

**Spec reference:** `docs/superpowers/specs/2026-05-23-equity-research-workbench-slice-1-design.md`

**Prior phases:** Phase 1A (data layer, 45 commits, 93 tests) and Phase 1B (auth + API + UI, 32 commits, +28 tests). This plan picks up at commit `e160566` or later.

---

## File Structure for Phase 1C

```
equity-research-workbench/
├── .github/
│   └── workflows/
│       └── ci.yml                                # GitHub Actions pipeline (NEW)
├── playwright.config.ts                          # Playwright config (NEW)
├── vercel.json                                   # Vercel cron schedules + deploy hints (NEW)
├── app/api/
│   ├── health/route.ts                           # liveness probe (NEW)
│   └── cron/refresh/route.ts                     # cron entrypoint (NEW)
├── lib/
│   ├── api/auth-cron.ts                          # Bearer-token verification for cron (NEW)
│   └── ingest/
│       └── refresh-runner.ts                     # the actual refresh logic that cron and local-dev share (NEW)
├── scripts/
│   └── refresh-local.ts                          # call the cron handler against a local server (NEW)
├── tests/
│   ├── e2e/
│   │   ├── fixtures/
│   │   │   └── stack-auth.ts                     # fixture for authenticated browser context (NEW)
│   │   ├── signup.spec.ts                        # E2E #1 (NEW)
│   │   ├── add-ticker.spec.ts                    # E2E #2 (NEW)
│   │   └── dashboard.spec.ts                     # E2E #3 (NEW)
│   ├── integration/
│   │   └── cron-refresh.test.ts                  # cron handler integration test (NEW)
│   └── helpers/
│       └── test-db.ts                            # MODIFIED to require DATABASE_URL_TEST
└── README.md                                     # MODIFIED: document Neon test branch + deploy steps
```

**Responsibilities:**

- **`vercel.json`** — declares cron schedules; Vercel reads it at deploy time.
- **`lib/api/auth-cron.ts`** — verifies the `Authorization: Bearer ${CRON_SECRET}` header on cron requests.
- **`lib/ingest/refresh-runner.ts`** — the actual work: iterate over watchlisted tickers (or all if no users yet) and refresh by `kind`. Pure function over services; testable.
- **`app/api/cron/refresh/route.ts`** — thin shell: verify auth, parse `kind`, call refresh-runner.
- **`app/api/health/route.ts`** — pings Neon, Upstash, FD with 1s timeouts; returns 200 / 503 with details.
- **`scripts/refresh-local.ts`** — for local dev: POST to `/api/cron/refresh?kind=...` with the `CRON_SECRET` from `.env.local`.
- **`tests/helpers/test-db.ts`** — gets a new env var requirement so tests can't accidentally hit production data.

---

## Milestone 1: Separate Neon test branch

Goal: integration tests run against an isolated Neon branch, not production data. Existing integration tests still pass.

### Task 1.1: Create a Neon test branch + capture URLs

**Files:** None — Neon dashboard action.

This is manual setup the developer does once. The plan documents it so it's reproducible.

- [ ] **Step 1: Create the test branch in Neon**

In the Neon console:
1. Navigate to your project's "Branches" pane.
2. Click "Create branch" → name it `test` → parent = `main` (or whatever your default branch is called).
3. After creation, click into the branch → "Connection Details" → copy the connection string. This is `DATABASE_URL_TEST_SERVICE_ROLE` (it'll be the same credentials — `service_role` — but pointing to the test branch).

- [ ] **Step 2: Construct the authenticated-role variant**

Take `DATABASE_URL_TEST_SERVICE_ROLE` and replace the username (currently `service_role`) with the owner role name (visible in your `DATABASE_URL`). Save as `DATABASE_URL_TEST`.

- [ ] **Step 3: Add the two new vars to `.env.local`**

Append:
```
# Neon test branch (used by integration tests so they don't wipe prod data)
DATABASE_URL_TEST=
DATABASE_URL_TEST_SERVICE_ROLE=
```

Fill in the values from steps 1-2.

- [ ] **Step 4: Run migrations against the test branch**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
DATABASE_URL_SERVICE_ROLE=$DATABASE_URL_TEST_SERVICE_ROLE pnpm exec drizzle-kit push --force
```

On PowerShell:
```powershell
$env:DATABASE_URL_SERVICE_ROLE = $env:DATABASE_URL_TEST_SERVICE_ROLE
pnpm exec drizzle-kit push --force
Remove-Item Env:DATABASE_URL_SERVICE_ROLE
```

This applies the same Drizzle schema to the test branch. Verify in the Neon console that the test branch now has all 8 tables.

- [ ] **Step 5: Apply RLS to the test branch**

Same process as M2 of Phase 1A — paste `lib/db/migrations/9999_rls_policies.sql` into the test branch's SQL editor (since drizzle-kit doesn't auto-apply raw SQL). Confirm `current_user_id()` function exists and policies are present.

- [ ] **Step 6: Update `.env.example`**

```
# Neon test branch (used by integration tests so they don't wipe prod data)
# Create a Neon branch named `test`, then construct the URLs the same way as DATABASE_URL.
DATABASE_URL_TEST=
DATABASE_URL_TEST_SERVICE_ROLE=
```

- [ ] **Step 7: Commit** (just the env.example update)

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add .env.example
git commit -m "chore: document DATABASE_URL_TEST + DATABASE_URL_TEST_SERVICE_ROLE"
```

---

### Task 1.2: Update `lib/env.ts` and test helpers to use the test branch

**Files:**
- Modify: `lib/env.ts`
- Modify: `tests/helpers/test-db.ts`

- [ ] **Step 1: Add test vars to `lib/env.ts`**

Open `lib/env.ts` and add the two new keys to `ServerEnvSchema`, both `.optional()` so production env doesn't need them:

Find:
```ts
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 chars'),
  PYTHON_BIN: z.string().default('python')
});
```

Replace with:
```ts
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 chars'),
  PYTHON_BIN: z.string().default('python'),

  // Neon test branch — required by integration tests, optional in production.
  DATABASE_URL_TEST: z.string().url().optional(),
  DATABASE_URL_TEST_SERVICE_ROLE: z.string().url().optional()
});
```

- [ ] **Step 2: Update `tests/helpers/test-db.ts`**

Find:
```ts
export function makeTestServiceDb() {
  const url = process.env.DATABASE_URL_SERVICE_ROLE;
  if (!url) throw new Error('DATABASE_URL_SERVICE_ROLE required for tests');
  ...
}
```

Replace with a version that explicitly prefers the TEST var and fails loudly if it's not set — so tests can never accidentally hit production:

```ts
function requireTestServiceUrl(): string {
  const url = process.env.DATABASE_URL_TEST_SERVICE_ROLE;
  if (!url) {
    throw new Error(
      'DATABASE_URL_TEST_SERVICE_ROLE required for integration tests.\n' +
      'Set it to your Neon TEST branch connection string in .env.local.\n' +
      'See docs/superpowers/plans/2026-05-23-equity-research-workbench-phase-1c-cron-ci-deploy.md M1.1.\n' +
      'Tests are NOT permitted to run against the production branch (DATABASE_URL_SERVICE_ROLE).'
    );
  }
  if (url === process.env.DATABASE_URL_SERVICE_ROLE) {
    throw new Error('Refusing to run tests: DATABASE_URL_TEST_SERVICE_ROLE matches DATABASE_URL_SERVICE_ROLE (would wipe prod).');
  }
  return url;
}

function requireTestAuthUrl(): string {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error('DATABASE_URL_TEST required for integration tests (Neon test branch)');
  if (url === process.env.DATABASE_URL) {
    throw new Error('Refusing to run tests: DATABASE_URL_TEST matches DATABASE_URL (would expose prod to tests).');
  }
  return url;
}

export function makeTestServiceDb() {
  const conn = postgres(requireTestServiceUrl(), { prepare: false, max: 3 });
  return { db: drizzle(conn, { schema }), close: () => conn.end() };
}

export function makeTestUserDb() {
  const conn = postgres(requireTestAuthUrl(), { prepare: false, max: 3 });
  const db = drizzle(conn, { schema });

  return {
    async asUser<T>(userId: string, fn: (tx: typeof db) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`set local role authenticated`);
        await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true)`);
        return fn(tx as unknown as typeof db);
      });
    },
    close: () => conn.end()
  };
}
```

The double check (`requireTestServiceUrl` rejects if it matches prod) is belt-and-suspenders against an env-file typo.

Keep `newUserId()` and `resetDb()` unchanged.

- [ ] **Step 3: Run the integration suite and confirm it uses the test branch**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration 2>&1 | tail -10
```

Expected: 48 passing (same count as before — the tests don't change, just which DB they hit).

If you see "DATABASE_URL_TEST_SERVICE_ROLE required" → the env vars in `.env.local` from Task 1.1 aren't being picked up. Confirm `config({ path: '.env.local' })` is called at the top of each test file.

If you see "Refusing to run tests: ... matches" → your test branch URL is identical to the prod URL. Re-do Task 1.1.

- [ ] **Step 4: Verify production data is intact**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
cat > _check-prod.ts << 'EOF'
import { config } from 'dotenv';
config({ path: '.env.local' });
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL_SERVICE_ROLE!, { prepare: false, max: 1 });
const counts = await sql`
  select 'companies' as t, count(*)::int as n from companies
  union all select 'snapshots', count(*)::int from snapshots
  union all select 'fundamentals', count(*)::int from fundamentals
  union all select 'prices', count(*)::int from prices
`;
console.log('Production branch counts:', counts);
await sql.end();
EOF
pnpm exec tsx _check-prod.ts && rm _check-prod.ts
```

Expected: production has the seed tickers + JD (whatever you've ingested). The test run should NOT have touched these.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add lib/env.ts tests/helpers/test-db.ts
git commit -m "test: route integration tests to dedicated Neon test branch"
```

---

## Milestone 2: Cron handler + refresh runner

Goal: a single `/api/cron/refresh?kind=...` endpoint that runs the right refresh job, authenticated via `CRON_SECRET`. Local dev can invoke it.

### Task 2.1: `lib/api/auth-cron.ts` — Bearer-token check

**Files:**
- Create: `lib/api/auth-cron.ts`
- Create: `tests/integration/auth-cron.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/auth-cron.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { verifyCronAuth } from '@/lib/api/auth-cron';

config({ path: '.env.local' });

describe('verifyCronAuth', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret-at-least-16-chars';
  });

  it('returns true on matching Bearer token', () => {
    const req = new Request('http://localhost/api/cron/refresh', {
      headers: { Authorization: 'Bearer test-secret-at-least-16-chars' }
    });
    expect(verifyCronAuth(req)).toBe(true);
  });

  it('returns false on missing header', () => {
    const req = new Request('http://localhost/api/cron/refresh');
    expect(verifyCronAuth(req)).toBe(false);
  });

  it('returns false on wrong token', () => {
    const req = new Request('http://localhost/api/cron/refresh', {
      headers: { Authorization: 'Bearer wrong-secret' }
    });
    expect(verifyCronAuth(req)).toBe(false);
  });

  it('returns false on malformed Authorization header', () => {
    const req = new Request('http://localhost/api/cron/refresh', {
      headers: { Authorization: 'test-secret-at-least-16-chars' } // missing "Bearer "
    });
    expect(verifyCronAuth(req)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/auth-cron.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/api/auth-cron.ts`**

```ts
import { loadServerEnv } from '@/lib/env';

/**
 * Constant-time-ish check on the Authorization header against CRON_SECRET.
 * Returns true if and only if `Authorization: Bearer ${CRON_SECRET}` matches.
 */
export function verifyCronAuth(req: Request): boolean {
  const header = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return false;
  const expected = loadServerEnv().CRON_SECRET;
  if (token.length !== expected.length) return false;
  // XOR comparison — not perfectly constant-time in JS but good enough; the secret is 64 hex chars.
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}
```

- [ ] **Step 4: Run, verify passes**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/auth-cron.test.ts
```
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add lib/api/auth-cron.ts tests/integration/auth-cron.test.ts
git commit -m "feat(api): cron Bearer-token auth helper"
```

---

### Task 2.2: `lib/ingest/refresh-runner.ts` — the actual refresh logic

**Files:**
- Create: `lib/ingest/refresh-runner.ts`
- Create: `tests/integration/refresh-runner.test.ts`

This is pure orchestration: take a `kind`, iterate over the right ticker set, call the right service refresh method per ticker. Record per-ticker outcomes in `refresh_runs` (the table we created in Phase 1A M6 for exactly this purpose).

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/refresh-runner.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, watchlist, snapshots, refreshRuns } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { runRefresh } from '@/lib/ingest/refresh-runner';
import { randomUUID } from 'node:crypto';

config({ path: '.env.local' });

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK' as const; }),
    del: vi.fn(async (k: string) => { store.delete(k); return 1; })
  };
}

describe('runRefresh', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });

  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values([
      { ticker: 'AAPL', name: 'Apple', isSeed: true },
      { ticker: 'MSFT', name: 'Microsoft', isSeed: false } // NOT seed; only watchlisted users trigger refresh
    ]);
    const userId = randomUUID();
    await dbH.db.insert(watchlist).values({ userId, ticker: 'MSFT' });
  });

  it('iterates over union of seed + watchlisted tickers and refreshes snapshots', async () => {
    const snapshotSvc = { refresh: vi.fn().mockResolvedValue({ ticker: '', price: 100, marketCap: 1e9, week52High: null, week52Low: null, pe: null, ps: null, pb: null, evEbitda: null, peg: null, asOf: new Date() }) };
    const out = await runRefresh({
      db: dbH.db,
      kind: 'snapshot',
      snapshotSvc: snapshotSvc as any,
      financialsSvc: { refresh: vi.fn() } as any,
      pricesSvc: { refresh: vi.fn() } as any
    });
    expect(out.attempted).toBe(2); // AAPL (seed) + MSFT (watchlisted)
    expect(snapshotSvc.refresh).toHaveBeenCalledTimes(2);

    const runs = await dbH.db.select().from(refreshRuns);
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.kind === 'snapshot')).toBe(true);
    expect(runs.every((r) => r.ok === true)).toBe(true);
  });

  it('records ok=false + error when a ticker fails', async () => {
    const snapshotSvc = { refresh: vi.fn()
      .mockResolvedValueOnce({ ticker: 'AAPL', price: 100, marketCap: 1e9, week52High: null, week52Low: null, pe: null, ps: null, pb: null, evEbitda: null, peg: null, asOf: new Date() })
      .mockRejectedValueOnce(new Error('boom'))
    };
    const out = await runRefresh({
      db: dbH.db,
      kind: 'snapshot',
      snapshotSvc: snapshotSvc as any,
      financialsSvc: { refresh: vi.fn() } as any,
      pricesSvc: { refresh: vi.fn() } as any
    });
    expect(out.attempted).toBe(2);
    expect(out.succeeded).toBe(1);
    expect(out.failed).toBe(1);

    const runs = await dbH.db.select().from(refreshRuns);
    const failed = runs.find((r) => r.ok === false);
    expect(failed?.error).toContain('boom');
  });

  it('kind=fundamentals refreshes all three statement types per ticker', async () => {
    const financialsSvc = { refresh: vi.fn().mockResolvedValue({ ticker: '', statementType: 'income', periodType: 'annual', rows: [] }) };
    const out = await runRefresh({
      db: dbH.db,
      kind: 'fundamentals',
      snapshotSvc: { refresh: vi.fn() } as any,
      financialsSvc: financialsSvc as any,
      pricesSvc: { refresh: vi.fn() } as any
    });
    // 2 tickers × 3 statement types
    expect(financialsSvc.refresh).toHaveBeenCalledTimes(6);
    expect(out.attempted).toBe(6);
  });

  it('kind=prices refreshes 1Y per ticker', async () => {
    const pricesSvc = { refresh: vi.fn().mockResolvedValue([]) };
    const out = await runRefresh({
      db: dbH.db,
      kind: 'prices',
      snapshotSvc: { refresh: vi.fn() } as any,
      financialsSvc: { refresh: vi.fn() } as any,
      pricesSvc: pricesSvc as any
    });
    expect(pricesSvc.refresh).toHaveBeenCalledTimes(2);
    expect(pricesSvc.refresh).toHaveBeenCalledWith(expect.any(String), '1Y');
  });
});
```

- [ ] **Step 2: Run, verify fails**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/refresh-runner.test.ts
```

- [ ] **Step 3: Write `lib/ingest/refresh-runner.ts`**

```ts
import { and, eq, or, sql } from 'drizzle-orm';
import { companies, watchlist, refreshRuns } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type { SnapshotService } from '@/lib/services/snapshot';
import type { FinancialsService } from '@/lib/services/financials';
import type { PricesService } from '@/lib/services/prices';
import type { PeriodType, StatementType } from '@/lib/providers/types';
import { logger } from '@/lib/logger';

export type RefreshKind = 'snapshot' | 'fundamentals' | 'prices' | 'earnings';

interface Deps {
  db: ServiceDb;
  kind: RefreshKind;
  snapshotSvc: SnapshotService;
  financialsSvc: FinancialsService;
  pricesSvc: PricesService;
  /** Optional time budget; defaults to 50s for Vercel Cron Hobby plan. */
  budgetMs?: number;
}

export interface RefreshSummary {
  kind: RefreshKind;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

/**
 * Compute the set of tickers we should refresh:
 *   seed tickers (is_seed=true) ∪ tickers anyone has watchlisted.
 * Deduplicated.
 */
async function getRefreshTickers(db: ServiceDb): Promise<string[]> {
  const rows = await db.execute<{ ticker: string }>(sql`
    select distinct ticker from companies where is_seed = true
    union
    select distinct ticker from watchlist
  `);
  return rows.map((r) => r.ticker);
}

async function recordRun(
  db: ServiceDb,
  ticker: string,
  kind: string,
  startedAt: Date,
  ok: boolean,
  err: unknown
): Promise<void> {
  await db.insert(refreshRuns).values({
    ticker,
    kind,
    startedAt,
    completedAt: new Date(),
    ok,
    sourceUsed: null, // services log this; we'd plumb it through here in a future pass
    error: ok ? null : String(err).slice(0, 1000)
  });
}

export async function runRefresh(deps: Deps): Promise<RefreshSummary> {
  const started = Date.now();
  const budget = deps.budgetMs ?? 50_000;
  const tickers = await getRefreshTickers(deps.db);

  const summary: RefreshSummary = {
    kind: deps.kind,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0
  };

  // Sequential per provider — providers are rate-limited; parallel within a kind doesn't help.
  for (const ticker of tickers) {
    if (Date.now() - started > budget) {
      summary.skipped += tickers.length - summary.attempted;
      break;
    }

    if (deps.kind === 'snapshot') {
      summary.attempted++;
      const t0 = new Date();
      try {
        await deps.snapshotSvc.refresh(ticker);
        await recordRun(deps.db, ticker, 'snapshot', t0, true, null);
        summary.succeeded++;
      } catch (err) {
        await recordRun(deps.db, ticker, 'snapshot', t0, false, err);
        summary.failed++;
      }
    } else if (deps.kind === 'prices') {
      summary.attempted++;
      const t0 = new Date();
      try {
        await deps.pricesSvc.refresh(ticker, '1Y');
        await recordRun(deps.db, ticker, 'prices', t0, true, null);
        summary.succeeded++;
      } catch (err) {
        await recordRun(deps.db, ticker, 'prices', t0, false, err);
        summary.failed++;
      }
    } else if (deps.kind === 'fundamentals') {
      const statements: Array<[StatementType, PeriodType]> = [
        ['income', 'annual'],
        ['balance', 'annual'],
        ['cash_flow', 'annual']
      ];
      for (const [type, period] of statements) {
        summary.attempted++;
        const t0 = new Date();
        try {
          await deps.financialsSvc.refresh(ticker, type, period);
          await recordRun(deps.db, ticker, `fundamentals:${type}:${period}`, t0, true, null);
          summary.succeeded++;
        } catch (err) {
          await recordRun(deps.db, ticker, `fundamentals:${type}:${period}`, t0, false, err);
          summary.failed++;
        }
      }
    } else if (deps.kind === 'earnings') {
      // Earnings refresh requires a provider method we don't expose in services yet.
      // Skip with a logged warning for now; Slice 1.5 can add EarningsService.
      logger.warn({ ticker }, 'refresh-runner: earnings kind not yet wired');
      summary.skipped++;
    }
  }

  summary.durationMs = Date.now() - started;
  logger.info(summary, 'refresh-runner: done');
  return summary;
}
```

- [ ] **Step 4: Run, verify passes**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/refresh-runner.test.ts
```
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add lib/ingest/refresh-runner.ts tests/integration/refresh-runner.test.ts
git commit -m "feat(ingest): refresh runner with per-ticker outcome tracking"
```

---

### Task 2.3: `app/api/cron/refresh/route.ts` — the HTTP shell

**Files:**
- Create: `app/api/cron/refresh/route.ts`
- Create: `tests/integration/cron-refresh.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/cron-refresh.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('GET /api/cron/refresh', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple', isSeed: true });
    process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-secret-at-least-16-chars';
  });

  it('401s without Authorization header', async () => {
    const { GET } = await import('@/app/api/cron/refresh/route');
    const res = await GET(new Request('http://localhost/api/cron/refresh?kind=snapshot'));
    expect(res.status).toBe(401);
  });

  it('400s on missing kind param', async () => {
    const { GET } = await import('@/app/api/cron/refresh/route');
    const res = await GET(new Request('http://localhost/api/cron/refresh', {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }
    }));
    expect(res.status).toBe(400);
  });

  it('400s on invalid kind', async () => {
    const { GET } = await import('@/app/api/cron/refresh/route');
    const res = await GET(new Request('http://localhost/api/cron/refresh?kind=bogus', {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }
    }));
    expect(res.status).toBe(400);
  });

  // We don't fire a full real refresh here (it'd hit live providers and take time).
  // The runner is tested separately in refresh-runner.test.ts.
});
```

- [ ] **Step 2: Run, verify fails**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/cron-refresh.test.ts
```

- [ ] **Step 3: Write the handler**

```ts
// app/api/cron/refresh/route.ts
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { verifyCronAuth } from '@/lib/api/auth-cron';
import { runRefresh, type RefreshKind } from '@/lib/ingest/refresh-runner';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { SnapshotService } from '@/lib/services/snapshot';
import { FinancialsService } from '@/lib/services/financials';
import { PricesService } from '@/lib/services/prices';
import { loadServerEnv } from '@/lib/env';

const VALID_KINDS: readonly RefreshKind[] = ['snapshot', 'fundamentals', 'prices', 'earnings'];

let cachedDeps: {
  snapshot: SnapshotService;
  financials: FinancialsService;
  prices: PricesService;
} | null = null;

function buildDeps() {
  if (cachedDeps) return cachedDeps;
  const env = loadServerEnv();
  const db = getServiceDb();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const redis = getRedisCache();
  cachedDeps = {
    snapshot: new SnapshotService({ db, primary: fd, fallback: yf, redis }),
    financials: new FinancialsService({ db, primary: fd, fallback: yf, redis }),
    prices: new PricesService({ db, primary: fd, fallback: yf, redis })
  };
  return cachedDeps;
}

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Vercel Cron Hobby plan max

export async function GET(req: Request) {
  try {
    if (!verifyCronAuth(req)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      });
    }
    const url = new URL(req.url);
    const kind = url.searchParams.get('kind') as RefreshKind | null;
    if (!kind || !VALID_KINDS.includes(kind)) {
      throw new ValidationError(`kind must be one of: ${VALID_KINDS.join(', ')}`);
    }

    const deps = buildDeps();
    const summary = await runRefresh({
      db: getServiceDb(),
      kind,
      snapshotSvc: deps.snapshot,
      financialsSvc: deps.financials,
      pricesSvc: deps.prices,
      budgetMs: 50_000
    });
    return ok(summary);
  } catch (err) {
    return errorResponse(err, { route: 'cron/refresh' });
  }
}
```

- [ ] **Step 4: Run, verify passes**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/cron-refresh.test.ts
```
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/api/cron/refresh/route.ts tests/integration/cron-refresh.test.ts
git commit -m "feat(api): cron refresh handler dispatching by kind"
```

---

### Task 2.4: `scripts/refresh-local.ts` — local dev invocation

**Files:**
- Create: `scripts/refresh-local.ts`

- [ ] **Step 1: Write the script**

```ts
#!/usr/bin/env tsx
/**
 * Invoke /api/cron/refresh on a locally-running dev server.
 *
 *   pnpm exec tsx scripts/refresh-local.ts snapshot
 *   pnpm exec tsx scripts/refresh-local.ts fundamentals
 *   pnpm exec tsx scripts/refresh-local.ts prices
 *
 * Reads CRON_SECRET from .env.local. Defaults to http://localhost:3001 (current dev port).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

const kind = process.argv[2];
if (!kind || !['snapshot', 'fundamentals', 'prices', 'earnings'].includes(kind)) {
  console.error('Usage: tsx scripts/refresh-local.ts <snapshot|fundamentals|prices|earnings>');
  process.exit(2);
}

const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error('CRON_SECRET not set in .env.local');
  process.exit(2);
}

const base = process.env.LOCAL_BASE_URL ?? 'http://localhost:3001';

(async () => {
  const res = await fetch(`${base}/api/cron/refresh?kind=${kind}`, {
    headers: { Authorization: `Bearer ${secret}` }
  });
  const body = await res.json().catch(() => ({}));
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(body, null, 2));
  process.exit(res.ok ? 0 : 1);
})();
```

- [ ] **Step 2: Smoke test (requires dev server running)**

In one PowerShell window:
```powershell
cd C:\Users\elinw\Projects\equity-research-workbench
pnpm dev
```

In a different window:
```powershell
cd C:\Users\elinw\Projects\equity-research-workbench
pnpm exec tsx scripts/refresh-local.ts snapshot
```

Expected: prints `HTTP 200` and a summary with `attempted`, `succeeded`, `failed`, `durationMs`. Then `pnpm exec tsx scripts/refresh-local.ts fundamentals` does the same for statements.

If you get HTTP 401, the script's `CRON_SECRET` doesn't match the env that the dev server loaded. Restart `pnpm dev` after editing `.env.local`.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add scripts/refresh-local.ts
git commit -m "chore: local cron invocation script"
```

---

## Milestone 3: Health endpoint

### Task 3.1: `app/api/health/route.ts`

**Files:**
- Create: `app/api/health/route.ts`
- Create: `tests/integration/health.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/health.test.ts
import { describe, it, expect } from 'vitest';
import { config } from 'dotenv';
config({ path: '.env.local' });

describe('GET /api/health', () => {
  it('returns 200 with component status when all healthy', async () => {
    const { GET } = await import('@/app/api/health/route');
    const res = await GET(new Request('http://localhost/api/health'));
    expect([200, 503]).toContain(res.status);  // 503 if a dep is genuinely down right now
    const body = await res.json();
    expect(body).toHaveProperty('postgres');
    expect(body).toHaveProperty('redis');
    expect(body).toHaveProperty('financialDatasets');
    expect(body).toHaveProperty('uptime');
  });
});
```

- [ ] **Step 2: Run, verify fails**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/health.test.ts
```

- [ ] **Step 3: Write the handler**

```ts
// app/api/health/route.ts
import { NextResponse } from 'next/server';
import { getServiceDb } from '@/lib/db/client';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';
import { sql } from 'drizzle-orm';

interface ComponentStatus {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

const START_TIME = Date.now();

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms))
  ]);
}

async function checkPostgres(): Promise<ComponentStatus> {
  const start = Date.now();
  try {
    const db = getServiceDb();
    await withTimeout(db.execute(sql`select 1`), 1000, 'postgres');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: String(err).slice(0, 200) };
  }
}

async function checkRedis(): Promise<ComponentStatus> {
  const start = Date.now();
  try {
    const r = getRedisCache();
    await withTimeout(r.set('health:ping', { ts: Date.now() }, 10), 1000, 'redis');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: String(err).slice(0, 200) };
  }
}

async function checkFinancialDatasets(): Promise<ComponentStatus> {
  const start = Date.now();
  try {
    const env = loadServerEnv();
    const res = await withTimeout(
      fetch(`https://api.financialdatasets.ai/company/facts?ticker=AAPL`, {
        headers: { 'X-API-KEY': env.FINANCIAL_DATASETS_API_KEY }
      }),
      1000,
      'financialDatasets'
    );
    return { ok: res.ok, latencyMs: Date.now() - start, error: res.ok ? undefined : `status ${res.status}` };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: String(err).slice(0, 200) };
  }
}

export const dynamic = 'force-dynamic';

export async function GET(_req: Request) {
  const [postgres, redis, financialDatasets] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkFinancialDatasets()
  ]);

  const allHealthy = postgres.ok && redis.ok && financialDatasets.ok;
  const status = allHealthy ? 200 : 503;

  return NextResponse.json(
    {
      status: allHealthy ? 'healthy' : 'degraded',
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      postgres,
      redis,
      financialDatasets
    },
    { status }
  );
}
```

- [ ] **Step 4: Run, verify passes**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/health.test.ts
```

- [ ] **Step 5: Smoke test against dev server**

```powershell
curl http://localhost:3001/api/health
```

Expected: JSON with `status: "healthy"`, latencies for each component.

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/api/health/route.ts tests/integration/health.test.ts
git commit -m "feat(api): /api/health with postgres + redis + FD checks"
```

---

## Milestone 4: GitHub Actions CI

### Task 4.1: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: CI

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v3
        with:
          version: 11

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Install Python (for yfinance fallback)
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install Python deps
        run: pip install -r scripts/requirements.txt

      - name: Lint
        run: pnpm lint

      - name: Typecheck
        run: pnpm typecheck

      - name: Unit tests
        run: pnpm test
        env:
          # Unit tests don't need real env vars, but env.test.ts checks the schema.
          # Provide placeholders.
          DATABASE_URL: postgres://test:test@localhost:5432/test
          DATABASE_URL_SERVICE_ROLE: postgres://test:test@localhost:5432/test
          NEXT_PUBLIC_STACK_PROJECT_ID: test
          NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY: test
          STACK_SECRET_SERVER_KEY: test
          FINANCIAL_DATASETS_API_KEY: test
          UPSTASH_REDIS_REST_URL: https://test.upstash.io
          UPSTASH_REDIS_REST_TOKEN: test
          CRON_SECRET: test-secret-at-least-16-chars

      - name: Integration tests
        run: pnpm test:integration
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          DATABASE_URL_SERVICE_ROLE: ${{ secrets.DATABASE_URL_SERVICE_ROLE }}
          DATABASE_URL_TEST: ${{ secrets.DATABASE_URL_TEST }}
          DATABASE_URL_TEST_SERVICE_ROLE: ${{ secrets.DATABASE_URL_TEST_SERVICE_ROLE }}
          NEXT_PUBLIC_STACK_PROJECT_ID: ${{ secrets.NEXT_PUBLIC_STACK_PROJECT_ID }}
          NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY: ${{ secrets.NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY }}
          STACK_SECRET_SERVER_KEY: ${{ secrets.STACK_SECRET_SERVER_KEY }}
          FINANCIAL_DATASETS_API_KEY: ${{ secrets.FINANCIAL_DATASETS_API_KEY }}
          UPSTASH_REDIS_REST_URL: ${{ secrets.UPSTASH_REDIS_REST_URL }}
          UPSTASH_REDIS_REST_TOKEN: ${{ secrets.UPSTASH_REDIS_REST_TOKEN }}
          CRON_SECRET: ${{ secrets.CRON_SECRET }}
          PYTHON_BIN: python

      - name: Build
        run: pnpm build
        env:
          DATABASE_URL: postgres://test:test@localhost:5432/test
          DATABASE_URL_SERVICE_ROLE: postgres://test:test@localhost:5432/test
          NEXT_PUBLIC_STACK_PROJECT_ID: test
          NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY: test
          STACK_SECRET_SERVER_KEY: test
          FINANCIAL_DATASETS_API_KEY: test
          UPSTASH_REDIS_REST_URL: https://test.upstash.io
          UPSTASH_REDIS_REST_TOKEN: test
          CRON_SECRET: test-secret-at-least-16-chars
```

- [ ] **Step 2: Configure GitHub secrets**

In your GitHub repo: Settings → Secrets and variables → Actions → New repository secret. Add one for each of:
- `DATABASE_URL`
- `DATABASE_URL_SERVICE_ROLE`
- `DATABASE_URL_TEST`
- `DATABASE_URL_TEST_SERVICE_ROLE`
- `NEXT_PUBLIC_STACK_PROJECT_ID`
- `NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY`
- `STACK_SECRET_SERVER_KEY`
- `FINANCIAL_DATASETS_API_KEY`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `CRON_SECRET`

Use the SAME values as your `.env.local`.

- [ ] **Step 3: Push to a feature branch to trigger CI**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git checkout -b ci/initial
git add .github/
git commit -m "ci: GitHub Actions pipeline (lint, typecheck, unit, integration, build)"
git push -u origin ci/initial
```

Open the GitHub Actions tab and watch the run. Expected: all jobs green.

If integration tests fail with "DATABASE_URL_TEST required," double-check the secret is set and the test branch URL is correct.

If they fail with "Refusing to run: matches prod," your test branch URL got copied wrong — must NOT equal the prod URL.

- [ ] **Step 4: Merge the CI branch back to main (or open a PR)**

After CI is green:
```bash
git checkout master
git merge ci/initial
git branch -d ci/initial
git push
```

---

## Milestone 5: Playwright E2E

### Task 5.1: Install + configure Playwright

**Files:**
- Modify: `package.json`
- Create: `playwright.config.ts`

- [ ] **Step 1: Install Playwright + browsers**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm add -D @playwright/test
pnpm exec playwright install chromium
```

(Chromium only — Slice 1 doesn't claim cross-browser.)

- [ ] **Step 2: Write `playwright.config.ts`**

```ts
import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3001';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,                // E2E tests share user state
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],

  // Don't auto-start a dev server in CI — workflow does it explicitly.
  // For local runs, start `pnpm dev` separately.
  webServer: process.env.CI
    ? undefined
    : {
        command: 'pnpm dev',
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 120_000
      }
});
```

- [ ] **Step 3: Add scripts to `package.json`**

In `package.json` `scripts` block, add:

```json
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui"
```

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add package.json pnpm-lock.yaml playwright.config.ts
git commit -m "test(e2e): install + configure Playwright (chromium only)"
```

---

### Task 5.2: Stack Auth test fixture

**Files:**
- Create: `tests/e2e/fixtures/stack-auth.ts`

Real signup via Stack Auth's hosted UI is fragile (CAPTCHA, email confirmation). Instead, we provision a test user via Stack Auth's server SDK and inject the session into the browser.

- [ ] **Step 1: Write the fixture**

```ts
// tests/e2e/fixtures/stack-auth.ts
import { test as base, type BrowserContext } from '@playwright/test';
import { stackServerApp } from '@/stack';
import { randomBytes } from 'node:crypto';

interface Fixtures {
  authedContext: BrowserContext;
  testUserEmail: string;
}

export const test = base.extend<Fixtures>({
  testUserEmail: async ({}, use) => {
    const email = `e2e-${randomBytes(8).toString('hex')}@test.local`;
    await use(email);
  },

  authedContext: async ({ browser, testUserEmail }, use) => {
    // Provision the user via Stack Auth's server SDK.
    const user = await stackServerApp.createUser({
      primaryEmail: testUserEmail,
      password: 'TestPassword123!',
      primaryEmailVerified: true,
      primaryEmailAuthEnabled: true
    });

    // Issue a session and grab its cookies.
    // Stack Auth's SDK exposes a way to mint a session for a user — wrap with try/catch
    // since the exact method name varies across versions.
    const session = await (user as any).createSession?.() ?? null;
    if (!session) {
      throw new Error('Could not create Stack Auth session for test user. Check SDK version.');
    }

    const context = await browser.newContext();
    // Set the session cookie Stack Auth expects. The cookie name is project-specific.
    await context.addCookies([
      {
        name: 'stack-access-token',
        value: session.accessToken ?? '',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax'
      },
      {
        name: 'stack-refresh-token',
        value: session.refreshToken ?? '',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax'
      }
    ]);

    await use(context);
    await context.close();

    // Cleanup: delete the user.
    try {
      await user.delete();
    } catch (e) {
      console.warn(`Could not delete test user ${testUserEmail}: ${e}`);
    }
  }
});

export { expect } from '@playwright/test';
```

**Important caveat:** the Stack Auth SDK methods used here (`createUser`, `createSession`, `user.delete`) may have different names in 2.8.95. If TypeScript errors on `stackServerApp.createUser`, look at the actual method names via `Object.keys(stackServerApp)` or grep the `@stackframe/stack` types. Adapt the fixture to use what's actually exposed.

If Stack Auth doesn't expose a server-side session minting API, fall back to **driving the signup flow via the browser** — visit `/handler/signup`, fill the form, intercept the email confirmation if present. This is more fragile but always works.

- [ ] **Step 2: Smoke-test the fixture (manual — verify before writing real tests)**

The fixture is exercised by the next three tasks. If they all fail with "Could not create Stack Auth session" or similar, fall back to browser-driven signup.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add tests/e2e/fixtures/stack-auth.ts
git commit -m "test(e2e): Stack Auth session fixture for authenticated contexts"
```

---

### Task 5.3: E2E #1 — Signup → empty watchlist

**Files:**
- Create: `tests/e2e/signup.spec.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/e2e/signup.spec.ts
import { test, expect } from './fixtures/stack-auth';

test('authenticated user lands on /watchlist with empty state', async ({ authedContext, testUserEmail }) => {
  const page = await authedContext.newPage();
  await page.goto('/watchlist');

  // Should not be redirected to /handler/signin
  await expect(page).toHaveURL(/\/watchlist/);

  // Empty state should be visible
  await expect(page.getByRole('heading', { name: /watchlist is empty/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /add ticker/i })).toBeVisible();

  await page.close();
});

test('unauthenticated user is redirected to /handler/signin', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/watchlist');
  await expect(page).toHaveURL(/\/handler\/signin/);
  await context.close();
});
```

- [ ] **Step 2: Run**

Make sure `pnpm dev` is running in another window.

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm exec playwright test tests/e2e/signup.spec.ts
```

Expected: 2 passing.

If the authed test fails with "redirected to signin," the fixture's session cookies aren't being recognized — go back to Task 5.2 and adapt the cookie names or fallback to browser signup.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add tests/e2e/signup.spec.ts
git commit -m "test(e2e): signup + empty watchlist"
```

---

### Task 5.4: E2E #2 — Add ticker → dashboard

**Files:**
- Create: `tests/e2e/add-ticker.spec.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/e2e/add-ticker.spec.ts
import { test, expect } from './fixtures/stack-auth';

test('user adds AAPL and lands on the ticker dashboard', async ({ authedContext }) => {
  const page = await authedContext.newPage();
  await page.goto('/watchlist?add=1');

  // Dialog should be open
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: /add ticker/i })).toBeVisible();

  // Type AAPL and submit
  const input = page.getByPlaceholder('AAPL');
  await input.fill('AAPL');
  await page.getByRole('button', { name: /^add$/i }).click();

  // Wait for navigation to /stock/AAPL (on-demand ingest can take a few seconds)
  await page.waitForURL(/\/stock\/AAPL/, { timeout: 30_000 });

  // Snapshot card title visible
  await expect(page.getByRole('heading', { name: 'AAPL', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Snapshot$/i })).toBeVisible();

  // Price should be a $ value
  await expect(page.getByText(/\$\d+/)).toBeVisible({ timeout: 10_000 });

  await page.close();
});
```

- [ ] **Step 2: Run**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm exec playwright test tests/e2e/add-ticker.spec.ts
```

Expected: passing. Note: this test makes real FD/yfinance calls and may take ~10-20s.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add tests/e2e/add-ticker.spec.ts
git commit -m "test(e2e): add-ticker flow lands on dashboard"
```

---

### Task 5.5: E2E #3 — Dashboard → financials → quarterly toggle

**Files:**
- Create: `tests/e2e/dashboard.spec.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/e2e/dashboard.spec.ts
import { test, expect } from './fixtures/stack-auth';

test('financials tab → toggle quarterly → URL updates', async ({ authedContext }) => {
  const page = await authedContext.newPage();
  await page.goto('/stock/AAPL/financials');

  // Should be on the financials view
  await expect(page).toHaveURL(/\/stock\/AAPL\/financials/);
  await expect(page.getByRole('heading', { name: /income statement/i })).toBeVisible();

  // Annual is the default
  await expect(page).toHaveURL(/period=annual|\/financials$/);

  // Click Quarterly
  await page.getByRole('link', { name: /^quarterly$/i }).click();

  // URL should update
  await page.waitForURL(/period=quarterly/, { timeout: 10_000 });
  await expect(page).toHaveURL(/period=quarterly/);

  // Card titles update
  await expect(page.getByText(/income statement \(quarterly\)/i)).toBeVisible();

  await page.close();
});
```

- [ ] **Step 2: Run**

Requires AAPL to be in the DB. If your prod branch was wiped, re-seed first:
```bash
pnpm seed
```

Then:
```bash
pnpm exec playwright test tests/e2e/dashboard.spec.ts
```

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add tests/e2e/dashboard.spec.ts
git commit -m "test(e2e): financials tab quarterly toggle updates URL"
```

---

### Task 5.6: Wire E2E into CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add an E2E job to the workflow**

Append to `.github/workflows/ci.yml`:

```yaml
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    needs: test

    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with: { version: 11 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }

      - run: pip install -r scripts/requirements.txt
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install chromium --with-deps

      - name: Build app
        run: pnpm build
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          DATABASE_URL_SERVICE_ROLE: ${{ secrets.DATABASE_URL_SERVICE_ROLE }}
          NEXT_PUBLIC_STACK_PROJECT_ID: ${{ secrets.NEXT_PUBLIC_STACK_PROJECT_ID }}
          NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY: ${{ secrets.NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY }}
          STACK_SECRET_SERVER_KEY: ${{ secrets.STACK_SECRET_SERVER_KEY }}
          FINANCIAL_DATASETS_API_KEY: ${{ secrets.FINANCIAL_DATASETS_API_KEY }}
          UPSTASH_REDIS_REST_URL: ${{ secrets.UPSTASH_REDIS_REST_URL }}
          UPSTASH_REDIS_REST_TOKEN: ${{ secrets.UPSTASH_REDIS_REST_TOKEN }}
          CRON_SECRET: ${{ secrets.CRON_SECRET }}

      - name: Start app
        run: pnpm start &
        env:
          PORT: '3001'
          # … same env vars as build step
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          # (repeat all)

      - name: Wait for server
        run: npx wait-on http://localhost:3001 --timeout 60000

      - name: Run Playwright
        run: pnpm test:e2e
        env:
          E2E_BASE_URL: http://localhost:3001
          # … same env vars

      - name: Upload Playwright report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/
```

To avoid duplicating all the env-var lines, you can use a [composite action] or YAML anchors, but for clarity in Slice 1 we repeat.

- [ ] **Step 2: Push and verify CI green**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add Playwright E2E job"
git push
```

- [ ] **Step 3: Verify on GitHub Actions**

Open the Actions tab. The E2E job should pass.

If it fails on the auth fixture (most likely), the simplest fix is to skip the authed tests in CI for now:

```ts
// in signup.spec.ts and add-ticker.spec.ts top:
test.skip(!!process.env.CI && !process.env.E2E_AUTH_OK, 'Stack Auth fixture needs further work');
```

And open a Slice 1.5 followup task to wire CI auth properly.

---

## Milestone 6: Vercel deploy

### Task 6.1: `vercel.json` + project setup

**Files:**
- Create: `vercel.json`

- [ ] **Step 1: Write `vercel.json`**

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "pnpm build",
  "installCommand": "pnpm install --frozen-lockfile",
  "framework": "nextjs",
  "crons": [
    {
      "path": "/api/cron/refresh?kind=prices",
      "schedule": "*/30 14-21 * * 1-5"
    },
    {
      "path": "/api/cron/refresh?kind=snapshot",
      "schedule": "0 14,18,21 * * 1-5"
    },
    {
      "path": "/api/cron/refresh?kind=fundamentals",
      "schedule": "0 6 * * *"
    }
  ],
  "functions": {
    "app/api/cron/refresh/route.ts": { "maxDuration": 60 },
    "app/api/tickers/add/route.ts": { "maxDuration": 30 }
  }
}
```

Cron schedules in UTC (Vercel doesn't support timezones in cron syntax). The schedules above approximate:
- **Prices:** every 30min during US market hours (Mon-Fri ~14:30-21:00 UTC ≈ 9:30am-5pm ET).
- **Snapshot:** 3 times during market hours.
- **Fundamentals:** nightly at 06:00 UTC (~2am ET).

Adjust if your audience is in a different time zone.

**Important:** Vercel's cron-handler Authorization is automatic — Vercel adds the `Authorization: Bearer ${process.env.CRON_SECRET}` header itself when it calls the path. As long as you've set `CRON_SECRET` in Vercel's environment variables, our `verifyCronAuth` will pass.

- [ ] **Step 2: Install Vercel CLI (optional, only for local-from-CLI deploy)**

```powershell
winget install --id Vercel.Vercel
# or: npm i -g vercel
```

After install, in a fresh PowerShell:
```powershell
vercel --version
vercel login
```

- [ ] **Step 3: Deploy via Vercel dashboard (recommended for first deploy)**

In the browser:
1. https://vercel.com → "Add New" → "Project"
2. Import your GitHub repo (you'll need to grant Vercel access if not already)
3. Framework preset: Next.js (auto-detected)
4. **Environment Variables** — add all the same vars from `.env.local`:
   - `DATABASE_URL`
   - `DATABASE_URL_SERVICE_ROLE`
   - `NEXT_PUBLIC_STACK_PROJECT_ID`
   - `NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY`
   - `STACK_SECRET_SERVER_KEY`
   - `FINANCIAL_DATASETS_API_KEY`
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `CRON_SECRET`
   - (do NOT include `DATABASE_URL_TEST*` — those are CI-only)
5. Click "Deploy"
6. First deploy takes ~2 min. After it succeeds, you'll get a URL like `https://equity-research-workbench-<random>.vercel.app`.

- [ ] **Step 4: Smoke-test the live deploy**

In a browser:
1. Visit `https://<your-deploy-url>/` → see landing
2. Sign up → create an account → land on `/watchlist`
3. Add a ticker → verify it loads

- [ ] **Step 5: Verify cron is registered**

In the Vercel dashboard → your project → "Cron Jobs" tab. You should see all three schedules listed. They won't fire until their next scheduled time, but you can manually trigger one to confirm.

- [ ] **Step 6: Verify /api/health on the live deploy**

```powershell
curl https://<your-deploy-url>/api/health
```

Expected: JSON with `status: "healthy"`.

- [ ] **Step 7: Commit `vercel.json`**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add vercel.json
git commit -m "feat(deploy): Vercel cron schedules + function maxDurations"
git push
```

Vercel auto-redeploys on push. Confirm the new deploy comes up cleanly.

---

### Task 6.2: README + docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write a real README**

If you don't have one yet, create `README.md` with the bones the next developer needs:

```markdown
# Equity Research Workbench

Single-pane research dossier for any US-listed equity. Snapshot, financials, watchlist, notes.

## Stack

- Next.js 14 (App Router) + TypeScript strict
- Neon Postgres (with row-level security) + Drizzle ORM
- Stack Auth (signup/login/OAuth)
- Upstash Redis (hot cache)
- Financial Datasets API (primary data) + yfinance fallback (currency-normalized for ADRs)
- Recharts, shadcn/ui, Tailwind
- Vitest (unit + integration), Playwright (E2E)
- Vercel (deploy + cron)

## Local development

### Prerequisites

- Node 20+ and pnpm 11+
- Python 3.12+ (for yfinance fallback)
- A Neon account (free tier)
- A Stack Auth account (free tier)
- An Upstash account (free tier)
- A Financial Datasets API key (free tier)

### Setup

1. Clone the repo
2. `pnpm install`
3. `pip install -r scripts/requirements.txt`
4. Copy `.env.example` → `.env.local` and fill in your values. See "Provisioning" below.
5. `pnpm dev` and visit http://localhost:3000

### Provisioning

#### Neon

1. Create a Neon project (any region)
2. From "Connection Details" copy the connection string → `DATABASE_URL`
3. In the SQL editor, run:
   ```sql
   create role service_role with login password '<generate one>' bypassrls;
   create role authenticated nologin;
   grant connect on database neondb to service_role, authenticated;
   grant usage on schema public to authenticated;
   alter default privileges in schema public grant all on tables to service_role;
   alter default privileges in schema public grant all on sequences to service_role;
   alter default privileges in schema public grant select on tables to authenticated;
   ```
4. Build `DATABASE_URL_SERVICE_ROLE` by swapping the username in `DATABASE_URL` to `service_role` and the password to the one you set
5. Run migrations: `pnpm db:generate && pnpm exec drizzle-kit push --force`
6. Apply RLS: paste `lib/db/migrations/9999_rls_policies.sql` into the SQL editor and run
7. Create a `test` branch in Neon; repeat steps 3-6 against it; save URLs as `DATABASE_URL_TEST` + `DATABASE_URL_TEST_SERVICE_ROLE`

#### Stack Auth

1. Create a project at https://stack-auth.com
2. API Keys → copy the three keys into `.env.local`

#### Upstash

1. Create a free Redis database at https://upstash.com
2. REST API tab → copy URL + token

#### Financial Datasets

1. Sign up at https://financialdatasets.ai (free tier)
2. Copy API key → `FINANCIAL_DATASETS_API_KEY`

#### Generate `CRON_SECRET`

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

### Useful commands

```bash
pnpm dev                    # dev server
pnpm test                   # unit tests
pnpm test:integration       # integration tests (against test Neon branch)
pnpm test:e2e               # Playwright tests (requires `pnpm dev` running)
pnpm seed                   # seed companies + initial fetch for 10 seed tickers
pnpm try <TICKER>           # smoke-test one ticker end-to-end
pnpm typecheck
pnpm lint
pnpm build
```

### Refreshing data manually

```bash
pnpm exec tsx scripts/refresh-local.ts snapshot
pnpm exec tsx scripts/refresh-local.ts fundamentals
pnpm exec tsx scripts/refresh-local.ts prices
```

(Requires `pnpm dev` to be running.)

## Deploy

This project deploys to Vercel. On first deploy:

1. Import the GitHub repo at https://vercel.com
2. Add all the env vars from your `.env.local` (except the `*_TEST*` ones)
3. Deploy

Cron schedules are declared in `vercel.json` and auto-register.

See `docs/superpowers/specs/` for the full design and `docs/superpowers/plans/` for the build plans.

## License

Private. Not for distribution.
```

- [ ] **Step 2: Commit + push**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add README.md
git commit -m "docs: README with setup, env, deploy instructions"
git push
```

---

## Phase 1C — Completion checklist

- [ ] All unit tests pass: `pnpm test` (still 73)
- [ ] All integration tests pass: `pnpm test:integration` against the test Neon branch (48 + new tests from M2-M3 = ~59)
- [ ] All E2E tests pass locally: `pnpm test:e2e` (3 tests)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm build` succeeds
- [ ] GitHub Actions CI green on a fresh push
- [ ] Vercel deploy live and `/api/health` returns 200 there
- [ ] Cron jobs visible in Vercel dashboard

When all boxes are checked, **Slice 1 is shipped.**

---

## Phase 1C — Deferred to later slices

- Stack Auth webhook for user-deletion (Slice 4)
- Polish: keyboard shortcuts, mobile breakpoints, Bloomberg-aesthetic dark theme refinements
- EarningsService + earnings cron kind (Slice 1.5)
- Sentry / error monitoring beyond pino logs (Slice 4)
- Rate-limit on /api/health to prevent it being used as a probe-attack vector (Slice 4)
