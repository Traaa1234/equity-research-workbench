# Equity Research Workbench — Phase 1A: Foundation + Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Next.js + Supabase project with a complete data layer (schema, providers, cache, services, compute) that can fetch and persist financial data for any ticker via script. No UI, auth, or HTTP routes yet — those land in Phase 1B.

**Architecture:** Single Next.js 14 app with App Router. Drizzle ORM over Supabase Postgres. Upstash Redis as the hot cache. Financial Datasets API as primary data source, yfinance via Python subprocess as fallback. Layered access: services → cache → providers → external APIs. UI talks only to services.

**Tech Stack:** Next.js 14, TypeScript, Drizzle, Supabase (local + cloud), Upstash Redis, Vitest, pino, Python 3.11+ with yfinance.

**Spec reference:** `docs/superpowers/specs/2026-05-23-equity-research-workbench-slice-1-design.md`

---

## File Structure for Phase 1A

```
equity-research-workbench/
├── .env.example                          # documented env schema
├── .env.local                            # gitignored, developer-filled
├── .gitignore
├── .nvmrc                                # Node 20
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vitest.config.ts
├── drizzle.config.ts
├── next.config.mjs
├── supabase/
│   ├── config.toml                       # supabase local config
│   └── migrations/                       # generated SQL (Drizzle-kit + hand-written RLS)
├── lib/
│   ├── env.ts                            # zod-validated env loader
│   ├── logger.ts                         # pino instance
│   ├── db/
│   │   ├── client.ts                     # Drizzle client factory
│   │   ├── schema.ts                     # Drizzle table definitions
│   │   └── types.ts                      # exported row types
│   ├── compute/
│   │   ├── multiples.ts                  # P/E, P/S, P/B, EV/EBITDA, PEG
│   │   ├── growth.ts                     # YoY, CAGR
│   │   └── returns.ts                    # ROE, ROA, ROIC
│   ├── providers/
│   │   ├── types.ts                      # normalized provider types + error classes
│   │   ├── financial-datasets.ts         # FD adapter
│   │   ├── yfinance.ts                   # TS adapter that spawns Python
│   │   └── __fixtures__/                 # recorded API responses for tests
│   ├── cache/
│   │   ├── ttls.ts                       # TTL constants
│   │   ├── redis.ts                      # Upstash client + helpers
│   │   └── postgres.ts                   # freshness check + upsert helpers
│   ├── services/
│   │   ├── snapshot.ts
│   │   ├── financials.ts
│   │   ├── prices.ts
│   │   └── watchlist.ts
│   └── seed/
│       └── tickers.ts                    # 10 seed ticker constants
├── scripts/
│   ├── yfinance_fetch.py                 # Python script invoked by TS adapter
│   ├── seed.ts                           # seed companies table + initial fetch
│   └── try-snapshot.ts                   # smoke-test script: `pnpm try AAPL`
└── tests/
    ├── compute/
    │   ├── multiples.test.ts
    │   ├── growth.test.ts
    │   └── returns.test.ts
    ├── providers/
    │   ├── financial-datasets.test.ts
    │   └── yfinance.test.ts
    ├── cache/
    │   ├── redis.test.ts
    │   └── postgres.test.ts
    ├── services/
    │   ├── snapshot.test.ts
    │   ├── financials.test.ts
    │   ├── prices.test.ts
    │   └── watchlist.test.ts
    └── helpers/
        ├── test-db.ts                    # spin up clean DB per suite
        └── fixtures.ts                   # load __fixtures__ JSON
```

**Responsibilities:**

- **`compute/`** — pure functions, no I/O, no external deps. Heavily unit-tested.
- **`providers/`** — talk to external APIs; return normalized types; map errors to typed error classes. No knowledge of cache or DB.
- **`cache/`** — read-through abstractions. Redis for hot, Postgres for cold/durable.
- **`services/`** — business logic. Pick provider, handle fallback, persist. The only layer the UI/API will call in later phases.
- **`db/`** — schema definitions and typed client. Nothing else.

---

## Milestone 1: Project Scaffold

Goal: empty Next.js project with all tooling configured, type checks clean.

### Task 1.1: Initialize repository and Node toolchain

**Files:**
- Create: `C:/Users/elinw/Projects/equity-research-workbench/.nvmrc`
- Create: `C:/Users/elinw/Projects/equity-research-workbench/.gitignore`
- Create: `C:/Users/elinw/Projects/equity-research-workbench/package.json`

- [ ] **Step 1: Write `.nvmrc`**

```
20
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
.next/
out/
.env.local
.env*.local
*.log
.vercel
.DS_Store
coverage/
.vitest-cache/
supabase/.branches
supabase/.temp
__pycache__/
*.pyc
.venv/
```

- [ ] **Step 3: Initialize package.json**

Run: `cd C:/Users/elinw/Projects/equity-research-workbench && pnpm init`

Then replace generated `package.json` with:

```json
{
  "name": "equity-research-workbench",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "lint": "next lint",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx scripts/migrate.ts",
    "supabase:start": "supabase start",
    "supabase:stop": "supabase stop",
    "seed": "tsx scripts/seed.ts",
    "try": "tsx scripts/try-snapshot.ts"
  }
}
```

- [ ] **Step 4: Verify package.json is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json'))"` (from project root)
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

Run:
```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add .nvmrc .gitignore package.json
git commit -m "chore: initialize Node toolchain and gitignore"
```

---

### Task 1.2: Install Next.js + TypeScript + base deps

**Files:**
- Modify: `package.json` (dependencies added by pnpm)
- Create: `tsconfig.json`
- Create: `next.config.mjs`
- Create: `next-env.d.ts` (auto-generated by Next.js)

- [ ] **Step 1: Install runtime deps**

Run:
```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm add next@14 react@18 react-dom@18 zod pino
```

Expected: pnpm reports successful install; `node_modules/next` exists.

- [ ] **Step 2: Install dev deps**

Run:
```bash
pnpm add -D typescript @types/node @types/react @types/react-dom \
  eslint eslint-config-next prettier \
  vitest @vitest/coverage-v8 tsx
```

Expected: install succeeds.

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "jsx": "preserve",
    "incremental": true,
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./*"]
    },
    "plugins": [{ "name": "next" }]
  },
  "include": ["**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules", ".next", "out", "coverage", "scripts/yfinance_fetch.py"]
}
```

- [ ] **Step 4: Write `next.config.mjs`**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    typedRoutes: true
  }
};

export default nextConfig;
```

- [ ] **Step 5: Create a minimal `app/page.tsx` so Next.js can compile**

Create: `app/page.tsx`

```tsx
export default function Page() {
  return <main>Equity Research Workbench — scaffold</main>;
}
```

Create: `app/layout.tsx`

```tsx
import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 6: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: no errors, exit 0.

- [ ] **Step 7: Verify Next build succeeds**

Run: `pnpm build`
Expected: build completes, "Compiled successfully" in output.

- [ ] **Step 8: Commit**

Run:
```bash
git add tsconfig.json next.config.mjs next-env.d.ts package.json pnpm-lock.yaml app/
git commit -m "chore: scaffold Next.js 14 + TypeScript strict"
```

---

### Task 1.3: Configure Vitest

**Files:**
- Create: `vitest.config.ts`
- Create: `vitest.integration.config.ts`
- Create: `tests/setup.ts`

- [ ] **Step 1: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'tests/e2e/**', 'node_modules/**'],
    environment: 'node',
    globals: false,
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['**/__fixtures__/**', '**/*.test.ts', 'scripts/**']
    }
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') }
  }
});
```

- [ ] **Step 2: Write `vitest.integration.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globals: false,
    setupFiles: ['tests/setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') }
  }
});
```

Note: integration tests use `singleFork: true` so the local Supabase isn't hammered with parallel writes.

- [ ] **Step 3: Write `tests/setup.ts`**

```ts
import { afterEach, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
```

- [ ] **Step 4: Write a sanity test**

Create: `tests/setup.test.ts`

```ts
import { describe, it, expect } from 'vitest';

describe('setup', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run the sanity test, verify it passes**

Run: `pnpm test`
Expected: `1 passed`, exit 0.

- [ ] **Step 6: Delete the sanity test**

Run: `rm tests/setup.test.ts`

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts vitest.integration.config.ts tests/setup.ts package.json
git commit -m "chore: configure Vitest for unit and integration suites"
```

---

### Task 1.4: Add ESLint + Prettier

**Files:**
- Create: `.eslintrc.json`
- Create: `.prettierrc.json`
- Create: `.prettierignore`

- [ ] **Step 1: Write `.eslintrc.json`**

```json
{
  "extends": ["next/core-web-vitals"],
  "rules": {
    "@next/next/no-html-link-for-pages": "off",
    "react/no-unescaped-entities": "off"
  }
}
```

- [ ] **Step 2: Write `.prettierrc.json`**

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "none",
  "printWidth": 100,
  "arrowParens": "always"
}
```

- [ ] **Step 3: Write `.prettierignore`**

```
.next
node_modules
pnpm-lock.yaml
coverage
supabase/.branches
supabase/.temp
__pycache__
```

- [ ] **Step 4: Verify lint passes**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add .eslintrc.json .prettierrc.json .prettierignore
git commit -m "chore: configure ESLint and Prettier"
```

---

### Task 1.5: Write `lib/env.ts` with zod validation

**Files:**
- Create: `.env.example`
- Create: `.env.local` (gitignored, developer-filled with real values)
- Create: `lib/env.ts`
- Create: `tests/env.test.ts`

- [ ] **Step 1: Write `.env.example`**

```
# Supabase (use values from `supabase status` after `supabase start`)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Financial Datasets API
# Get a free-tier key at https://financialdatasets.ai
FINANCIAL_DATASETS_API_KEY=

# Upstash Redis (free tier)
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Cron handler shared secret
CRON_SECRET=

# Python interpreter used by yfinance adapter (override if not on PATH)
PYTHON_BIN=python
```

- [ ] **Step 2: Write the failing test**

Create: `tests/env.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('env loader', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when a required var is missing', async () => {
    delete process.env.FINANCIAL_DATASETS_API_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
    process.env.UPSTASH_REDIS_REST_URL = 'http://localhost';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    process.env.CRON_SECRET = 'secret';

    const { loadServerEnv } = await import('../lib/env');
    expect(() => loadServerEnv()).toThrowError(/FINANCIAL_DATASETS_API_KEY/);
  });

  it('returns a typed config when all vars present', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
    process.env.FINANCIAL_DATASETS_API_KEY = 'fd';
    process.env.UPSTASH_REDIS_REST_URL = 'http://upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    process.env.CRON_SECRET = 'secret';

    const { loadServerEnv } = await import('../lib/env');
    const env = loadServerEnv();
    expect(env.FINANCIAL_DATASETS_API_KEY).toBe('fd');
    expect(env.PYTHON_BIN).toBe('python'); // default
  });
});
```

- [ ] **Step 3: Run, verify it fails**

Run: `pnpm test tests/env.test.ts`
Expected: FAIL with "Cannot find module '../lib/env'".

- [ ] **Step 4: Write `lib/env.ts`**

```ts
import { z } from 'zod';

const ServerEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  FINANCIAL_DATASETS_API_KEY: z.string().min(1),
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 chars'),
  PYTHON_BIN: z.string().default('python')
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let cached: ServerEnv | null = null;

export function loadServerEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = ServerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: clears the cached env so tests can re-load with mutated process.env. */
export function _resetEnvCache() {
  cached = null;
}
```

- [ ] **Step 5: Update the test to call `_resetEnvCache` between cases**

Modify the test file: add `_resetEnvCache()` call at the top of each `it` block. Final test file:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _resetEnvCache } from '../lib/env';

describe('env loader', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    _resetEnvCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetEnvCache();
  });

  it('throws when a required var is missing', async () => {
    delete process.env.FINANCIAL_DATASETS_API_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
    process.env.UPSTASH_REDIS_REST_URL = 'http://localhost';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    process.env.CRON_SECRET = 'a-secret-at-least-16-chars';

    const { loadServerEnv } = await import('../lib/env');
    expect(() => loadServerEnv()).toThrowError(/FINANCIAL_DATASETS_API_KEY/);
  });

  it('returns a typed config when all vars present', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
    process.env.FINANCIAL_DATASETS_API_KEY = 'fd';
    process.env.UPSTASH_REDIS_REST_URL = 'http://upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    process.env.CRON_SECRET = 'a-secret-at-least-16-chars';

    const { loadServerEnv } = await import('../lib/env');
    const env = loadServerEnv();
    expect(env.FINANCIAL_DATASETS_API_KEY).toBe('fd');
    expect(env.PYTHON_BIN).toBe('python');
  });
});
```

- [ ] **Step 6: Run, verify passes**

Run: `pnpm test tests/env.test.ts`
Expected: 2 passed.

- [ ] **Step 7: Commit**

```bash
git add lib/env.ts tests/env.test.ts .env.example
git commit -m "feat(env): zod-validated server env loader"
```

---

### Task 1.6: Write `lib/logger.ts`

**Files:**
- Create: `lib/logger.ts`

- [ ] **Step 1: Write `lib/logger.ts`**

```ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { app: 'equity-research-workbench' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    }
  }
});

export type Logger = typeof logger;
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/logger.ts
git commit -m "feat(logger): add pino structured logger"
```

---

## Milestone 2: Database Schema + Supabase

Goal: local Supabase running, all tables created via Drizzle migration, RLS policies applied, integration tests verify RLS works.

### Task 2.1: Initialize Supabase local stack

**Files:**
- Create: `supabase/config.toml` (generated by `supabase init`)

- [ ] **Step 1: Install Supabase CLI (if not present)**

Run: `supabase --version`
If "command not found": follow https://supabase.com/docs/guides/cli to install. On Windows: `scoop install supabase`.

- [ ] **Step 2: Initialize Supabase in the project**

Run:
```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
supabase init
```
Expected: creates `supabase/config.toml` and `supabase/.gitignore`.

- [ ] **Step 3: Start the local stack**

Run: `supabase start`
Expected: Docker pulls images, then prints anon/service-role keys and URLs. Takes ~2 min the first time.

- [ ] **Step 4: Copy the printed values into `.env.local`**

Edit `.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<paste from `supabase status`>
SUPABASE_SERVICE_ROLE_KEY=<paste from `supabase status`>
FINANCIAL_DATASETS_API_KEY=<your free-tier key>
UPSTASH_REDIS_REST_URL=<your Upstash URL>
UPSTASH_REDIS_REST_TOKEN=<your Upstash token>
CRON_SECRET=local-dev-cron-secret-1234567890
PYTHON_BIN=python
```

- [ ] **Step 5: Verify Supabase is healthy**

Run: `supabase status`
Expected: all services listed as "running".

- [ ] **Step 6: Commit**

```bash
git add supabase/config.toml supabase/.gitignore
git commit -m "chore: initialize Supabase local stack"
```

---

### Task 2.2: Install Drizzle + Supabase client deps

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install deps**

Run:
```bash
pnpm add drizzle-orm postgres @supabase/supabase-js @supabase/ssr
pnpm add -D drizzle-kit
```

- [ ] **Step 2: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add Drizzle and Supabase client deps"
```

---

### Task 2.3: Write Drizzle schema for `companies`

**Files:**
- Create: `lib/db/schema.ts`
- Create: `drizzle.config.ts`

- [ ] **Step 1: Write `drizzle.config.ts`**

```ts
import type { Config } from 'drizzle-kit';

export default {
  schema: './lib/db/schema.ts',
  out: './supabase/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: 'postgresql://postgres:postgres@localhost:54322/postgres'
  },
  verbose: true,
  strict: true
} satisfies Config;
```

(Port 54322 is Supabase's default local DB port; verify against `supabase status`.)

- [ ] **Step 2: Write `lib/db/schema.ts` — `companies` table only first**

```ts
import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const companies = pgTable('companies', {
  ticker: text('ticker').primaryKey(),
  name: text('name').notNull(),
  cik: text('cik'),
  exchange: text('exchange'),
  sector: text('sector'),
  industry: text('industry'),
  isSeed: boolean('is_seed').notNull().default(false),
  firstIngestedAt: timestamp('first_ingested_at', { withTimezone: true }).notNull().defaultNow(),
  lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
  source: text('source').notNull().default('financial_datasets')
});
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`
Expected: creates `supabase/migrations/0000_<random>.sql` with `CREATE TABLE companies ...`.

- [ ] **Step 4: Inspect the generated SQL**

Open the new file in `supabase/migrations/`. Verify it contains `CREATE TABLE "companies"` and the column definitions match the Drizzle schema.

- [ ] **Step 5: Apply the migration to local Supabase**

Run: `supabase db reset`
Expected: drops local DB, replays all migrations including the one just generated; ends with "Finished supabase db reset".

- [ ] **Step 6: Verify the table exists**

Run: `supabase db dump --schema public | head -50`
Expected: output includes `CREATE TABLE public.companies`.

- [ ] **Step 7: Commit**

```bash
git add drizzle.config.ts lib/db/schema.ts supabase/migrations/
git commit -m "feat(db): add companies table"
```

---

### Task 2.4: Add `snapshots` table to schema

**Files:**
- Modify: `lib/db/schema.ts`

- [ ] **Step 1: Append `snapshots` table to `lib/db/schema.ts`**

Add to the bottom of `lib/db/schema.ts`:

```ts
import { numeric } from 'drizzle-orm/pg-core';

export const snapshots = pgTable('snapshots', {
  ticker: text('ticker')
    .primaryKey()
    .references(() => companies.ticker, { onDelete: 'cascade' }),
  price: numeric('price', { precision: 18, scale: 4 }),
  marketCap: numeric('market_cap', { precision: 20, scale: 2 }),
  week52High: numeric('week52_high', { precision: 18, scale: 4 }),
  week52Low: numeric('week52_low', { precision: 18, scale: 4 }),
  pe: numeric('pe', { precision: 10, scale: 4 }),
  ps: numeric('ps', { precision: 10, scale: 4 }),
  pb: numeric('pb', { precision: 10, scale: 4 }),
  evEbitda: numeric('ev_ebitda', { precision: 10, scale: 4 }),
  peg: numeric('peg', { precision: 10, scale: 4 }),
  asOf: timestamp('as_of', { withTimezone: true }).notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  source: text('source').notNull()
});
```

Reorganize the imports at the top so `numeric` is included in the existing drizzle-orm import.

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: creates a new file in `supabase/migrations/` adding the `snapshots` table.

- [ ] **Step 3: Apply**

Run: `supabase db reset`
Expected: applies both migrations cleanly.

- [ ] **Step 4: Commit**

```bash
git add lib/db/schema.ts supabase/migrations/
git commit -m "feat(db): add snapshots table"
```

---

### Task 2.5: Add `fundamentals`, `prices`, `earnings` tables

**Files:**
- Modify: `lib/db/schema.ts`

- [ ] **Step 1: Append to `lib/db/schema.ts`**

Add the following table definitions and indexes:

```ts
import { date, bigint, primaryKey, index } from 'drizzle-orm/pg-core';

export const fundamentals = pgTable(
  'fundamentals',
  {
    ticker: text('ticker')
      .notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    periodEnd: date('period_end').notNull(),
    periodType: text('period_type').notNull(), // 'annual' | 'quarterly'
    statementType: text('statement_type').notNull(), // 'income' | 'balance' | 'cash_flow'
    lineItem: text('line_item').notNull(),
    value: numeric('value', { precision: 20, scale: 2 }),
    currency: text('currency').notNull().default('USD'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    source: text('source').notNull()
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.ticker, t.periodEnd, t.periodType, t.statementType, t.lineItem]
    }),
    tickerStatementIdx: index('fundamentals_ticker_stmt_idx').on(
      t.ticker,
      t.statementType,
      t.periodType,
      t.periodEnd
    )
  })
);

export const prices = pgTable(
  'prices',
  {
    ticker: text('ticker')
      .notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    open: numeric('open', { precision: 18, scale: 4 }),
    high: numeric('high', { precision: 18, scale: 4 }),
    low: numeric('low', { precision: 18, scale: 4 }),
    close: numeric('close', { precision: 18, scale: 4 }).notNull(),
    adjClose: numeric('adj_close', { precision: 18, scale: 4 }),
    volume: bigint('volume', { mode: 'bigint' }),
    source: text('source').notNull()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticker, t.date] })
  })
);

export const earnings = pgTable(
  'earnings',
  {
    ticker: text('ticker')
      .notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    periodEnd: date('period_end').notNull(),
    reportedDate: date('reported_date'),
    epsActual: numeric('eps_actual', { precision: 10, scale: 4 }),
    price1dPct: numeric('price_1d_pct', { precision: 10, scale: 6 }),
    price5dPct: numeric('price_5d_pct', { precision: 10, scale: 6 }),
    source: text('source').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticker, t.periodEnd] })
  })
);
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new migration file in `supabase/migrations/`.

- [ ] **Step 3: Apply**

Run: `supabase db reset`
Expected: clean apply.

- [ ] **Step 4: Commit**

```bash
git add lib/db/schema.ts supabase/migrations/
git commit -m "feat(db): add fundamentals, prices, earnings tables"
```

---

### Task 2.6: Add `watchlist`, `notes`, `refresh_runs` tables

**Files:**
- Modify: `lib/db/schema.ts`

- [ ] **Step 1: Append to `lib/db/schema.ts`**

```ts
import { uuid, bigserial } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const watchlist = pgTable(
  'watchlist',
  {
    userId: uuid('user_id').notNull(),
    ticker: text('ticker')
      .notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.ticker] }),
    userAddedIdx: index('watchlist_user_added_idx').on(t.userId, t.addedAt)
  })
);

export const notes = pgTable(
  'notes',
  {
    userId: uuid('user_id').notNull(),
    ticker: text('ticker')
      .notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    body: text('body').notNull().default(''),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.ticker] })
  })
);

export const refreshRuns = pgTable(
  'refresh_runs',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    ticker: text('ticker')
      .notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ok: boolean('ok'),
    sourceUsed: text('source_used'),
    error: text('error')
  },
  (t) => ({
    tickerStartedIdx: index('refresh_runs_ticker_started_idx').on(t.ticker, t.startedAt)
  })
);
```

Note: `userId` is `uuid` but **not** declared as a foreign key in the Drizzle schema. Drizzle can't reference `auth.users` cross-schema cleanly; we'll add that FK in a hand-written SQL migration in the next task.

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new migration with watchlist, notes, refresh_runs.

- [ ] **Step 3: Apply**

Run: `supabase db reset`

- [ ] **Step 4: Commit**

```bash
git add lib/db/schema.ts supabase/migrations/
git commit -m "feat(db): add watchlist, notes, refresh_runs tables"
```

---

### Task 2.7: Hand-written migration — auth.users FK + RLS policies

**Files:**
- Create: `supabase/migrations/9999_rls_and_auth_fks.sql`

Drizzle generates table DDL but not RLS policies or cross-schema FKs. Hand-write those in a migration with a high prefix so it runs last.

- [ ] **Step 1: Write `supabase/migrations/9999_rls_and_auth_fks.sql`**

```sql
-- Foreign keys to auth.users
alter table public.watchlist
  add constraint watchlist_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.notes
  add constraint notes_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

-- Enable RLS
alter table public.companies     enable row level security;
alter table public.snapshots     enable row level security;
alter table public.fundamentals  enable row level security;
alter table public.prices        enable row level security;
alter table public.earnings      enable row level security;
alter table public.refresh_runs  enable row level security;
alter table public.watchlist     enable row level security;
alter table public.notes         enable row level security;

-- User-owned: see only your own rows
create policy "own watchlist read"
  on public.watchlist for select using (user_id = auth.uid());
create policy "own watchlist write"
  on public.watchlist for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "own notes read"
  on public.notes for select using (user_id = auth.uid());
create policy "own notes write"
  on public.notes for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Reference data: readable by any authenticated user.
-- Writes go through service role (which bypasses RLS).
create policy "auth read companies"    on public.companies    for select to authenticated using (true);
create policy "auth read snapshots"    on public.snapshots    for select to authenticated using (true);
create policy "auth read fundamentals" on public.fundamentals for select to authenticated using (true);
create policy "auth read prices"       on public.prices       for select to authenticated using (true);
create policy "auth read earnings"     on public.earnings     for select to authenticated using (true);
-- refresh_runs intentionally has no SELECT policy for authenticated; only service-role reads it.
```

- [ ] **Step 2: Apply**

Run: `supabase db reset`
Expected: all migrations apply cleanly.

- [ ] **Step 3: Verify RLS is on**

Run:
```bash
supabase db dump --schema public | grep -A 1 "ALTER TABLE"
```
Expected: see `ENABLE ROW LEVEL SECURITY` for the 8 tables.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/9999_rls_and_auth_fks.sql
git commit -m "feat(db): RLS policies and auth.users foreign keys"
```

---

### Task 2.8: Write `lib/db/client.ts` — Drizzle client factory

**Files:**
- Create: `lib/db/client.ts`
- Create: `lib/db/types.ts`

- [ ] **Step 1: Write `lib/db/client.ts`**

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadServerEnv } from '@/lib/env';
import * as schema from './schema';

/**
 * Service-role Drizzle client. Bypasses RLS — only use in server code (cron, ingestion).
 */
let serviceClient: ReturnType<typeof makeServiceClient> | null = null;

function makeServiceClient() {
  const env = loadServerEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  // Convert Supabase REST URL to direct Postgres URL.
  // Local: http://localhost:54321 → postgres://postgres:postgres@localhost:54322/postgres
  // Cloud: https://<project>.supabase.co → connection string from `SUPABASE_DB_URL` env (added later).
  const dbUrl =
    process.env.SUPABASE_DB_URL ??
    (url.includes('localhost')
      ? 'postgresql://postgres:postgres@localhost:54322/postgres'
      : (() => {
          throw new Error('SUPABASE_DB_URL required for non-local Supabase');
        })());

  const sql = postgres(dbUrl, { prepare: false, max: 5 });
  return drizzle(sql, { schema });
}

export function getServiceDb() {
  if (!serviceClient) serviceClient = makeServiceClient();
  return serviceClient;
}

export type ServiceDb = ReturnType<typeof getServiceDb>;
```

- [ ] **Step 2: Write `lib/db/types.ts`**

```ts
import type {
  companies,
  snapshots,
  fundamentals,
  prices,
  earnings,
  watchlist,
  notes,
  refreshRuns
} from './schema';

export type Company       = typeof companies.$inferSelect;
export type NewCompany    = typeof companies.$inferInsert;
export type Snapshot      = typeof snapshots.$inferSelect;
export type NewSnapshot   = typeof snapshots.$inferInsert;
export type Fundamental   = typeof fundamentals.$inferSelect;
export type NewFundamental= typeof fundamentals.$inferInsert;
export type Price         = typeof prices.$inferSelect;
export type NewPrice      = typeof prices.$inferInsert;
export type Earning       = typeof earnings.$inferSelect;
export type NewEarning    = typeof earnings.$inferInsert;
export type WatchlistRow  = typeof watchlist.$inferSelect;
export type NewWatchlist  = typeof watchlist.$inferInsert;
export type Note          = typeof notes.$inferSelect;
export type NewNote       = typeof notes.$inferInsert;
export type RefreshRun    = typeof refreshRuns.$inferSelect;
export type NewRefreshRun = typeof refreshRuns.$inferInsert;
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/db/client.ts lib/db/types.ts
git commit -m "feat(db): Drizzle client factory and row types"
```

---

### Task 2.9: Write integration test helper `tests/helpers/test-db.ts`

**Files:**
- Create: `tests/helpers/test-db.ts`

- [ ] **Step 1: Write the helper**

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import * as schema from '@/lib/db/schema';

const LOCAL_DB_URL = 'postgresql://postgres:postgres@localhost:54322/postgres';

/** Service-role Drizzle client — bypasses RLS. */
export function makeTestDb() {
  const sql = postgres(LOCAL_DB_URL, { prepare: false, max: 3 });
  return { db: drizzle(sql, { schema }), close: () => sql.end() };
}

/** Supabase admin client — for provisioning test users with valid JWTs. */
export function makeAdminClient() {
  const env = process.env;
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Test setup requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

/** Create a real auth user and return { userId, accessToken }. */
export async function createTestUser(email: string, password = 'Password123!') {
  const admin = makeAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });
  if (error) throw error;
  if (!data.user) throw new Error('createUser returned no user');

  const { data: signIn, error: signInErr } = await admin.auth.signInWithPassword({
    email,
    password
  });
  if (signInErr) throw signInErr;
  if (!signIn.session) throw new Error('signIn returned no session');

  return { userId: data.user.id, accessToken: signIn.session.access_token };
}

/** RLS-aware Supabase client scoped to a single user's JWT. */
export function makeUserClient(accessToken: string) {
  const env = process.env;
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

/** Truncate all app tables; run before each test. */
export async function resetDb(db: ReturnType<typeof drizzle<typeof schema>>) {
  // Order matters because of FKs. Use raw SQL for speed.
  await db.execute(
    /* sql */ `truncate table
      public.refresh_runs,
      public.notes,
      public.watchlist,
      public.earnings,
      public.prices,
      public.fundamentals,
      public.snapshots,
      public.companies
    restart identity cascade`
  );
  // Wipe auth.users too so test-created users don't accumulate.
  const admin = makeAdminClient();
  const { data } = await admin.auth.admin.listUsers();
  for (const u of data.users) {
    await admin.auth.admin.deleteUser(u.id);
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/test-db.ts
git commit -m "test: add integration test DB helper with user provisioning"
```

---

### Task 2.10: Integration test — verify RLS works

**Files:**
- Create: `tests/integration/rls-watchlist.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import {
  makeTestDb,
  createTestUser,
  makeUserClient,
  resetDb
} from '../helpers/test-db';
import { companies, watchlist } from '@/lib/db/schema';

// Load .env.local into process.env for tests.
config({ path: '.env.local' });

describe('RLS: watchlist isolation', () => {
  let dbHandle: ReturnType<typeof makeTestDb>;

  beforeAll(() => {
    dbHandle = makeTestDb();
  });

  afterAll(async () => {
    await dbHandle.close();
  });

  beforeEach(async () => {
    await resetDb(dbHandle.db);
    // Seed one ticker so the FK on watchlist.ticker is satisfied.
    await dbHandle.db.insert(companies).values({
      ticker: 'AAPL',
      name: 'Apple Inc.',
      isSeed: true
    });
  });

  it('user A cannot read user B watchlist rows', async () => {
    const alice = await createTestUser('alice@test.local');
    const bob = await createTestUser('bob@test.local');

    // Service-role insert (bypasses RLS) — give Alice AAPL.
    await dbHandle.db.insert(watchlist).values({ userId: alice.userId, ticker: 'AAPL' });

    // Bob's RLS-scoped client queries the table — should see zero rows.
    const bobClient = makeUserClient(bob.accessToken);
    const { data, error } = await bobClient.from('watchlist').select('*');

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('user A can read their own watchlist rows', async () => {
    const alice = await createTestUser('alice@test.local');

    await dbHandle.db.insert(watchlist).values({ userId: alice.userId, ticker: 'AAPL' });

    const aliceClient = makeUserClient(alice.accessToken);
    const { data, error } = await aliceClient.from('watchlist').select('ticker');

    expect(error).toBeNull();
    expect(data).toEqual([{ ticker: 'AAPL' }]);
  });
});
```

- [ ] **Step 2: Install dotenv (used in tests)**

Run: `pnpm add -D dotenv`

- [ ] **Step 3: Run, verify it passes**

Ensure local Supabase is running (`supabase start`).

Run: `pnpm test:integration tests/integration/rls-watchlist.test.ts`
Expected: 2 passed. If failures: re-check that the RLS migration applied (`supabase db reset` again).

- [ ] **Step 4: Commit**

```bash
git add tests/integration/rls-watchlist.test.ts package.json pnpm-lock.yaml
git commit -m "test(db): verify RLS isolates watchlist rows per user"
```

---

## Milestone 3: Compute Layer (pure functions)

Goal: financial math, fully unit-tested, no I/O. Foundation for snapshot multiples, growth, and returns.

### Task 3.1: `lib/compute/multiples.ts` — P/E, P/S, P/B, EV/EBITDA, PEG

**Files:**
- Create: `lib/compute/multiples.ts`
- Create: `tests/compute/multiples.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import {
  computePE,
  computePS,
  computePB,
  computeEVtoEBITDA,
  computePEG
} from '@/lib/compute/multiples';

describe('multiples', () => {
  describe('P/E', () => {
    it('returns price / EPS when both positive', () => {
      expect(computePE(150, 6)).toBeCloseTo(25);
    });
    it('returns null when EPS is zero', () => {
      expect(computePE(150, 0)).toBeNull();
    });
    it('returns null when EPS is negative', () => {
      // P/E is undefined for negative earnings; never return a negative ratio.
      expect(computePE(150, -2)).toBeNull();
    });
    it('returns null when inputs missing', () => {
      expect(computePE(null, 6)).toBeNull();
      expect(computePE(150, null)).toBeNull();
    });
  });

  describe('P/S', () => {
    it('returns market cap / revenue', () => {
      expect(computePS(1000, 250)).toBeCloseTo(4);
    });
    it('returns null when revenue is zero', () => {
      expect(computePS(1000, 0)).toBeNull();
    });
  });

  describe('P/B', () => {
    it('returns market cap / book value', () => {
      expect(computePB(800, 200)).toBeCloseTo(4);
    });
    it('returns null when book value <= 0', () => {
      expect(computePB(800, 0)).toBeNull();
      expect(computePB(800, -50)).toBeNull();
    });
  });

  describe('EV/EBITDA', () => {
    it('returns EV / EBITDA when both positive', () => {
      expect(computeEVtoEBITDA(1200, 100)).toBeCloseTo(12);
    });
    it('returns null when EBITDA <= 0', () => {
      expect(computeEVtoEBITDA(1200, 0)).toBeNull();
      expect(computeEVtoEBITDA(1200, -50)).toBeNull();
    });
  });

  describe('PEG', () => {
    it('returns P/E divided by growth percentage', () => {
      expect(computePEG(20, 10)).toBeCloseTo(2);
    });
    it('returns null when growth is zero or negative', () => {
      expect(computePEG(20, 0)).toBeNull();
      expect(computePEG(20, -5)).toBeNull();
    });
    it('returns null when P/E is null', () => {
      expect(computePEG(null, 10)).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run, verify fails**

Run: `pnpm test tests/compute/multiples.test.ts`
Expected: FAIL — "Cannot find module '@/lib/compute/multiples'".

- [ ] **Step 3: Write the implementation**

Create `lib/compute/multiples.ts`:

```ts
/** All multiples return null when inputs are missing or undefined. */

type Maybe = number | null | undefined;

function ok(...vals: Maybe[]): vals is number[] {
  return vals.every((v) => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Price-to-Earnings. Returns null when EPS is non-positive (P/E is undefined for losses).
 */
export function computePE(price: Maybe, eps: Maybe): number | null {
  if (!ok(price, eps)) return null;
  if (eps <= 0) return null;
  return price / eps;
}

/** Price-to-Sales. */
export function computePS(marketCap: Maybe, revenue: Maybe): number | null {
  if (!ok(marketCap, revenue)) return null;
  if (revenue <= 0) return null;
  return marketCap / revenue;
}

/** Price-to-Book. Returns null for non-positive book value. */
export function computePB(marketCap: Maybe, bookValue: Maybe): number | null {
  if (!ok(marketCap, bookValue)) return null;
  if (bookValue <= 0) return null;
  return marketCap / bookValue;
}

/** Enterprise Value to EBITDA. */
export function computeEVtoEBITDA(ev: Maybe, ebitda: Maybe): number | null {
  if (!ok(ev, ebitda)) return null;
  if (ebitda <= 0) return null;
  return ev / ebitda;
}

/**
 * PEG ratio = P/E / earnings growth %.
 * `growthPct` is a percentage (e.g. 10 for 10% growth).
 */
export function computePEG(pe: Maybe, growthPct: Maybe): number | null {
  if (!ok(pe, growthPct)) return null;
  if (growthPct <= 0) return null;
  return pe / growthPct;
}
```

- [ ] **Step 4: Run, verify passes**

Run: `pnpm test tests/compute/multiples.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/compute/multiples.ts tests/compute/multiples.test.ts
git commit -m "feat(compute): valuation multiples with null-safe edge cases"
```

---

### Task 3.2: `lib/compute/growth.ts` — YoY and CAGR

**Files:**
- Create: `lib/compute/growth.ts`
- Create: `tests/compute/growth.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { computeYoY, computeCAGR } from '@/lib/compute/growth';

describe('YoY growth', () => {
  it('returns positive pct when value grew', () => {
    expect(computeYoY(110, 100)).toBeCloseTo(0.1);
  });
  it('returns negative pct when value shrank', () => {
    expect(computeYoY(80, 100)).toBeCloseTo(-0.2);
  });
  it('returns null when prior is zero (undefined growth)', () => {
    expect(computeYoY(100, 0)).toBeNull();
  });
  it('handles negative prior by returning null', () => {
    // Sign-flip cases are confusing; refuse to compute.
    expect(computeYoY(100, -50)).toBeNull();
  });
  it('returns null when inputs missing', () => {
    expect(computeYoY(null, 100)).toBeNull();
    expect(computeYoY(100, null)).toBeNull();
  });
});

describe('CAGR', () => {
  it('returns annualized growth over multiple years', () => {
    // 100 → 200 over 5y → ~14.87%
    expect(computeCAGR(200, 100, 5)).toBeCloseTo(0.1487, 3);
  });
  it('returns 0 when start and end equal', () => {
    expect(computeCAGR(100, 100, 5)).toBeCloseTo(0);
  });
  it('returns null when years is zero', () => {
    expect(computeCAGR(200, 100, 0)).toBeNull();
  });
  it('returns null when start is non-positive', () => {
    expect(computeCAGR(200, 0, 5)).toBeNull();
    expect(computeCAGR(200, -10, 5)).toBeNull();
  });
  it('returns null when inputs missing', () => {
    expect(computeCAGR(null, 100, 5)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify fails**

Run: `pnpm test tests/compute/growth.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `lib/compute/growth.ts`:

```ts
type Maybe = number | null | undefined;

function ok(...vals: Maybe[]): vals is number[] {
  return vals.every((v) => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Year-over-year growth as a decimal (0.10 = +10%).
 * Returns null when prior is non-positive — sign-flipping growth is misleading.
 */
export function computeYoY(current: Maybe, prior: Maybe): number | null {
  if (!ok(current, prior)) return null;
  if (prior <= 0) return null;
  return (current - prior) / prior;
}

/**
 * Compound Annual Growth Rate as a decimal.
 *
 * @param end   ending value
 * @param start starting value
 * @param years number of years between start and end
 */
export function computeCAGR(end: Maybe, start: Maybe, years: Maybe): number | null {
  if (!ok(end, start, years)) return null;
  if (start <= 0 || years <= 0) return null;
  return Math.pow(end / start, 1 / years) - 1;
}
```

- [ ] **Step 4: Run, verify passes**

Run: `pnpm test tests/compute/growth.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add lib/compute/growth.ts tests/compute/growth.test.ts
git commit -m "feat(compute): YoY and CAGR with null-safe edge cases"
```

---

### Task 3.3: `lib/compute/returns.ts` — ROE, ROA, ROIC

**Files:**
- Create: `lib/compute/returns.ts`
- Create: `tests/compute/returns.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { computeROE, computeROA, computeROIC } from '@/lib/compute/returns';

describe('ROE', () => {
  it('returns net income / equity', () => {
    expect(computeROE(50, 250)).toBeCloseTo(0.2);
  });
  it('returns null when equity <= 0', () => {
    expect(computeROE(50, 0)).toBeNull();
    expect(computeROE(50, -10)).toBeNull();
  });
});

describe('ROA', () => {
  it('returns net income / total assets', () => {
    expect(computeROA(50, 500)).toBeCloseTo(0.1);
  });
  it('returns null when assets <= 0', () => {
    expect(computeROA(50, 0)).toBeNull();
  });
});

describe('ROIC', () => {
  it('returns NOPAT / invested capital', () => {
    // NOPAT = operating income * (1 - tax rate)
    // operatingIncome=100, taxRate=0.25 → NOPAT = 75; investedCapital=500 → ROIC = 0.15
    expect(computeROIC(100, 0.25, 500)).toBeCloseTo(0.15);
  });
  it('returns null when invested capital <= 0', () => {
    expect(computeROIC(100, 0.25, 0)).toBeNull();
  });
  it('returns null for tax rate outside [0,1]', () => {
    expect(computeROIC(100, -0.1, 500)).toBeNull();
    expect(computeROIC(100, 1.1, 500)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify fails**

Run: `pnpm test tests/compute/returns.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `lib/compute/returns.ts`:

```ts
type Maybe = number | null | undefined;

function ok(...vals: Maybe[]): vals is number[] {
  return vals.every((v) => typeof v === 'number' && Number.isFinite(v));
}

/** Return on Equity. Null when equity is non-positive. */
export function computeROE(netIncome: Maybe, equity: Maybe): number | null {
  if (!ok(netIncome, equity)) return null;
  if (equity <= 0) return null;
  return netIncome / equity;
}

/** Return on Assets. */
export function computeROA(netIncome: Maybe, totalAssets: Maybe): number | null {
  if (!ok(netIncome, totalAssets)) return null;
  if (totalAssets <= 0) return null;
  return netIncome / totalAssets;
}

/**
 * Return on Invested Capital.
 * NOPAT = operatingIncome * (1 - taxRate); ROIC = NOPAT / investedCapital.
 * taxRate must be in [0, 1].
 */
export function computeROIC(
  operatingIncome: Maybe,
  taxRate: Maybe,
  investedCapital: Maybe
): number | null {
  if (!ok(operatingIncome, taxRate, investedCapital)) return null;
  if (taxRate < 0 || taxRate > 1) return null;
  if (investedCapital <= 0) return null;
  const nopat = operatingIncome * (1 - taxRate);
  return nopat / investedCapital;
}
```

- [ ] **Step 4: Run, verify passes**

Run: `pnpm test tests/compute/returns.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add lib/compute/returns.ts tests/compute/returns.test.ts
git commit -m "feat(compute): ROE, ROA, ROIC with input validation"
```

---

## Milestone 4: Provider Layer

Goal: normalized adapters for Financial Datasets API and yfinance (via Python subprocess). Both return the same typed shapes, both have fixture-driven unit tests, both map errors to typed exceptions.

### Task 4.1: Define normalized provider types and error classes

**Files:**
- Create: `lib/providers/types.ts`

- [ ] **Step 1: Write `lib/providers/types.ts`**

```ts
/* Error taxonomy — see spec §"Error handling". */
export class NotFoundError extends Error {
  readonly kind = 'NotFoundError' as const;
}
export class RateLimitError extends Error {
  readonly kind = 'RateLimitError' as const;
}
export class ProviderError extends Error {
  readonly kind = 'ProviderError' as const;
}
export class ValidationError extends Error {
  readonly kind = 'ValidationError' as const;
}
export class UnknownProviderError extends Error {
  readonly kind = 'UnknownProviderError' as const;
}

export type ProviderName = 'financial_datasets' | 'yfinance';

/* Normalized shapes — every provider returns these regardless of wire format. */

export interface SnapshotData {
  ticker: string;
  price: number | null;
  marketCap: number | null;
  week52High: number | null;
  week52Low: number | null;
  pe: number | null;
  ps: number | null;
  pb: number | null;
  evEbitda: number | null;
  peg: number | null;
  asOf: Date;
}

export interface CompanyData {
  ticker: string;
  name: string;
  cik: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
}

export interface PricePoint {
  date: string; // ISO YYYY-MM-DD
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  adjClose: number | null;
  volume: number | null;
}

export type StatementType = 'income' | 'balance' | 'cash_flow';
export type PeriodType    = 'annual' | 'quarterly';

export interface FundamentalRow {
  periodEnd: string; // ISO YYYY-MM-DD
  lineItem: string;
  value: number | null;
  currency: string;
}

export interface StatementBundle {
  ticker: string;
  statementType: StatementType;
  periodType: PeriodType;
  rows: FundamentalRow[];
}

export interface EarningsPoint {
  periodEnd: string;
  reportedDate: string | null;
  epsActual: number | null;
  price1dPct: number | null;
  price5dPct: number | null;
}

export interface Provider {
  name: ProviderName;
  company(ticker: string): Promise<CompanyData>;
  snapshot(ticker: string): Promise<SnapshotData>;
  statements(
    ticker: string,
    statementType: StatementType,
    periodType: PeriodType
  ): Promise<StatementBundle>;
  prices(ticker: string, range: '1Y' | '5Y'): Promise<PricePoint[]>;
  earnings(ticker: string, count: number): Promise<EarningsPoint[]>;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/providers/types.ts
git commit -m "feat(providers): normalized types and error taxonomy"
```

---

### Task 4.2: Record fixtures for Financial Datasets responses

**Files:**
- Create: `lib/providers/__fixtures__/fd-snapshot-aapl.json`
- Create: `lib/providers/__fixtures__/fd-company-aapl.json`
- Create: `lib/providers/__fixtures__/fd-income-aapl-annual.json`
- Create: `lib/providers/__fixtures__/fd-prices-aapl-1y.json`
- Create: `lib/providers/__fixtures__/fd-earnings-aapl.json`
- Create: `lib/providers/__fixtures__/fd-not-found.json`
- Create: `lib/providers/__fixtures__/README.md`

Note: real responses captured once, replayed in tests. The actual format below is documented from Financial Datasets API docs; if the live API differs, capture real responses and replace these.

- [ ] **Step 1: Write `lib/providers/__fixtures__/README.md`**

```md
# Provider fixtures

These JSON files are recorded responses from the Financial Datasets API for the AAPL ticker. They are replayed by `tests/providers/*.test.ts` so unit tests never hit the network.

## Refreshing fixtures

To capture fresh responses against a live key:

```bash
FD_KEY=$FINANCIAL_DATASETS_API_KEY tsx scripts/record-fixtures.ts AAPL
```

(That script is added in a later phase. For now, the fixtures here are hand-authored to match the documented API shape.)

## Provenance

Each fixture has a top-level `_fixture` block with `recorded_at` and `endpoint`. Do not include API keys or PII in fixture files.
```

- [ ] **Step 2: Write `fd-company-aapl.json`**

```json
{
  "_fixture": { "recorded_at": "2026-05-23", "endpoint": "/company/facts?ticker=AAPL" },
  "company_facts": {
    "ticker": "AAPL",
    "name": "Apple Inc.",
    "cik": "0000320193",
    "exchange": "NASDAQ",
    "sector": "Technology",
    "industry": "Consumer Electronics"
  }
}
```

- [ ] **Step 3: Write `fd-snapshot-aapl.json`**

```json
{
  "_fixture": { "recorded_at": "2026-05-23", "endpoint": "/financial-metrics/snapshot?ticker=AAPL" },
  "snapshot": {
    "ticker": "AAPL",
    "market_cap": 3100000000000,
    "price_to_earnings_ratio": 28.5,
    "price_to_sales_ratio": 7.8,
    "price_to_book_ratio": 45.2,
    "enterprise_value_to_ebitda_ratio": 22.1,
    "peg_ratio": 2.4,
    "fifty_two_week_high": 220.5,
    "fifty_two_week_low": 165.0,
    "latest_price": 195.40,
    "as_of": "2026-05-23T20:00:00Z"
  }
}
```

- [ ] **Step 4: Write `fd-income-aapl-annual.json`**

```json
{
  "_fixture": { "recorded_at": "2026-05-23", "endpoint": "/financials/income-statements?ticker=AAPL&period=annual&limit=5" },
  "income_statements": [
    {
      "ticker": "AAPL",
      "period": "annual",
      "report_period": "2024-09-30",
      "currency": "USD",
      "revenue": 383285000000,
      "cost_of_revenue": 214137000000,
      "gross_profit": 169148000000,
      "operating_expense": 54847000000,
      "operating_income": 114301000000,
      "net_income": 99803000000,
      "earnings_per_share": 6.16
    },
    {
      "ticker": "AAPL",
      "period": "annual",
      "report_period": "2023-09-30",
      "currency": "USD",
      "revenue": 394328000000,
      "cost_of_revenue": 223546000000,
      "gross_profit": 170782000000,
      "operating_expense": 54847000000,
      "operating_income": 114935000000,
      "net_income": 96995000000,
      "earnings_per_share": 6.13
    }
  ]
}
```

- [ ] **Step 5: Write `fd-prices-aapl-1y.json`**

```json
{
  "_fixture": { "recorded_at": "2026-05-23", "endpoint": "/prices?ticker=AAPL&interval=day&interval_multiplier=1&start_date=2025-05-23&end_date=2026-05-23" },
  "prices": [
    { "ticker": "AAPL", "time": "2025-05-23", "open": 188.0, "high": 190.5, "low": 187.2, "close": 189.4, "volume": 50000000 },
    { "ticker": "AAPL", "time": "2025-05-26", "open": 189.4, "high": 191.0, "low": 188.8, "close": 190.6, "volume": 48000000 }
  ]
}
```

- [ ] **Step 6: Write `fd-earnings-aapl.json`**

```json
{
  "_fixture": { "recorded_at": "2026-05-23", "endpoint": "/earnings?ticker=AAPL&limit=8" },
  "earnings": [
    { "ticker": "AAPL", "period": "2024-12-31", "reported_date": "2025-01-30", "eps": 2.40 },
    { "ticker": "AAPL", "period": "2024-09-30", "reported_date": "2024-11-01", "eps": 1.64 }
  ]
}
```

- [ ] **Step 7: Write `fd-not-found.json`**

```json
{
  "_fixture": { "recorded_at": "2026-05-23", "endpoint": "/company/facts?ticker=XXXX" },
  "error": "Ticker not found"
}
```

- [ ] **Step 8: Commit**

```bash
git add lib/providers/__fixtures__/
git commit -m "test(providers): add Financial Datasets API fixtures"
```

---

### Task 4.3: Write `lib/providers/financial-datasets.ts` adapter — company + snapshot

**Files:**
- Create: `lib/providers/financial-datasets.ts`
- Create: `tests/providers/financial-datasets.test.ts`
- Create: `tests/helpers/fixtures.ts`

- [ ] **Step 1: Write the fixture loader helper**

Create `tests/helpers/fixtures.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

const FIXTURE_DIR = path.resolve(__dirname, '../../lib/providers/__fixtures__');

export function loadFixture<T = unknown>(name: string): T {
  const file = path.join(FIXTURE_DIR, name);
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}
```

- [ ] **Step 2: Write the failing tests for company + snapshot**

Create `tests/providers/financial-datasets.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { NotFoundError, ProviderError, RateLimitError } from '@/lib/providers/types';
import { loadFixture } from '../helpers/fixtures';

function makeProvider(fetchImpl: typeof fetch) {
  return new FinancialDatasetsProvider({
    apiKey: 'test-key',
    fetch: fetchImpl,
    // Disable retries in tests by default; specific tests opt in.
    retry: { attempts: 1, baseDelayMs: 0 }
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  });
}

describe('FinancialDatasetsProvider', () => {
  describe('.company()', () => {
    it('returns normalized CompanyData for AAPL', async () => {
      const fix = loadFixture('fd-company-aapl.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProvider(fetchMock);

      const result = await provider.company('AAPL');

      expect(result).toEqual({
        ticker: 'AAPL',
        name: 'Apple Inc.',
        cik: '0000320193',
        exchange: 'NASDAQ',
        sector: 'Technology',
        industry: 'Consumer Electronics'
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('throws NotFoundError on 404', async () => {
      const fix = loadFixture('fd-not-found.json');
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(fix), { status: 404 })
      );
      const provider = makeProvider(fetchMock);

      await expect(provider.company('XXXX')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('throws RateLimitError on 429', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response('', { status: 429 })
      );
      const provider = makeProvider(fetchMock);

      await expect(provider.company('AAPL')).rejects.toBeInstanceOf(RateLimitError);
    });

    it('throws ProviderError on 500', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response('', { status: 500 })
      );
      const provider = makeProvider(fetchMock);

      await expect(provider.company('AAPL')).rejects.toBeInstanceOf(ProviderError);
    });
  });

  describe('.snapshot()', () => {
    it('returns normalized SnapshotData with computed multiples passed through', async () => {
      const fix = loadFixture('fd-snapshot-aapl.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProvider(fetchMock);

      const result = await provider.snapshot('AAPL');

      expect(result.ticker).toBe('AAPL');
      expect(result.price).toBe(195.4);
      expect(result.marketCap).toBe(3100000000000);
      expect(result.pe).toBeCloseTo(28.5);
      expect(result.peg).toBeCloseTo(2.4);
      expect(result.asOf).toBeInstanceOf(Date);
    });

    it('passes ticker through as uppercase', async () => {
      const fix = loadFixture('fd-snapshot-aapl.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProvider(fetchMock);

      await provider.snapshot('aapl');

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('ticker=AAPL');
    });
  });
});
```

- [ ] **Step 3: Run, verify fails**

Run: `pnpm test tests/providers/financial-datasets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the adapter (company + snapshot only — statements/prices/earnings in next tasks)**

Create `lib/providers/financial-datasets.ts`:

```ts
import {
  CompanyData,
  EarningsPoint,
  NotFoundError,
  PeriodType,
  PricePoint,
  Provider,
  ProviderError,
  ProviderName,
  RateLimitError,
  SnapshotData,
  StatementBundle,
  StatementType,
  UnknownProviderError,
  ValidationError
} from './types';

interface RetryConfig {
  attempts: number;
  baseDelayMs: number;
}

interface Options {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  retry?: RetryConfig;
}

const DEFAULT_RETRY: RetryConfig = { attempts: 3, baseDelayMs: 250 };

export class FinancialDatasetsProvider implements Provider {
  readonly name: ProviderName = 'financial_datasets';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retry: RetryConfig;

  constructor(opts: Options) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.financialdatasets.ai';
    this.fetchImpl = opts.fetch ?? fetch;
    this.retry = opts.retry ?? DEFAULT_RETRY;
  }

  async company(ticker: string): Promise<CompanyData> {
    const t = ticker.toUpperCase();
    const body = await this.request<{ company_facts: any }>(`/company/facts?ticker=${t}`);
    const c = body.company_facts;
    return {
      ticker: c.ticker,
      name: c.name,
      cik: c.cik ?? null,
      exchange: c.exchange ?? null,
      sector: c.sector ?? null,
      industry: c.industry ?? null
    };
  }

  async snapshot(ticker: string): Promise<SnapshotData> {
    const t = ticker.toUpperCase();
    const body = await this.request<{ snapshot: any }>(
      `/financial-metrics/snapshot?ticker=${t}`
    );
    const s = body.snapshot;
    return {
      ticker: s.ticker,
      price: numOrNull(s.latest_price),
      marketCap: numOrNull(s.market_cap),
      week52High: numOrNull(s.fifty_two_week_high),
      week52Low: numOrNull(s.fifty_two_week_low),
      pe: numOrNull(s.price_to_earnings_ratio),
      ps: numOrNull(s.price_to_sales_ratio),
      pb: numOrNull(s.price_to_book_ratio),
      evEbitda: numOrNull(s.enterprise_value_to_ebitda_ratio),
      peg: numOrNull(s.peg_ratio),
      asOf: new Date(s.as_of)
    };
  }

  // Statements, prices, earnings implemented in subsequent tasks.
  async statements(): Promise<StatementBundle> {
    throw new Error('Not yet implemented');
  }
  async prices(): Promise<PricePoint[]> {
    throw new Error('Not yet implemented');
  }
  async earnings(): Promise<EarningsPoint[]> {
    throw new Error('Not yet implemented');
  }

  // ----- HTTP plumbing -----

  private async request<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          headers: { 'X-API-KEY': this.apiKey, accept: 'application/json' }
        });

        if (res.status === 404) throw new NotFoundError(`Not found: ${path}`);
        if (res.status === 429) throw new RateLimitError(`Rate limited: ${path}`);
        if (res.status === 400 || res.status === 422) {
          throw new ValidationError(`Bad request: ${path} (status ${res.status})`);
        }
        if (res.status >= 500) throw new ProviderError(`Server error ${res.status}: ${path}`);
        if (!res.ok) throw new UnknownProviderError(`Unexpected ${res.status}: ${path}`);

        return (await res.json()) as T;
      } catch (err) {
        lastError = err;
        // Only retry transient errors.
        const transient = err instanceof RateLimitError || err instanceof ProviderError;
        if (!transient || attempt === this.retry.attempts) throw err;
        await sleep(this.retry.baseDelayMs * Math.pow(4, attempt - 1));
      }
    }
    throw lastError;
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 5: Run, verify passes**

Run: `pnpm test tests/providers/financial-datasets.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/providers/financial-datasets.ts tests/providers/financial-datasets.test.ts tests/helpers/fixtures.ts
git commit -m "feat(providers): Financial Datasets adapter for company + snapshot"
```

---

### Task 4.4: Extend FD adapter — `statements()`

**Files:**
- Modify: `lib/providers/financial-datasets.ts`
- Modify: `tests/providers/financial-datasets.test.ts`

- [ ] **Step 1: Add failing tests for statements**

Append to `tests/providers/financial-datasets.test.ts`:

```ts
  describe('.statements()', () => {
    it('returns normalized income statement rows', async () => {
      const fix = loadFixture('fd-income-aapl-annual.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProvider(fetchMock);

      const result = await provider.statements('AAPL', 'income', 'annual');

      expect(result.ticker).toBe('AAPL');
      expect(result.statementType).toBe('income');
      expect(result.periodType).toBe('annual');
      expect(result.rows.length).toBeGreaterThan(0);
      const revenue2024 = result.rows.find(
        (r) => r.lineItem === 'revenue' && r.periodEnd === '2024-09-30'
      );
      expect(revenue2024?.value).toBe(383285000000);
      expect(revenue2024?.currency).toBe('USD');
    });

    it('hits the correct endpoint for balance sheet quarterly', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({ balance_sheets: [] })
      );
      const provider = makeProvider(fetchMock);

      await provider.statements('AAPL', 'balance', 'quarterly');

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('/financials/balance-sheets');
      expect(url).toContain('ticker=AAPL');
      expect(url).toContain('period=quarterly');
    });
  });
```

- [ ] **Step 2: Run, verify the new tests fail**

Run: `pnpm test tests/providers/financial-datasets.test.ts`
Expected: the existing tests still pass; statements tests fail with `'Not yet implemented'`.

- [ ] **Step 3: Implement `statements()` in the adapter**

Replace the placeholder in `lib/providers/financial-datasets.ts`:

```ts
  async statements(
    ticker: string,
    statementType: StatementType,
    periodType: PeriodType
  ): Promise<StatementBundle> {
    const t = ticker.toUpperCase();
    const endpointMap: Record<StatementType, { path: string; arrayKey: string; lineItems: string[] }> = {
      income: {
        path: 'income-statements',
        arrayKey: 'income_statements',
        lineItems: [
          'revenue',
          'cost_of_revenue',
          'gross_profit',
          'operating_expense',
          'operating_income',
          'net_income',
          'earnings_per_share'
        ]
      },
      balance: {
        path: 'balance-sheets',
        arrayKey: 'balance_sheets',
        lineItems: [
          'total_assets',
          'total_liabilities',
          'total_equity',
          'cash_and_equivalents',
          'long_term_debt',
          'short_term_debt'
        ]
      },
      cash_flow: {
        path: 'cash-flow-statements',
        arrayKey: 'cash_flow_statements',
        lineItems: [
          'operating_cash_flow',
          'investing_cash_flow',
          'financing_cash_flow',
          'capital_expenditure',
          'free_cash_flow'
        ]
      }
    };
    const spec = endpointMap[statementType];
    const body = await this.request<Record<string, any[]>>(
      `/financials/${spec.path}?ticker=${t}&period=${periodType}&limit=5`
    );
    const items = body[spec.arrayKey] ?? [];
    const rows = items.flatMap((item: any) =>
      spec.lineItems.map((lineItem) => ({
        periodEnd: item.report_period,
        lineItem,
        value: numOrNull(item[lineItem]),
        currency: item.currency ?? 'USD'
      }))
    );
    return { ticker: t, statementType, periodType, rows };
  }
```

- [ ] **Step 4: Run, verify passes**

Run: `pnpm test tests/providers/financial-datasets.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add lib/providers/financial-datasets.ts tests/providers/financial-datasets.test.ts
git commit -m "feat(providers): FD .statements() — income, balance, cash flow"
```

---

### Task 4.5: Extend FD adapter — `prices()` and `earnings()`

**Files:**
- Modify: `lib/providers/financial-datasets.ts`
- Modify: `tests/providers/financial-datasets.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/providers/financial-datasets.test.ts`:

```ts
  describe('.prices()', () => {
    it('returns normalized daily prices', async () => {
      const fix = loadFixture('fd-prices-aapl-1y.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProvider(fetchMock);

      const result = await provider.prices('AAPL', '1Y');

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        date: '2025-05-23',
        open: 188.0,
        close: 189.4,
        volume: 50000000
      });
    });

    it('requests the right date range for 1Y', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ prices: [] }));
      const provider = makeProvider(fetchMock);

      await provider.prices('AAPL', '1Y');

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('/prices');
      expect(url).toContain('interval=day');
      // Range covers ~365 days.
      const startMatch = url.match(/start_date=(\d{4}-\d{2}-\d{2})/);
      const endMatch = url.match(/end_date=(\d{4}-\d{2}-\d{2})/);
      expect(startMatch).not.toBeNull();
      expect(endMatch).not.toBeNull();
    });
  });

  describe('.earnings()', () => {
    it('returns normalized earnings points', async () => {
      const fix = loadFixture('fd-earnings-aapl.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProvider(fetchMock);

      const result = await provider.earnings('AAPL', 8);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        periodEnd: '2024-12-31',
        reportedDate: '2025-01-30',
        epsActual: 2.4
      });
      // price_1d_pct and price_5d_pct are computed by the service later — provider returns null here.
      expect(result[0].price1dPct).toBeNull();
      expect(result[0].price5dPct).toBeNull();
    });
  });
```

- [ ] **Step 2: Run, verify the new tests fail**

Run: `pnpm test tests/providers/financial-datasets.test.ts`

- [ ] **Step 3: Implement `prices()` and `earnings()`**

Replace placeholders in `lib/providers/financial-datasets.ts`:

```ts
  async prices(ticker: string, range: '1Y' | '5Y'): Promise<PricePoint[]> {
    const t = ticker.toUpperCase();
    const end = new Date();
    const start = new Date();
    start.setFullYear(start.getFullYear() - (range === '1Y' ? 1 : 5));
    const startDate = start.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);

    const body = await this.request<{ prices: any[] }>(
      `/prices?ticker=${t}&interval=day&interval_multiplier=1&start_date=${startDate}&end_date=${endDate}`
    );
    return (body.prices ?? []).map((p) => ({
      date: p.time,
      open: numOrNull(p.open),
      high: numOrNull(p.high),
      low: numOrNull(p.low),
      close: numOrNull(p.close) ?? 0,
      adjClose: numOrNull(p.adj_close),
      volume: numOrNull(p.volume)
    }));
  }

  async earnings(ticker: string, count: number): Promise<EarningsPoint[]> {
    const t = ticker.toUpperCase();
    const body = await this.request<{ earnings: any[] }>(
      `/earnings?ticker=${t}&limit=${count}`
    );
    return (body.earnings ?? []).map((e) => ({
      periodEnd: e.period,
      reportedDate: e.reported_date ?? null,
      epsActual: numOrNull(e.eps),
      price1dPct: null,
      price5dPct: null
    }));
  }
```

- [ ] **Step 4: Run, verify passes**

Run: `pnpm test tests/providers/financial-datasets.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add lib/providers/financial-datasets.ts tests/providers/financial-datasets.test.ts
git commit -m "feat(providers): FD .prices() and .earnings()"
```

---

### Task 4.6: Test the retry/backoff path

**Files:**
- Modify: `tests/providers/financial-datasets.test.ts`

- [ ] **Step 1: Add retry tests**

Append:

```ts
  describe('retry behavior', () => {
    it('retries on RateLimitError and succeeds on second attempt', async () => {
      vi.useFakeTimers();
      const fix = loadFixture('fd-company-aapl.json');
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 429 }))
        .mockResolvedValueOnce(jsonResponse(fix));
      const provider = new FinancialDatasetsProvider({
        apiKey: 'k',
        fetch: fetchMock,
        retry: { attempts: 3, baseDelayMs: 100 }
      });

      const promise = provider.company('AAPL');
      // Advance through the backoff
      await vi.advanceTimersByTimeAsync(150);
      const result = await promise;
      expect(result.ticker).toBe('AAPL');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry on NotFoundError', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
      const provider = new FinancialDatasetsProvider({
        apiKey: 'k',
        fetch: fetchMock,
        retry: { attempts: 3, baseDelayMs: 1 }
      });

      await expect(provider.company('XXXX')).rejects.toBeInstanceOf(NotFoundError);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('gives up after configured attempts', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
      const provider = new FinancialDatasetsProvider({
        apiKey: 'k',
        fetch: fetchMock,
        retry: { attempts: 2, baseDelayMs: 10 }
      });

      const promise = provider.company('AAPL').catch((e) => e);
      await vi.advanceTimersByTimeAsync(100);
      const err = await promise;
      expect(err).toBeInstanceOf(ProviderError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
```

- [ ] **Step 2: Run, verify passes**

Run: `pnpm test tests/providers/financial-datasets.test.ts`
Expected: all passing (the retry implementation in Task 4.3 already supports this).

- [ ] **Step 3: Commit**

```bash
git add tests/providers/financial-datasets.test.ts
git commit -m "test(providers): retry/backoff behavior for FD adapter"
```

---

### Task 4.7: yfinance Python script

**Files:**
- Create: `scripts/yfinance_fetch.py`
- Create: `scripts/requirements.txt`

- [ ] **Step 1: Write `scripts/requirements.txt`**

```
yfinance>=0.2.40
```

- [ ] **Step 2: Install yfinance**

Run:
```bash
pip install -r scripts/requirements.txt
```
(If using a venv: `python -m venv .venv && source .venv/Scripts/activate && pip install -r scripts/requirements.txt`)

- [ ] **Step 3: Write `scripts/yfinance_fetch.py`**

```python
#!/usr/bin/env python3
"""
yfinance fallback fetcher. Invoked by lib/providers/yfinance.ts.

Usage: python yfinance_fetch.py <ticker> <kind>
  kind: company | snapshot | prices_1y | prices_5y | earnings

Output: a single JSON object on stdout. Exit code 0 on success, 1 on failure
(with `{ "error": "...", "kind": "<NotFound|Provider|Validation|Unknown>" }`).
"""
import json
import sys
from datetime import datetime, timedelta

try:
    import yfinance as yf
except ImportError as e:
    print(json.dumps({"error": f"yfinance not installed: {e}", "kind": "Provider"}))
    sys.exit(1)


def fail(msg: str, kind: str = "Unknown"):
    print(json.dumps({"error": msg, "kind": kind}))
    sys.exit(1)


def num_or_none(v):
    try:
        f = float(v)
        if f != f or f in (float("inf"), float("-inf")):
            return None
        return f
    except (TypeError, ValueError):
        return None


def fetch_company(ticker: str) -> dict:
    t = yf.Ticker(ticker)
    info = t.info
    if not info or not info.get("symbol"):
        fail(f"Ticker not found: {ticker}", "NotFound")
    return {
        "ticker": ticker,
        "name": info.get("longName") or info.get("shortName") or ticker,
        "cik": None,
        "exchange": info.get("exchange"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
    }


def fetch_snapshot(ticker: str) -> dict:
    t = yf.Ticker(ticker)
    info = t.info
    if not info or not info.get("symbol"):
        fail(f"Ticker not found: {ticker}", "NotFound")

    pe = num_or_none(info.get("trailingPE"))
    return {
        "ticker": ticker,
        "price": num_or_none(info.get("currentPrice") or info.get("regularMarketPrice")),
        "marketCap": num_or_none(info.get("marketCap")),
        "week52High": num_or_none(info.get("fiftyTwoWeekHigh")),
        "week52Low": num_or_none(info.get("fiftyTwoWeekLow")),
        "pe": pe if (pe is None or pe > 0) else None,
        "ps": num_or_none(info.get("priceToSalesTrailing12Months")),
        "pb": num_or_none(info.get("priceToBook")),
        "evEbitda": num_or_none(info.get("enterpriseToEbitda")),
        "peg": num_or_none(info.get("pegRatio")),
        "asOf": datetime.utcnow().isoformat() + "Z",
    }


def fetch_prices(ticker: str, years: int) -> dict:
    t = yf.Ticker(ticker)
    end = datetime.utcnow().date()
    start = end - timedelta(days=365 * years)
    hist = t.history(start=start.isoformat(), end=end.isoformat(), interval="1d")
    if hist is None or hist.empty:
        return {"prices": []}
    rows = []
    for date, row in hist.iterrows():
        rows.append({
            "date": date.strftime("%Y-%m-%d"),
            "open": num_or_none(row.get("Open")),
            "high": num_or_none(row.get("High")),
            "low": num_or_none(row.get("Low")),
            "close": num_or_none(row.get("Close")) or 0,
            "adjClose": num_or_none(row.get("Close")),  # yfinance returns adjusted close by default
            "volume": int(row.get("Volume")) if row.get("Volume") else None,
        })
    return {"prices": rows}


def fetch_earnings(ticker: str) -> dict:
    t = yf.Ticker(ticker)
    df = t.earnings_history
    if df is None or df.empty:
        return {"earnings": []}
    out = []
    for _, row in df.iterrows():
        out.append({
            "periodEnd": str(row.get("quarter", ""))[:10] or None,
            "reportedDate": None,
            "epsActual": num_or_none(row.get("epsActual")),
            "price1dPct": None,
            "price5dPct": None,
        })
    return {"earnings": out}


def main():
    if len(sys.argv) < 3:
        fail("Usage: yfinance_fetch.py <ticker> <kind>", "Validation")
    ticker = sys.argv[1].upper()
    kind = sys.argv[2]

    try:
        if kind == "company":
            print(json.dumps(fetch_company(ticker)))
        elif kind == "snapshot":
            print(json.dumps(fetch_snapshot(ticker)))
        elif kind == "prices_1y":
            print(json.dumps(fetch_prices(ticker, 1)))
        elif kind == "prices_5y":
            print(json.dumps(fetch_prices(ticker, 5)))
        elif kind == "earnings":
            print(json.dumps(fetch_earnings(ticker)))
        else:
            fail(f"Unknown kind: {kind}", "Validation")
    except SystemExit:
        raise
    except Exception as e:
        fail(f"{type(e).__name__}: {e}", "Provider")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Smoke-test the script**

Run: `python scripts/yfinance_fetch.py AAPL company`
Expected: JSON object printed with `"ticker": "AAPL"` and name. Exit 0.

Run: `python scripts/yfinance_fetch.py XXXXFAKE company`
Expected: JSON `{"error": ..., "kind": "NotFound"}` printed. Exit 1.

- [ ] **Step 5: Commit**

```bash
git add scripts/yfinance_fetch.py scripts/requirements.txt
git commit -m "feat(providers): Python yfinance fetcher script"
```

---

### Task 4.8: TS adapter that spawns the Python script

**Files:**
- Create: `lib/providers/yfinance.ts`
- Create: `tests/providers/yfinance.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/providers/yfinance.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { NotFoundError, ProviderError, ValidationError } from '@/lib/providers/types';

/**
 * The adapter is tested by mocking child_process.spawn.
 * We don't run real Python in unit tests.
 */
function makeProvider(spawnImpl: any) {
  return new YFinanceProvider({
    pythonBin: 'python',
    scriptPath: '/fake/yfinance_fetch.py',
    spawn: spawnImpl
  });
}

function fakeSpawn(stdout: string, exitCode: number) {
  return () => {
    const listeners: Record<string, ((arg?: any) => void)[]> = { close: [], error: [] };
    const proc = {
      stdout: {
        on: (ev: string, cb: (data: Buffer) => void) => {
          if (ev === 'data') cb(Buffer.from(stdout));
        }
      },
      stderr: { on: () => {} },
      on: (ev: string, cb: (arg?: any) => void) => {
        if (!listeners[ev]) listeners[ev] = [];
        listeners[ev].push(cb);
      }
    };
    setTimeout(() => listeners.close?.forEach((cb) => cb(exitCode)), 0);
    return proc;
  };
}

describe('YFinanceProvider', () => {
  it('parses company JSON from stdout', async () => {
    const stdout = JSON.stringify({
      ticker: 'AAPL',
      name: 'Apple Inc.',
      cik: null,
      exchange: 'NMS',
      sector: 'Technology',
      industry: 'Consumer Electronics'
    });
    const provider = makeProvider(fakeSpawn(stdout, 0));

    const result = await provider.company('AAPL');
    expect(result.ticker).toBe('AAPL');
    expect(result.sector).toBe('Technology');
  });

  it('throws NotFoundError when script exits 1 with kind=NotFound', async () => {
    const stdout = JSON.stringify({ error: 'Ticker not found: XXXX', kind: 'NotFound' });
    const provider = makeProvider(fakeSpawn(stdout, 1));

    await expect(provider.company('XXXX')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ProviderError when script exits 1 with kind=Provider', async () => {
    const stdout = JSON.stringify({ error: 'Network error', kind: 'Provider' });
    const provider = makeProvider(fakeSpawn(stdout, 1));

    await expect(provider.company('AAPL')).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws ValidationError when script exits 1 with kind=Validation', async () => {
    const stdout = JSON.stringify({ error: 'Bad kind', kind: 'Validation' });
    const provider = makeProvider(fakeSpawn(stdout, 1));

    await expect(provider.company('AAPL')).rejects.toBeInstanceOf(ValidationError);
  });
});
```

- [ ] **Step 2: Run, verify fails**

Run: `pnpm test tests/providers/yfinance.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the adapter**

Create `lib/providers/yfinance.ts`:

```ts
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import {
  CompanyData,
  EarningsPoint,
  NotFoundError,
  PeriodType,
  PricePoint,
  Provider,
  ProviderError,
  ProviderName,
  RateLimitError,
  SnapshotData,
  StatementBundle,
  StatementType,
  UnknownProviderError,
  ValidationError
} from './types';

interface Options {
  pythonBin?: string;
  scriptPath?: string;
  spawn?: typeof nodeSpawn;
  timeoutMs?: number;
}

type Kind = 'company' | 'snapshot' | 'prices_1y' | 'prices_5y' | 'earnings';

const DEFAULT_SCRIPT = path.resolve(process.cwd(), 'scripts/yfinance_fetch.py');

export class YFinanceProvider implements Provider {
  readonly name: ProviderName = 'yfinance';
  private readonly pythonBin: string;
  private readonly scriptPath: string;
  private readonly spawnImpl: typeof nodeSpawn;
  private readonly timeoutMs: number;

  constructor(opts: Options = {}) {
    this.pythonBin = opts.pythonBin ?? process.env.PYTHON_BIN ?? 'python';
    this.scriptPath = opts.scriptPath ?? DEFAULT_SCRIPT;
    this.spawnImpl = opts.spawn ?? nodeSpawn;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async company(ticker: string): Promise<CompanyData> {
    const out = await this.run(ticker, 'company');
    return out as CompanyData;
  }

  async snapshot(ticker: string): Promise<SnapshotData> {
    const out = await this.run(ticker, 'snapshot');
    return { ...out, asOf: new Date(out.asOf) } as SnapshotData;
  }

  async prices(ticker: string, range: '1Y' | '5Y'): Promise<PricePoint[]> {
    const kind: Kind = range === '1Y' ? 'prices_1y' : 'prices_5y';
    const out = await this.run(ticker, kind);
    return (out.prices ?? []) as PricePoint[];
  }

  async earnings(ticker: string, _count: number): Promise<EarningsPoint[]> {
    const out = await this.run(ticker, 'earnings');
    return (out.earnings ?? []) as EarningsPoint[];
  }

  /** yfinance can't reliably reconstruct full statements; statements stay FD-only. */
  async statements(
    _ticker: string,
    _type: StatementType,
    _period: PeriodType
  ): Promise<StatementBundle> {
    throw new ProviderError('yfinance does not provide structured statements; use FD');
  }

  // ----- Subprocess plumbing -----

  private run(ticker: string, kind: Kind): Promise<any> {
    return new Promise((resolve, reject) => {
      const proc = this.spawnImpl(
        this.pythonBin,
        [this.scriptPath, ticker.toUpperCase(), kind],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill?.('SIGKILL');
        reject(new ProviderError(`yfinance script timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      proc.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(new ProviderError(`Failed to spawn Python: ${err.message}`));
      });

      proc.on('close', (code: number) => {
        clearTimeout(timer);
        let body: any;
        try {
          body = JSON.parse(stdout);
        } catch {
          return reject(
            new UnknownProviderError(
              `yfinance script returned non-JSON. exit=${code} stderr=${stderr}`
            )
          );
        }
        if (code === 0) {
          resolve(body);
        } else {
          reject(toTypedError(body));
        }
      });
    });
  }
}

function toTypedError(body: { error?: string; kind?: string }): Error {
  const msg = body.error ?? 'Unknown yfinance error';
  switch (body.kind) {
    case 'NotFound':
      return new NotFoundError(msg);
    case 'Validation':
      return new ValidationError(msg);
    case 'Provider':
      return new ProviderError(msg);
    case 'RateLimit':
      return new RateLimitError(msg);
    default:
      return new UnknownProviderError(msg);
  }
}
```

- [ ] **Step 4: Run, verify passes**

Run: `pnpm test tests/providers/yfinance.test.ts`
Expected: all 4 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/providers/yfinance.ts tests/providers/yfinance.test.ts
git commit -m "feat(providers): TS yfinance adapter via child_process"
```

---

## Milestone 5: Cache Layer

Goal: read-through cache helpers for Redis (hot) and Postgres (cold/durable), with TTL semantics.

### Task 5.1: Install Upstash client and write `lib/cache/ttls.ts`

**Files:**
- Modify: `package.json`
- Create: `lib/cache/ttls.ts`

- [ ] **Step 1: Install Upstash REST client**

Run: `pnpm add @upstash/redis`

- [ ] **Step 2: Write `lib/cache/ttls.ts`**

```ts
/**
 * Cache TTLs in seconds. Centralized so call sites stay readable
 * and so we can adjust without grepping.
 */
export const TTL = {
  snapshotInMarket: 60 * 60,           // 1h
  snapshotOffMarket: 24 * 60 * 60,     // 24h
  financialsAnnual: 24 * 60 * 60,
  financialsQuarterly: 24 * 60 * 60,
  prices1Y: 60 * 60,
  prices5Y: 24 * 60 * 60,
  earnings: 24 * 60 * 60,
  watchlist: 5 * 60                    // 5m
} as const;

/**
 * US equity market hours (ET): Mon–Fri 9:30–16:00.
 * Returns true when the current time falls in that window (UTC-based check).
 * Used to pick snapshot TTL.
 */
export function isUSMarketOpen(now: Date = new Date()): boolean {
  // ET is UTC-5 (EST) or UTC-4 (EDT). Use simple approximation: convert to ET.
  const utcDay = now.getUTCDay();
  if (utcDay === 0 || utcDay === 6) return false; // Sun/Sat
  // Use Intl to get ET hour/minute reliably across DST.
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short'
  }).formatToParts(now);
  const get = (t: string) => et.find((p) => p.type === t)?.value ?? '';
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const hh = parseInt(get('hour'), 10);
  const mm = parseInt(get('minute'), 10);
  const minutes = hh * 60 + mm;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`

- [ ] **Step 4: Commit**

```bash
git add lib/cache/ttls.ts package.json pnpm-lock.yaml
git commit -m "feat(cache): TTL constants and US market-hours helper"
```

---

### Task 5.2: `lib/cache/redis.ts` — typed get/set with JSON

**Files:**
- Create: `lib/cache/redis.ts`
- Create: `tests/cache/redis.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { RedisCache } from '@/lib/cache/redis';

function makeFakeClient(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const ttls = new Map<string, number>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, opts?: { ex?: number }) => {
      store.set(key, value);
      if (opts?.ex) ttls.set(key, opts.ex);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    }),
    _store: store,
    _ttls: ttls
  };
}

describe('RedisCache', () => {
  it('returns null when key missing', async () => {
    const client = makeFakeClient();
    const cache = new RedisCache(client as any);
    expect(await cache.get<{ x: number }>('missing')).toBeNull();
  });

  it('round-trips JSON values', async () => {
    const client = makeFakeClient();
    const cache = new RedisCache(client as any);
    await cache.set('k', { x: 1, y: 'two' }, 60);
    expect(await cache.get<{ x: number; y: string }>('k')).toEqual({ x: 1, y: 'two' });
    expect(client._ttls.get('k')).toBe(60);
  });

  it('returns null for malformed JSON', async () => {
    const client = makeFakeClient({ bad: 'not-json' });
    const cache = new RedisCache(client as any);
    expect(await cache.get('bad')).toBeNull();
  });

  it('del removes the key', async () => {
    const client = makeFakeClient({ k: '"v"' });
    const cache = new RedisCache(client as any);
    await cache.del('k');
    expect(client._store.has('k')).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify fails**

Run: `pnpm test tests/cache/redis.test.ts`

- [ ] **Step 3: Write `lib/cache/redis.ts`**

```ts
import { Redis } from '@upstash/redis';
import { loadServerEnv } from '@/lib/env';

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ex?: number }): Promise<string | null>;
  del(key: string): Promise<number>;
}

export class RedisCache {
  constructor(private readonly client: RedisLike) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw == null) return null;
    try {
      // Upstash auto-parses JSON in some configs; handle both.
      return typeof raw === 'string' ? (JSON.parse(raw) as T) : (raw as T);
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), { ex: ttlSeconds });
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}

let singleton: RedisCache | null = null;

export function getRedisCache(): RedisCache {
  if (singleton) return singleton;
  const env = loadServerEnv();
  const client = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN
  });
  singleton = new RedisCache(client as unknown as RedisLike);
  return singleton;
}
```

- [ ] **Step 4: Run, verify passes**

Run: `pnpm test tests/cache/redis.test.ts`
Expected: all 4 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/cache/redis.ts tests/cache/redis.test.ts
git commit -m "feat(cache): JSON-typed Redis cache wrapper"
```

---

### Task 5.3: `lib/cache/postgres.ts` — freshness helpers

**Files:**
- Create: `lib/cache/postgres.ts`
- Create: `tests/integration/cache-postgres.test.ts`

The Postgres cache layer is thin: it knows how to ask "is the row in table X for ticker Y fresher than TTL Z seconds?" and how to perform an upsert. Service code uses it via the named exports.

- [ ] **Step 1: Write the integration test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestDb, resetDb } from '../helpers/test-db';
import { companies, snapshots } from '@/lib/db/schema';
import { isFresh, upsertSnapshot } from '@/lib/cache/postgres';

config({ path: '.env.local' });

describe('cache/postgres', () => {
  let dbH: ReturnType<typeof makeTestDb>;

  beforeAll(() => { dbH = makeTestDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
  });

  it('upsertSnapshot inserts then updates', async () => {
    await upsertSnapshot(dbH.db, {
      ticker: 'AAPL',
      price: '195.40',
      marketCap: '3100000000000',
      week52High: '220.50',
      week52Low: '165.00',
      pe: '28.50',
      ps: '7.80',
      pb: '45.20',
      evEbitda: '22.10',
      peg: '2.40',
      asOf: new Date(),
      source: 'financial_datasets'
    });

    // Update — change price.
    await upsertSnapshot(dbH.db, {
      ticker: 'AAPL',
      price: '200.00',
      marketCap: '3100000000000',
      week52High: '220.50',
      week52Low: '165.00',
      pe: '29.00',
      ps: '7.80',
      pb: '45.20',
      evEbitda: '22.10',
      peg: '2.40',
      asOf: new Date(),
      source: 'financial_datasets'
    });

    const rows = await dbH.db.select().from(snapshots);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.price).toBe('200.0000');
  });

  it('isFresh returns true when row written within TTL', async () => {
    await upsertSnapshot(dbH.db, {
      ticker: 'AAPL',
      price: null, marketCap: null, week52High: null, week52Low: null,
      pe: null, ps: null, pb: null, evEbitda: null, peg: null,
      asOf: new Date(),
      source: 'financial_datasets'
    });

    const fresh = await isFresh(dbH.db, 'snapshots', 'AAPL', 3600);
    expect(fresh).toBe(true);
  });

  it('isFresh returns false when row older than TTL', async () => {
    // Manually insert with old fetched_at via raw SQL.
    await dbH.db.execute(/* sql */`
      insert into snapshots (ticker, as_of, fetched_at, source)
      values ('AAPL', now() - interval '2 hours', now() - interval '2 hours', 'financial_datasets')
    `);

    const fresh = await isFresh(dbH.db, 'snapshots', 'AAPL', 3600);
    expect(fresh).toBe(false);
  });

  it('isFresh returns false when row missing', async () => {
    const fresh = await isFresh(dbH.db, 'snapshots', 'AAPL', 3600);
    expect(fresh).toBe(false);
  });
});
```

- [ ] **Step 2: Write `lib/cache/postgres.ts`**

```ts
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type { NewSnapshot } from '@/lib/db/types';

type CacheableTable = 'snapshots' | 'fundamentals' | 'prices' | 'earnings';

const FRESH_COLUMN: Record<CacheableTable, string> = {
  snapshots: 'fetched_at',
  fundamentals: 'fetched_at',
  prices: 'date',
  earnings: 'fetched_at'
};

/**
 * Returns true iff at least one row exists for `ticker` in `table` with the
 * freshness column more recent than `now() - ttlSeconds`.
 *
 * `prices.date` is a date, not a timestamp, so we coerce to end-of-day for the
 * comparison so a same-day price counts as fresh until the next day's row lands.
 */
export async function isFresh(
  db: ServiceDb,
  table: CacheableTable,
  ticker: string,
  ttlSeconds: number
): Promise<boolean> {
  const col = FRESH_COLUMN[table];
  const freshExpr =
    table === 'prices'
      ? sql`(${sql.identifier(col)}::timestamp + interval '1 day')`
      : sql`${sql.identifier(col)}`;
  const result = await db.execute(
    sql`select 1 from ${sql.identifier(table)}
        where ticker = ${ticker}
        and ${freshExpr} > now() - (${String(ttlSeconds)} || ' seconds')::interval
        limit 1`
  );
  return result.length > 0;
}

/**
 * Upsert a snapshot row. Drizzle's onConflictDoUpdate keeps the schema typed.
 */
export async function upsertSnapshot(db: ServiceDb, row: NewSnapshot): Promise<void> {
  await db
    .insert(schema.snapshots)
    .values(row)
    .onConflictDoUpdate({
      target: schema.snapshots.ticker,
      set: {
        price: row.price,
        marketCap: row.marketCap,
        week52High: row.week52High,
        week52Low: row.week52Low,
        pe: row.pe,
        ps: row.ps,
        pb: row.pb,
        evEbitda: row.evEbitda,
        peg: row.peg,
        asOf: row.asOf,
        fetchedAt: sql`now()`,
        source: row.source
      }
    });
}
```

- [ ] **Step 3: Run integration test, verify passes**

Ensure local Supabase is running.

Run: `pnpm test:integration tests/integration/cache-postgres.test.ts`
Expected: all 4 passing.

- [ ] **Step 4: Commit**

```bash
git add lib/cache/postgres.ts tests/integration/cache-postgres.test.ts
git commit -m "feat(cache): postgres freshness helpers + snapshot upsert"
```

---

### Task 5.4: Add `fundamentals`, `prices`, `earnings` upsert helpers

**Files:**
- Modify: `lib/cache/postgres.ts`
- Create: `tests/integration/cache-postgres-bulk.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestDb, resetDb } from '../helpers/test-db';
import { companies, fundamentals, prices, earnings } from '@/lib/db/schema';
import {
  upsertFundamentals,
  upsertPrices,
  upsertEarnings
} from '@/lib/cache/postgres';

config({ path: '.env.local' });

describe('cache/postgres bulk upserts', () => {
  let dbH: ReturnType<typeof makeTestDb>;
  beforeAll(() => { dbH = makeTestDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
  });

  it('upsertFundamentals replaces by composite PK', async () => {
    const rows = [
      { ticker: 'AAPL', periodEnd: '2024-09-30', periodType: 'annual', statementType: 'income', lineItem: 'revenue', value: '383285000000', currency: 'USD', source: 'financial_datasets' },
      { ticker: 'AAPL', periodEnd: '2024-09-30', periodType: 'annual', statementType: 'income', lineItem: 'net_income', value: '99803000000', currency: 'USD', source: 'financial_datasets' }
    ];
    await upsertFundamentals(dbH.db, rows as any);

    // Re-insert with updated revenue.
    await upsertFundamentals(dbH.db, [
      { ...rows[0]!, value: '999999999999' }
    ] as any);

    const all = await dbH.db.select().from(fundamentals);
    expect(all).toHaveLength(2);
    const rev = all.find((r) => r.lineItem === 'revenue')!;
    expect(rev.value).toBe('999999999999.00');
  });

  it('upsertPrices inserts daily rows', async () => {
    await upsertPrices(dbH.db, [
      { ticker: 'AAPL', date: '2025-05-23', close: '189.40', volume: BigInt(50000000), source: 'financial_datasets', open: '188.00', high: '190.50', low: '187.20', adjClose: '189.40' }
    ] as any);

    const rows = await dbH.db.select().from(prices);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.close).toBe('189.4000');
  });

  it('upsertEarnings replaces by composite PK', async () => {
    await upsertEarnings(dbH.db, [
      { ticker: 'AAPL', periodEnd: '2024-12-31', reportedDate: '2025-01-30', epsActual: '2.40', source: 'financial_datasets' }
    ] as any);

    await upsertEarnings(dbH.db, [
      { ticker: 'AAPL', periodEnd: '2024-12-31', reportedDate: '2025-01-30', epsActual: '2.50', source: 'yfinance' }
    ] as any);

    const rows = await dbH.db.select().from(earnings);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.epsActual).toBe('2.5000');
    expect(rows[0]!.source).toBe('yfinance');
  });
});
```

- [ ] **Step 2: Append to `lib/cache/postgres.ts`**

```ts
import type { NewFundamental, NewPrice, NewEarning } from '@/lib/db/types';

export async function upsertFundamentals(
  db: ServiceDb,
  rows: NewFundamental[]
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(schema.fundamentals)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        schema.fundamentals.ticker,
        schema.fundamentals.periodEnd,
        schema.fundamentals.periodType,
        schema.fundamentals.statementType,
        schema.fundamentals.lineItem
      ],
      set: {
        value: sql`excluded.value`,
        currency: sql`excluded.currency`,
        fetchedAt: sql`now()`,
        source: sql`excluded.source`
      }
    });
}

export async function upsertPrices(db: ServiceDb, rows: NewPrice[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(schema.prices)
    .values(rows)
    .onConflictDoUpdate({
      target: [schema.prices.ticker, schema.prices.date],
      set: {
        open: sql`excluded.open`,
        high: sql`excluded.high`,
        low: sql`excluded.low`,
        close: sql`excluded.close`,
        adjClose: sql`excluded.adj_close`,
        volume: sql`excluded.volume`,
        source: sql`excluded.source`
      }
    });
}

export async function upsertEarnings(db: ServiceDb, rows: NewEarning[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(schema.earnings)
    .values(rows)
    .onConflictDoUpdate({
      target: [schema.earnings.ticker, schema.earnings.periodEnd],
      set: {
        reportedDate: sql`excluded.reported_date`,
        epsActual: sql`excluded.eps_actual`,
        price1dPct: sql`excluded.price_1d_pct`,
        price5dPct: sql`excluded.price_5d_pct`,
        source: sql`excluded.source`,
        fetchedAt: sql`now()`
      }
    });
}
```

- [ ] **Step 3: Run, verify passes**

Run: `pnpm test:integration tests/integration/cache-postgres-bulk.test.ts`
Expected: all 3 passing.

- [ ] **Step 4: Commit**

```bash
git add lib/cache/postgres.ts tests/integration/cache-postgres-bulk.test.ts
git commit -m "feat(cache): bulk upserts for fundamentals, prices, earnings"
```

---

## Milestone 6: Service Layer

Goal: cache-aware business logic. Each service exposes `get` (cache-aware read) and `refresh` (forced fetch + persist).

### Task 6.1: `lib/services/snapshot.ts` — get + refresh with fallback

**Files:**
- Create: `lib/services/snapshot.ts`
- Create: `tests/integration/services-snapshot.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestDb, resetDb } from '../helpers/test-db';
import { companies, snapshots } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { SnapshotService } from '@/lib/services/snapshot';
import { RateLimitError, NotFoundError, SnapshotData } from '@/lib/providers/types';

config({ path: '.env.local' });

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
    del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
    _store: store
  };
}

function aaplSnapshot(): SnapshotData {
  return {
    ticker: 'AAPL',
    price: 195.4, marketCap: 3.1e12, week52High: 220.5, week52Low: 165,
    pe: 28.5, ps: 7.8, pb: 45.2, evEbitda: 22.1, peg: 2.4,
    asOf: new Date('2026-05-23T20:00:00Z')
  };
}

describe('SnapshotService', () => {
  let dbH: ReturnType<typeof makeTestDb>;
  beforeAll(() => { dbH = makeTestDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
  });

  it('refresh: writes to Redis and Postgres, returns data', async () => {
    const fd = { name: 'financial_datasets', snapshot: vi.fn().mockResolvedValue(aaplSnapshot()) };
    const yf = { name: 'yfinance', snapshot: vi.fn() };
    const redis = fakeRedis();
    const svc = new SnapshotService({ db: dbH.db, primary: fd as any, fallback: yf as any, redis: redis as any });

    const result = await svc.refresh('AAPL');
    expect(result.ticker).toBe('AAPL');
    expect(fd.snapshot).toHaveBeenCalled();
    expect(yf.snapshot).not.toHaveBeenCalled();

    const rows = await dbH.db.select().from(snapshots).where(eq(snapshots.ticker, 'AAPL'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('financial_datasets');
    expect(redis._store.has('ticker:snapshot:AAPL')).toBe(true);
  });

  it('refresh: falls back to yfinance on RateLimitError', async () => {
    const fd = { name: 'financial_datasets', snapshot: vi.fn().mockRejectedValue(new RateLimitError('429')) };
    const yf = { name: 'yfinance', snapshot: vi.fn().mockResolvedValue(aaplSnapshot()) };
    const redis = fakeRedis();
    const svc = new SnapshotService({ db: dbH.db, primary: fd as any, fallback: yf as any, redis: redis as any });

    const result = await svc.refresh('AAPL');
    expect(result.ticker).toBe('AAPL');
    expect(yf.snapshot).toHaveBeenCalled();

    const rows = await dbH.db.select().from(snapshots).where(eq(snapshots.ticker, 'AAPL'));
    expect(rows[0]!.source).toBe('yfinance');
  });

  it('refresh: does not fall back on NotFoundError', async () => {
    const fd = { name: 'financial_datasets', snapshot: vi.fn().mockRejectedValue(new NotFoundError('nope')) };
    const yf = { name: 'yfinance', snapshot: vi.fn() };
    const svc = new SnapshotService({ db: dbH.db, primary: fd as any, fallback: yf as any, redis: fakeRedis() as any });

    await expect(svc.refresh('XXXX')).rejects.toBeInstanceOf(NotFoundError);
    expect(yf.snapshot).not.toHaveBeenCalled();
  });

  it('get: returns Redis hit without DB or provider', async () => {
    const fd = { name: 'financial_datasets', snapshot: vi.fn() };
    const redis = fakeRedis();
    redis._store.set('ticker:snapshot:AAPL', JSON.stringify({
      ticker: 'AAPL', price: 195.4, marketCap: 3.1e12,
      week52High: 220.5, week52Low: 165, pe: 28.5, ps: 7.8, pb: 45.2,
      evEbitda: 22.1, peg: 2.4, asOf: '2026-05-23T20:00:00Z'
    }));
    const svc = new SnapshotService({ db: dbH.db, primary: fd as any, fallback: { name: 'yfinance', snapshot: vi.fn() } as any, redis: redis as any });

    const result = await svc.get('AAPL');
    expect(result!.ticker).toBe('AAPL');
    expect(fd.snapshot).not.toHaveBeenCalled();
  });

  it('get: returns Postgres hit when Redis cold, populates Redis', async () => {
    // Seed Postgres directly.
    await dbH.db.insert(snapshots).values({
      ticker: 'AAPL', price: '195.40', marketCap: '3100000000000',
      week52High: '220.50', week52Low: '165.00',
      pe: '28.50', ps: '7.80', pb: '45.20', evEbitda: '22.10', peg: '2.40',
      asOf: new Date(), source: 'financial_datasets'
    });

    const fd = { name: 'financial_datasets', snapshot: vi.fn() };
    const redis = fakeRedis();
    const svc = new SnapshotService({ db: dbH.db, primary: fd as any, fallback: { name: 'yfinance', snapshot: vi.fn() } as any, redis: redis as any });

    const result = await svc.get('AAPL');
    expect(result!.ticker).toBe('AAPL');
    expect(fd.snapshot).not.toHaveBeenCalled();
    expect(redis._store.has('ticker:snapshot:AAPL')).toBe(true);
  });

  it('get: cache cold + DB stale triggers refresh', async () => {
    // Insert stale row (2h old) by raw SQL.
    await dbH.db.execute(/* sql */`
      insert into snapshots (ticker, as_of, fetched_at, source)
      values ('AAPL', now() - interval '2 hours', now() - interval '2 hours', 'financial_datasets')
    `);

    const fd = { name: 'financial_datasets', snapshot: vi.fn().mockResolvedValue(aaplSnapshot()) };
    const svc = new SnapshotService({ db: dbH.db, primary: fd as any, fallback: { name: 'yfinance', snapshot: vi.fn() } as any, redis: fakeRedis() as any });

    const result = await svc.get('AAPL');
    expect(result!.ticker).toBe('AAPL');
    expect(fd.snapshot).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Write `lib/services/snapshot.ts`**

```ts
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { snapshots } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import { isFresh, upsertSnapshot } from '@/lib/cache/postgres';
import { TTL, isUSMarketOpen } from '@/lib/cache/ttls';
import { RedisCache } from '@/lib/cache/redis';
import {
  NotFoundError,
  Provider,
  ProviderError,
  RateLimitError,
  SnapshotData,
  ValidationError
} from '@/lib/providers/types';
import { logger } from '@/lib/logger';

interface Deps {
  db: ServiceDb;
  primary: Provider;
  fallback: Provider;
  redis: RedisCache;
}

export class SnapshotService {
  constructor(private readonly deps: Deps) {}

  async get(ticker: string): Promise<SnapshotData | null> {
    const t = ticker.toUpperCase();
    const key = `ticker:snapshot:${t}`;
    const ttl = isUSMarketOpen() ? TTL.snapshotInMarket : TTL.snapshotOffMarket;

    // 1. Redis
    const cached = await this.deps.redis.get<SnapshotDTO>(key);
    if (cached) return hydrate(cached);

    // 2. Postgres (if fresh)
    if (await isFresh(this.deps.db, 'snapshots', t, ttl)) {
      const row = await this.readDb(t);
      if (row) {
        await this.deps.redis.set(key, dehydrate(row), ttl);
        return row;
      }
    }

    // 3. Refresh
    return this.refresh(t);
  }

  async refresh(ticker: string): Promise<SnapshotData> {
    const t = ticker.toUpperCase();
    const key = `ticker:snapshot:${t}`;
    let data: SnapshotData;
    let source: 'financial_datasets' | 'yfinance';

    try {
      data = await this.deps.primary.snapshot(t);
      source = 'financial_datasets';
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof ValidationError) throw err;
      if (err instanceof RateLimitError || err instanceof ProviderError) {
        logger.warn({ ticker: t, err: String(err) }, 'snapshot: falling back to yfinance');
        data = await this.deps.fallback.snapshot(t);
        source = 'yfinance';
      } else {
        throw err;
      }
    }

    await upsertSnapshot(this.deps.db, {
      ticker: t,
      price: data.price?.toString() ?? null,
      marketCap: data.marketCap?.toString() ?? null,
      week52High: data.week52High?.toString() ?? null,
      week52Low: data.week52Low?.toString() ?? null,
      pe: data.pe?.toString() ?? null,
      ps: data.ps?.toString() ?? null,
      pb: data.pb?.toString() ?? null,
      evEbitda: data.evEbitda?.toString() ?? null,
      peg: data.peg?.toString() ?? null,
      asOf: data.asOf,
      source
    });

    const ttl = isUSMarketOpen() ? TTL.snapshotInMarket : TTL.snapshotOffMarket;
    await this.deps.redis.set(key, dehydrate(data), ttl);
    return data;
  }

  private async readDb(ticker: string): Promise<SnapshotData | null> {
    const rows = await this.deps.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.ticker, ticker))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      ticker: r.ticker,
      price: r.price ? Number(r.price) : null,
      marketCap: r.marketCap ? Number(r.marketCap) : null,
      week52High: r.week52High ? Number(r.week52High) : null,
      week52Low: r.week52Low ? Number(r.week52Low) : null,
      pe: r.pe ? Number(r.pe) : null,
      ps: r.ps ? Number(r.ps) : null,
      pb: r.pb ? Number(r.pb) : null,
      evEbitda: r.evEbitda ? Number(r.evEbitda) : null,
      peg: r.peg ? Number(r.peg) : null,
      asOf: r.asOf
    };
  }
}

/** Wire-format-friendly DTO (asOf is ISO string) for Redis JSON. */
type SnapshotDTO = Omit<SnapshotData, 'asOf'> & { asOf: string };

function dehydrate(s: SnapshotData): SnapshotDTO {
  return { ...s, asOf: s.asOf.toISOString() };
}
function hydrate(s: SnapshotDTO): SnapshotData {
  return { ...s, asOf: new Date(s.asOf) };
}
```

- [ ] **Step 3: Run, verify passes**

Run: `pnpm test:integration tests/integration/services-snapshot.test.ts`
Expected: all 6 tests passing.

- [ ] **Step 4: Commit**

```bash
git add lib/services/snapshot.ts tests/integration/services-snapshot.test.ts
git commit -m "feat(services): SnapshotService with cache + fallback"
```

---

### Task 6.2: `lib/services/financials.ts`

**Files:**
- Create: `lib/services/financials.ts`
- Create: `tests/integration/services-financials.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestDb, resetDb } from '../helpers/test-db';
import { companies, fundamentals } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { FinancialsService } from '@/lib/services/financials';
import { StatementBundle, RateLimitError } from '@/lib/providers/types';

config({ path: '.env.local' });

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
    del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
    _store: store
  };
}

const aaplIncomeBundle: StatementBundle = {
  ticker: 'AAPL',
  statementType: 'income',
  periodType: 'annual',
  rows: [
    { periodEnd: '2024-09-30', lineItem: 'revenue', value: 383285000000, currency: 'USD' },
    { periodEnd: '2024-09-30', lineItem: 'net_income', value: 99803000000, currency: 'USD' },
    { periodEnd: '2023-09-30', lineItem: 'revenue', value: 394328000000, currency: 'USD' }
  ]
};

describe('FinancialsService', () => {
  let dbH: ReturnType<typeof makeTestDb>;
  beforeAll(() => { dbH = makeTestDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
  });

  it('refresh: persists rows to Postgres and Redis', async () => {
    const fd = { name: 'financial_datasets', statements: vi.fn().mockResolvedValue(aaplIncomeBundle) };
    const yf = { name: 'yfinance', statements: vi.fn() };
    const svc = new FinancialsService({ db: dbH.db, primary: fd as any, fallback: yf as any, redis: fakeRedis() as any });

    const result = await svc.refresh('AAPL', 'income', 'annual');
    expect(result.rows).toHaveLength(3);

    const rows = await dbH.db.select().from(fundamentals).where(
      and(eq(fundamentals.ticker, 'AAPL'), eq(fundamentals.statementType, 'income'))
    );
    expect(rows).toHaveLength(3);
  });

  it('refresh: falls back to yfinance does NOT happen for statements (FD only)', async () => {
    // yfinance.statements() throws ProviderError per the spec; service should bubble FD failure.
    const fd = { name: 'financial_datasets', statements: vi.fn().mockRejectedValue(new RateLimitError('429')) };
    const yf = { name: 'yfinance', statements: vi.fn().mockRejectedValue(new Error('yfinance no statements')) };
    const svc = new FinancialsService({ db: dbH.db, primary: fd as any, fallback: yf as any, redis: fakeRedis() as any });

    // The service falls back; yf.statements throws — so the whole refresh throws.
    await expect(svc.refresh('AAPL', 'income', 'annual')).rejects.toThrow();
  });

  it('get: reads from Postgres after refresh', async () => {
    const fd = { name: 'financial_datasets', statements: vi.fn().mockResolvedValue(aaplIncomeBundle) };
    const svc = new FinancialsService({ db: dbH.db, primary: fd as any, fallback: { name: 'yfinance', statements: vi.fn() } as any, redis: fakeRedis() as any });
    await svc.refresh('AAPL', 'income', 'annual');

    fd.statements.mockClear();
    const out = await svc.get('AAPL', 'income', 'annual');
    expect(out.rows.length).toBe(3);
    expect(fd.statements).not.toHaveBeenCalled(); // served from Redis or DB
  });
});
```

- [ ] **Step 2: Write `lib/services/financials.ts`**

```ts
import { and, desc, eq } from 'drizzle-orm';
import { fundamentals } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import { isFresh, upsertFundamentals } from '@/lib/cache/postgres';
import { TTL } from '@/lib/cache/ttls';
import { RedisCache } from '@/lib/cache/redis';
import {
  NotFoundError,
  PeriodType,
  Provider,
  ProviderError,
  RateLimitError,
  StatementBundle,
  StatementType,
  ValidationError
} from '@/lib/providers/types';
import { logger } from '@/lib/logger';

interface Deps {
  db: ServiceDb;
  primary: Provider;
  fallback: Provider;
  redis: RedisCache;
}

export class FinancialsService {
  constructor(private readonly deps: Deps) {}

  async get(ticker: string, type: StatementType, period: PeriodType): Promise<StatementBundle> {
    const t = ticker.toUpperCase();
    const key = `ticker:financials:${t}:${type}:${period}`;
    const ttl = period === 'annual' ? TTL.financialsAnnual : TTL.financialsQuarterly;

    const cached = await this.deps.redis.get<StatementBundle>(key);
    if (cached) return cached;

    if (await isFresh(this.deps.db, 'fundamentals', t, ttl)) {
      const bundle = await this.readDb(t, type, period);
      if (bundle.rows.length > 0) {
        await this.deps.redis.set(key, bundle, ttl);
        return bundle;
      }
    }

    return this.refresh(t, type, period);
  }

  async refresh(ticker: string, type: StatementType, period: PeriodType): Promise<StatementBundle> {
    const t = ticker.toUpperCase();
    const key = `ticker:financials:${t}:${type}:${period}`;
    let bundle: StatementBundle;
    let source: 'financial_datasets' | 'yfinance';

    try {
      bundle = await this.deps.primary.statements(t, type, period);
      source = 'financial_datasets';
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof ValidationError) throw err;
      if (err instanceof RateLimitError || err instanceof ProviderError) {
        logger.warn({ ticker: t, err: String(err) }, 'financials: falling back to yfinance');
        bundle = await this.deps.fallback.statements(t, type, period);
        source = 'yfinance';
      } else {
        throw err;
      }
    }

    await upsertFundamentals(
      this.deps.db,
      bundle.rows.map((r) => ({
        ticker: t,
        periodEnd: r.periodEnd,
        periodType: period,
        statementType: type,
        lineItem: r.lineItem,
        value: r.value?.toString() ?? null,
        currency: r.currency,
        source
      }))
    );

    const ttl = period === 'annual' ? TTL.financialsAnnual : TTL.financialsQuarterly;
    await this.deps.redis.set(key, bundle, ttl);
    return bundle;
  }

  private async readDb(
    ticker: string,
    type: StatementType,
    period: PeriodType
  ): Promise<StatementBundle> {
    const rows = await this.deps.db
      .select()
      .from(fundamentals)
      .where(
        and(
          eq(fundamentals.ticker, ticker),
          eq(fundamentals.statementType, type),
          eq(fundamentals.periodType, period)
        )
      )
      .orderBy(desc(fundamentals.periodEnd));
    return {
      ticker,
      statementType: type,
      periodType: period,
      rows: rows.map((r) => ({
        periodEnd: r.periodEnd,
        lineItem: r.lineItem,
        value: r.value ? Number(r.value) : null,
        currency: r.currency
      }))
    };
  }
}
```

- [ ] **Step 3: Run, verify passes**

Run: `pnpm test:integration tests/integration/services-financials.test.ts`
Expected: all 3 passing.

- [ ] **Step 4: Commit**

```bash
git add lib/services/financials.ts tests/integration/services-financials.test.ts
git commit -m "feat(services): FinancialsService with cache + fallback"
```

---

### Task 6.3: `lib/services/prices.ts`

**Files:**
- Create: `lib/services/prices.ts`
- Create: `tests/integration/services-prices.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestDb, resetDb } from '../helpers/test-db';
import { companies, prices as pricesTable } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { PricesService } from '@/lib/services/prices';

config({ path: '.env.local' });

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
    del: vi.fn(async () => 1),
    _store: store
  };
}

describe('PricesService', () => {
  let dbH: ReturnType<typeof makeTestDb>;
  beforeAll(() => { dbH = makeTestDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
  });

  it('refresh: persists prices', async () => {
    const fd = {
      name: 'financial_datasets',
      prices: vi.fn().mockResolvedValue([
        { date: '2025-05-23', open: 188, high: 190.5, low: 187.2, close: 189.4, adjClose: 189.4, volume: 50000000 },
        { date: '2025-05-26', open: 189.4, high: 191, low: 188.8, close: 190.6, adjClose: 190.6, volume: 48000000 }
      ])
    };
    const svc = new PricesService({ db: dbH.db, primary: fd as any, fallback: { name: 'yfinance', prices: vi.fn() } as any, redis: fakeRedis() as any });

    const rows = await svc.refresh('AAPL', '1Y');
    expect(rows).toHaveLength(2);

    const dbRows = await dbH.db.select().from(pricesTable).where(eq(pricesTable.ticker, 'AAPL'));
    expect(dbRows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Write `lib/services/prices.ts`**

```ts
import { asc, eq } from 'drizzle-orm';
import { prices as pricesTable } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import { isFresh, upsertPrices } from '@/lib/cache/postgres';
import { TTL } from '@/lib/cache/ttls';
import { RedisCache } from '@/lib/cache/redis';
import {
  NotFoundError,
  Provider,
  ProviderError,
  PricePoint,
  RateLimitError,
  ValidationError
} from '@/lib/providers/types';
import { logger } from '@/lib/logger';

interface Deps {
  db: ServiceDb;
  primary: Provider;
  fallback: Provider;
  redis: RedisCache;
}

export class PricesService {
  constructor(private readonly deps: Deps) {}

  async get(ticker: string, range: '1Y' | '5Y'): Promise<PricePoint[]> {
    const t = ticker.toUpperCase();
    const key = `ticker:prices:${t}:${range}`;
    const ttl = range === '1Y' ? TTL.prices1Y : TTL.prices5Y;

    const cached = await this.deps.redis.get<PricePoint[]>(key);
    if (cached) return cached;

    if (await isFresh(this.deps.db, 'prices', t, ttl)) {
      const rows = await this.readDb(t, range);
      if (rows.length > 0) {
        await this.deps.redis.set(key, rows, ttl);
        return rows;
      }
    }

    return this.refresh(t, range);
  }

  async refresh(ticker: string, range: '1Y' | '5Y'): Promise<PricePoint[]> {
    const t = ticker.toUpperCase();
    const key = `ticker:prices:${t}:${range}`;
    let data: PricePoint[];
    let source: 'financial_datasets' | 'yfinance';

    try {
      data = await this.deps.primary.prices(t, range);
      source = 'financial_datasets';
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof ValidationError) throw err;
      if (err instanceof RateLimitError || err instanceof ProviderError) {
        logger.warn({ ticker: t, err: String(err) }, 'prices: falling back to yfinance');
        data = await this.deps.fallback.prices(t, range);
        source = 'yfinance';
      } else {
        throw err;
      }
    }

    await upsertPrices(
      this.deps.db,
      data.map((p) => ({
        ticker: t,
        date: p.date,
        open: p.open?.toString() ?? null,
        high: p.high?.toString() ?? null,
        low: p.low?.toString() ?? null,
        close: p.close.toString(),
        adjClose: p.adjClose?.toString() ?? null,
        volume: p.volume ? BigInt(Math.trunc(p.volume)) : null,
        source
      }))
    );

    const ttl = range === '1Y' ? TTL.prices1Y : TTL.prices5Y;
    await this.deps.redis.set(key, data, ttl);
    return data;
  }

  private async readDb(ticker: string, range: '1Y' | '5Y'): Promise<PricePoint[]> {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - (range === '1Y' ? 1 : 5));
    const rows = await this.deps.db
      .select()
      .from(pricesTable)
      .where(eq(pricesTable.ticker, ticker))
      .orderBy(asc(pricesTable.date));
    return rows
      .filter((r) => new Date(r.date) >= cutoff)
      .map((r) => ({
        date: r.date,
        open: r.open ? Number(r.open) : null,
        high: r.high ? Number(r.high) : null,
        low: r.low ? Number(r.low) : null,
        close: Number(r.close),
        adjClose: r.adjClose ? Number(r.adjClose) : null,
        volume: r.volume ? Number(r.volume) : null
      }));
  }
}
```

- [ ] **Step 3: Run, verify passes**

Run: `pnpm test:integration tests/integration/services-prices.test.ts`
Expected: 1 passing.

- [ ] **Step 4: Commit**

```bash
git add lib/services/prices.ts tests/integration/services-prices.test.ts
git commit -m "feat(services): PricesService with cache + fallback"
```

---

### Task 6.4: `lib/services/watchlist.ts`

**Files:**
- Create: `lib/services/watchlist.ts`
- Create: `tests/integration/services-watchlist.test.ts`

The watchlist service operates on the user-scoped table. Unlike snapshot/financials/prices, it doesn't talk to a provider; it just CRUDs the `watchlist` table. RLS will be enforced when called from authenticated server contexts in Phase 1B.

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestDb, resetDb, createTestUser } from '../helpers/test-db';
import { companies } from '@/lib/db/schema';
import { WatchlistService } from '@/lib/services/watchlist';

config({ path: '.env.local' });

describe('WatchlistService', () => {
  let dbH: ReturnType<typeof makeTestDb>;
  beforeAll(() => { dbH = makeTestDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values([
      { ticker: 'AAPL', name: 'Apple' },
      { ticker: 'MSFT', name: 'Microsoft' }
    ]);
  });

  it('add: inserts a row', async () => {
    const u = await createTestUser('a@x.com');
    const svc = new WatchlistService(dbH.db);
    await svc.add(u.userId, 'AAPL');
    const list = await svc.list(u.userId);
    expect(list).toEqual([{ ticker: 'AAPL' }]);
  });

  it('add: is idempotent', async () => {
    const u = await createTestUser('a@x.com');
    const svc = new WatchlistService(dbH.db);
    await svc.add(u.userId, 'AAPL');
    await svc.add(u.userId, 'AAPL');
    const list = await svc.list(u.userId);
    expect(list).toHaveLength(1);
  });

  it('remove: deletes the row', async () => {
    const u = await createTestUser('a@x.com');
    const svc = new WatchlistService(dbH.db);
    await svc.add(u.userId, 'AAPL');
    await svc.remove(u.userId, 'AAPL');
    expect(await svc.list(u.userId)).toEqual([]);
  });

  it('list: orders by addedAt desc', async () => {
    const u = await createTestUser('a@x.com');
    const svc = new WatchlistService(dbH.db);
    await svc.add(u.userId, 'AAPL');
    await new Promise((r) => setTimeout(r, 20));
    await svc.add(u.userId, 'MSFT');
    const list = await svc.list(u.userId);
    expect(list.map((r) => r.ticker)).toEqual(['MSFT', 'AAPL']);
  });
});
```

- [ ] **Step 2: Write `lib/services/watchlist.ts`**

```ts
import { and, desc, eq } from 'drizzle-orm';
import { watchlist } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';

export interface WatchlistEntry {
  ticker: string;
}

export class WatchlistService {
  constructor(private readonly db: ServiceDb) {}

  async list(userId: string): Promise<WatchlistEntry[]> {
    const rows = await this.db
      .select({ ticker: watchlist.ticker })
      .from(watchlist)
      .where(eq(watchlist.userId, userId))
      .orderBy(desc(watchlist.addedAt));
    return rows;
  }

  async add(userId: string, ticker: string): Promise<void> {
    await this.db
      .insert(watchlist)
      .values({ userId, ticker: ticker.toUpperCase() })
      .onConflictDoNothing();
  }

  async remove(userId: string, ticker: string): Promise<void> {
    await this.db
      .delete(watchlist)
      .where(and(eq(watchlist.userId, userId), eq(watchlist.ticker, ticker.toUpperCase())));
  }

  async has(userId: string, ticker: string): Promise<boolean> {
    const rows = await this.db
      .select({ ticker: watchlist.ticker })
      .from(watchlist)
      .where(and(eq(watchlist.userId, userId), eq(watchlist.ticker, ticker.toUpperCase())))
      .limit(1);
    return rows.length > 0;
  }
}
```

- [ ] **Step 3: Run, verify passes**

Run: `pnpm test:integration tests/integration/services-watchlist.test.ts`
Expected: 4 passing.

- [ ] **Step 4: Commit**

```bash
git add lib/services/watchlist.ts tests/integration/services-watchlist.test.ts
git commit -m "feat(services): WatchlistService with idempotent add"
```

---

## Milestone 7: Seed Data + Smoke Test Script

Goal: load the 10 seed tickers and a `pnpm try AAPL` script that exercises the whole stack end-to-end.

### Task 7.1: Seed ticker constants

**Files:**
- Create: `lib/seed/tickers.ts`

- [ ] **Step 1: Write `lib/seed/tickers.ts`**

```ts
/**
 * The 10 seed tickers pre-loaded into the companies table.
 * Picked to span sectors so the dashboard exercises a variety of metric shapes.
 */
export const SEED_TICKERS = [
  { ticker: 'AAPL',  name: 'Apple Inc.',                   sector: 'Technology'             },
  { ticker: 'MSFT',  name: 'Microsoft Corporation',        sector: 'Technology'             },
  { ticker: 'NVDA',  name: 'NVIDIA Corporation',           sector: 'Technology'             },
  { ticker: 'GOOG',  name: 'Alphabet Inc.',                sector: 'Communication Services' },
  { ticker: 'AMZN',  name: 'Amazon.com, Inc.',             sector: 'Consumer Cyclical'      },
  { ticker: 'META',  name: 'Meta Platforms, Inc.',         sector: 'Communication Services' },
  { ticker: 'BRK.B', name: 'Berkshire Hathaway Inc.',      sector: 'Financial Services'     },
  { ticker: 'JPM',   name: 'JPMorgan Chase & Co.',         sector: 'Financial Services'     },
  { ticker: 'XOM',   name: 'Exxon Mobil Corporation',      sector: 'Energy'                 },
  { ticker: 'UNH',   name: 'UnitedHealth Group Inc.',      sector: 'Healthcare'             }
] as const;

export type SeedTicker = (typeof SEED_TICKERS)[number]['ticker'];
```

- [ ] **Step 2: Commit**

```bash
git add lib/seed/tickers.ts
git commit -m "feat(seed): define 10 seed tickers"
```

---

### Task 7.2: Seed script — load companies + initial fetch

**Files:**
- Create: `scripts/seed.ts`

- [ ] **Step 1: Write `scripts/seed.ts`**

```ts
#!/usr/bin/env tsx
/**
 * Seed script: ensures the 10 seed tickers exist in `companies` and
 * performs an initial fetch of snapshot + financials + prices + earnings
 * via the service layer (so cache and DB are populated).
 *
 * Run: `pnpm seed`
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { getServiceDb } from '@/lib/db/client';
import { companies } from '@/lib/db/schema';
import { SEED_TICKERS } from '@/lib/seed/tickers';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { SnapshotService } from '@/lib/services/snapshot';
import { FinancialsService } from '@/lib/services/financials';
import { PricesService } from '@/lib/services/prices';
import { loadServerEnv } from '@/lib/env';
import { logger } from '@/lib/logger';

async function main() {
  const env = loadServerEnv();
  const db = getServiceDb();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const redis = getRedisCache();

  const snapshot = new SnapshotService({ db, primary: fd, fallback: yf, redis });
  const financials = new FinancialsService({ db, primary: fd, fallback: yf, redis });
  const prices = new PricesService({ db, primary: fd, fallback: yf, redis });

  // 1. Upsert seed company rows.
  logger.info({ count: SEED_TICKERS.length }, 'seed: inserting companies');
  for (const t of SEED_TICKERS) {
    await db
      .insert(companies)
      .values({ ticker: t.ticker, name: t.name, sector: t.sector, isSeed: true })
      .onConflictDoUpdate({
        target: companies.ticker,
        set: { name: t.name, sector: t.sector, isSeed: true }
      });
  }

  // 2. Initial fetch — sequential to respect rate limits.
  for (const t of SEED_TICKERS) {
    const ticker = t.ticker;
    try {
      logger.info({ ticker }, 'seed: snapshot');
      await snapshot.refresh(ticker);

      logger.info({ ticker }, 'seed: income annual');
      await financials.refresh(ticker, 'income', 'annual');
      logger.info({ ticker }, 'seed: balance annual');
      await financials.refresh(ticker, 'balance', 'annual');
      logger.info({ ticker }, 'seed: cash_flow annual');
      await financials.refresh(ticker, 'cash_flow', 'annual');

      logger.info({ ticker }, 'seed: prices 1Y');
      await prices.refresh(ticker, '1Y');
    } catch (err) {
      logger.error({ ticker, err: String(err) }, 'seed: ticker failed; continuing');
    }
  }

  logger.info('seed: done');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: String(err) }, 'seed: fatal');
  process.exit(1);
});
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Smoke run (real API call — needs valid `.env.local`)**

Run: `pnpm seed`
Expected: logs show each ticker progressing; final "seed: done" message; exit 0.

If FD free tier rate-limits, the script will fall back to yfinance per ticker.

- [ ] **Step 4: Verify data landed in Postgres**

Run:
```bash
supabase db dump --data-only --schema public --table companies | grep -c "AAPL\|MSFT\|NVDA\|GOOG\|AMZN\|META\|BRK\|JPM\|XOM\|UNH"
```
Expected: at least 10.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed.ts
git commit -m "feat(seed): script to load 10 seed tickers + initial fetch"
```

---

### Task 7.3: `pnpm try <TICKER>` smoke-test script

**Files:**
- Create: `scripts/try-snapshot.ts`

- [ ] **Step 1: Write the script**

```ts
#!/usr/bin/env tsx
/**
 * End-to-end smoke test: `pnpm try TSLA`
 *
 * Fetches snapshot + financials + prices for one ticker through the service
 * layer (cache + provider + fallback). Prints the result so a human can sanity-check.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { getServiceDb } from '@/lib/db/client';
import { companies } from '@/lib/db/schema';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { SnapshotService } from '@/lib/services/snapshot';
import { FinancialsService } from '@/lib/services/financials';
import { PricesService } from '@/lib/services/prices';
import { loadServerEnv } from '@/lib/env';

async function main() {
  const ticker = (process.argv[2] ?? '').toUpperCase();
  if (!/^[A-Z.]{1,6}$/.test(ticker)) {
    console.error('Usage: pnpm try <TICKER>');
    process.exit(2);
  }

  const env = loadServerEnv();
  const db = getServiceDb();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const redis = getRedisCache();

  // Ensure the company row exists.
  await db
    .insert(companies)
    .values({ ticker, name: ticker })
    .onConflictDoNothing();

  const snapshot = new SnapshotService({ db, primary: fd, fallback: yf, redis });
  const financials = new FinancialsService({ db, primary: fd, fallback: yf, redis });
  const prices = new PricesService({ db, primary: fd, fallback: yf, redis });

  console.log(`\n=== Snapshot ${ticker} ===`);
  console.log(await snapshot.get(ticker));

  console.log(`\n=== Income (annual, last 2 periods) ===`);
  const income = await financials.get(ticker, 'income', 'annual');
  console.log(income.rows.slice(0, 14)); // 7 line items × 2 periods

  console.log(`\n=== Prices 1Y (first 3 + last 3) ===`);
  const px = await prices.get(ticker, '1Y');
  console.log([...px.slice(0, 3), '…', ...px.slice(-3)]);

  process.exit(0);
}

main().catch((err) => {
  console.error('try-snapshot failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Smoke-test it**

Run: `pnpm try AAPL`
Expected: prints snapshot, income statement rows, and price points. Exit 0.

Run: `pnpm try TSLA`
Expected: on-demand ingest happens (slower the first time); ends with valid output.

Run: `pnpm try XXXXFAKE`
Expected: prints an error (NotFoundError from FD, fallback also fails); exit 1.

- [ ] **Step 3: Commit**

```bash
git add scripts/try-snapshot.ts
git commit -m "chore(scripts): pnpm try <TICKER> smoke-test"
```

---

## Phase 1A — Completion checklist

After all tasks above pass, verify the phase is done:

- [ ] **All unit tests pass:** `pnpm test`
- [ ] **All integration tests pass:** `pnpm test:integration` (with `supabase start` running)
- [ ] **Typecheck clean:** `pnpm typecheck`
- [ ] **Lint clean:** `pnpm lint`
- [ ] **Seed loads:** `supabase db reset && pnpm seed` succeeds for all 10 tickers
- [ ] **Smoke test works:** `pnpm try AAPL` and `pnpm try TSLA` both print sensible data
- [ ] **RLS test passes:** `pnpm test:integration tests/integration/rls-watchlist.test.ts` confirms user isolation
- [ ] **Git log is clean:** `git log --oneline` shows ~30 small, descriptive commits

When all boxes are checked, Phase 1A is complete and Phase 1B (Auth + API + UI) can be planned.

---

## Phase 1A — What's NOT in here (deliberate)

- **HTTP API routes.** Services are callable from scripts but not from the browser. → Phase 1B.
- **Auth pages and middleware.** No login UI; tests use admin API directly. → Phase 1B.
- **Ticker dashboard, financials charts, watchlist UI.** No UI beyond the placeholder home page. → Phase 1B.
- **Cron handler.** Refresh runs from scripts, not on a schedule. → Phase 1C.
- **Playwright E2E.** Service-layer integration tests cover the data path. UI E2E lands with the UI. → Phase 1C.
- **GitHub Actions CI.** Local-only for Phase 1A. → Phase 1C.
- **Vercel deploy config.** Local-only for Phase 1A. → Phase 1C.

These are tracked so they don't get lost; each lands in the phase it's tagged for.
