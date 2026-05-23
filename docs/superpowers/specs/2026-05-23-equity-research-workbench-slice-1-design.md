# Equity Research Workbench — Slice 1 Design

**Date:** 2026-05-23
**Status:** Draft — pending implementation plan
**Project root:** `C:\Users\elinw\Projects\equity-research-workbench`

## Context and scope

The Equity Research Workbench is a full-stack stock research application that aggregates fundamental data, SEC filings, and qualitative business intelligence into a single workbench. The original spec describes a platform spanning six independent subsystems (market data, EDGAR ingestion, LLM summarization, business intelligence extraction, semantic Q&A, user/ops layer) and ten build steps. That is too large for a single design document.

The project is decomposed into four slices, each shipped and reviewed before the next is designed:

- **Slice 1 (this document) — Foundation, Snapshot, Financials, Watchlist.** Next.js scaffold, Neon Postgres schema, Stack Auth + watchlist + notes, ticker dashboard with snapshot card and 5Y financials charts, 10 seed tickers + "add ticker" flow, Financial Datasets primary + yfinance fallback. No LLM, no filings.
- **Slice 2 — EDGAR filing ingestion + per-filing TLDR.** Download/parse/chunk/embed filings, per-section LLM summarization with prompt caching and cost tracking.
- **Slice 3 — Business intelligence + semantic Q&A.** Competitors, customers, supply chain, risks, moat extraction; pgvector search over filings with citations.
- **Slice 4 — User layer expansion + ops.** Price alerts, multi-user concerns, admin dashboard, full background ingestion observability, polish (Bloomberg aesthetic, keyboard shortcuts), mobile.

Slice 1 is sized to deliver a usable single-user research tool for the 10 seed tickers (AAPL, MSFT, NVDA, GOOG, AMZN, META, BRK.B, JPM, XOM, UNH) plus user-added tickers, end-to-end, before any LLM or filing work begins.

## Goals (Slice 1)

1. User can sign up, log in, and see a watchlist.
2. User can view a ticker dashboard at `/stock/[ticker]` with a snapshot card and a 5Y financials tab.
3. User can add a new ticker by symbol; it is ingested on-demand and added to their watchlist.
4. User can write per-ticker markdown notes.
5. Watchlisted tickers are refreshed nightly by cron so views are warm.
6. Every page renders in <800ms on a Postgres-warm path, <300ms on a Redis-warm path.
7. Provider failures degrade gracefully via the yfinance fallback; user-facing errors are clear.

## Non-goals (Slice 1)

- Any LLM-generated content (Company Summary, BI section, filing TLDRs, semantic Q&A).
- SEC EDGAR ingestion or filing storage.
- DCF / reverse-DCF widget.
- Peer comparison overlays (requires peer groups extracted from 10-Ks — Slice 3).
- Consensus EPS in earnings history (requires a paid estimates API — defer).
- Price alerts.
- Admin dashboard, ingestion monitoring UI.
- Full Bloomberg-terminal aesthetic, keyboard shortcuts, mobile optimization.
- Vercel deployment (local dev only in Slice 1; deploy is a Slice 1.5 follow-up).

## Architecture

Single Next.js 14 app, App Router. No separate backend service. All server work runs in:

- **Route handlers** for client-callable endpoints (e.g., `GET /api/tickers/[symbol]/snapshot`).
- **Server Components and Server Actions** for page-level data fetching on the initial render of `/stock/[ticker]`.
- **Cron handler** at `app/api/cron/refresh/route.ts`, triggered by Vercel Cron in production. In local dev, `pnpm refresh` runs the same code path against the same cloud Neon database.

External dependencies:

- **Neon Postgres** (managed serverless Postgres). Connection string in `DATABASE_URL`. Migrations applied via `drizzle-kit push` against the dev branch.
- **Stack Auth** (Neon's first-party auth, free tier). Identity provider; issues JWTs that the app uses to scope DB reads. Server-side `@stackframe/stack` SDK; project ID + publishable/secret keys in env.
- Upstash Redis — REST client, Edge-runtime compatible.
- Financial Datasets API — REST; key in `FINANCIAL_DATASETS_API_KEY`.
- `yfinance` fallback — Python script invoked from the TypeScript adapter. In Slice 1 (local dev only), `lib/providers/yfinance.ts` shells out via `child_process.spawn('python', ['scripts/yfinance_fetch.py', symbol, kind])`, parses JSON from stdout. When the project deploys to Vercel (Slice 1.5+), the same Python file is moved to `app/api/fallback/yfinance/route.py` and the TS adapter switches to an HTTP call — no logic change in the rest of the codebase.

Layered data access:

```
UI (RSC + client islands)
   ↓
Service layer (lib/services/*)        — business logic, picks data source
   ↓
Cache layer (lib/cache/*)             — Redis hot, Postgres cold
   ↓
Provider adapters (lib/providers/*)   — FD adapter, yfinance adapter
   ↓
External APIs
```

UI talks to services, never to providers. The service handles cache lookup, fallback selection, and persistence. Swapping a provider later is a one-file change.

## Components and module layout

```
equity-research-workbench/
├── app/
│   ├── handler/[...stack]/page.tsx      # Stack Auth catches /handler/* (signup, login, OAuth callback, account)
│   ├── (app)/
│   │   ├── layout.tsx                   # session-gated shell with nav
│   │   ├── watchlist/page.tsx           # landing page after login
│   │   └── stock/[ticker]/
│   │       ├── page.tsx                 # ticker dashboard (RSC)
│   │       ├── financials/page.tsx      # 5Y statements tab
│   │       └── components/
│   │           ├── snapshot-card.tsx
│   │           ├── financials-table.tsx
│   │           ├── revenue-chart.tsx
│   │           ├── margin-chart.tsx
│   │           ├── earnings-history.tsx
│   │           └── notes-editor.tsx
│   ├── api/
│   │   ├── tickers/
│   │   │   ├── search/route.ts          # GET ?q= → filter seed list
│   │   │   ├── add/route.ts             # POST { symbol } → ingest + watchlist
│   │   │   └── [symbol]/
│   │   │       ├── snapshot/route.ts
│   │   │       ├── financials/route.ts
│   │   │       └── prices/route.ts
│   │   ├── watchlist/route.ts
│   │   ├── notes/[ticker]/route.ts
│   │   ├── cron/refresh/route.ts        # Cron entrypoint (called by scripts/refresh-local.ts in Slice 1, by Vercel Cron later)
│   │   └── health/route.ts              # liveness probe
│   └── page.tsx                          # logged-out landing
├── lib/
│   ├── providers/
│   │   ├── financial-datasets.ts
│   │   ├── yfinance.ts                  # spawns scripts/yfinance_fetch.py in Slice 1; HTTP call to /api/fallback/yfinance after deploy
│   │   └── types.ts                     # normalized provider types
│   ├── services/
│   │   ├── snapshot.ts
│   │   ├── financials.ts
│   │   ├── prices.ts
│   │   └── watchlist.ts
│   ├── cache/
│   │   ├── redis.ts                     # Upstash client + helpers
│   │   ├── postgres.ts                  # freshness check + UPSERT
│   │   └── ttls.ts                      # TTL constants
│   ├── db/
│   │   ├── client.ts                    # Drizzle + Supabase clients
│   │   ├── schema.ts
│   │   └── migrations/
│   ├── auth/
│   │   ├── server.ts                    # createSupabaseServerClient
│   │   └── middleware.ts
│   ├── compute/                         # pure functions, no I/O
│   │   ├── growth.ts                    # YoY, CAGR
│   │   ├── multiples.ts                 # P/E, P/S, P/B, EV/EBITDA, PEG
│   │   └── returns.ts                   # ROE, ROA, ROIC
│   └── seed/
│       └── tickers.ts                   # 10 seed tickers
├── components/                          # shared shadcn primitives
├── middleware.ts                        # Supabase session refresh
├── scripts/
│   ├── seed.ts                          # seed tickers + initial fetch
│   ├── refresh-local.ts                 # invokes cron handler locally
│   └── yfinance_fetch.py                # Python script the TS adapter spawns
├── drizzle.config.ts
├── package.json
└── README.md
```

Module responsibilities:

| Module       | Purpose                                                | Depends on            |
| ------------ | ------------------------------------------------------ | --------------------- |
| `providers/*`| Speak to one external API; return normalized types     | none internal         |
| `services/*` | Cache-aware orchestration; pick provider, fall back    | providers, cache, db  |
| `cache/*`    | Read/write through Redis (hot) and Postgres (cold)     | db                    |
| `db/*`       | Schema + typed client                                  | Neon Postgres         |
| `compute/*`  | Pure financial math; fully unit-tested                 | none                  |
| `auth/*`     | Stack Auth session plumbing + JWT-to-DB binding        | Stack Auth SDK        |
| `api/*`      | Thin HTTP shells; auth, parse, call service, return    | services              |

**Hard rule:** API route handlers contain no business logic. They authenticate the request, parse inputs, call a service function, and return. The cron handler calls the same service functions.

## Data flow

### Flow A — User opens a watchlisted ticker (hot path)

1. Browser issues `GET /stock/AAPL`.
2. `middleware.ts` refreshes the Supabase session cookie.
3. `(app)/layout.tsx` checks for a session; redirects to `/login` if missing.
4. `stock/[ticker]/page.tsx` (RSC) calls three services in parallel: `snapshot.get`, `financials.get`, `prices.get`.
5. Each service:
   1. Checks Redis. Hit returns immediately.
   2. On Redis miss, checks Postgres. If fresh (within TTL), writes through to Redis and returns.
   3. On Postgres stale or miss, executes Flow C.
6. RSC renders with the resolved data; client islands hydrate the charts.

Targets: <300ms on Redis-warm, <800ms on Postgres-warm.

### Flow B — User adds a new ticker

1. Browser issues `POST /api/tickers/add { symbol: "TSLA" }`.
2. Route handler:
   1. Auth check.
   2. Validates symbol against `^[A-Z.]{1,6}$`.
   3. If `companies.ticker` exists, attaches to watchlist and returns 200 with redirect target.
3. In parallel, calls `services.snapshot.refresh`, `services.financials.refresh` (annual and quarterly), `services.prices.refresh('1Y')`. Awaits all.
4. Inserts a row in `companies`; attaches to user's watchlist.
5. Returns 201 with `{ ticker, redirectTo: "/stock/TSLA" }`.
6. Client shows progress UI during the 3–5s ingest; on 201, navigates.

Edge cases:
- Provider returns "ticker not found" → 404 with a clear message; nothing persisted.
- Provider returns 200 with sparse data (recent IPO) → accept; the financials tab shows what exists.

### Flow C — Provider call with fallback

```
services.snapshot.refresh(symbol):
  try:
    data = await providers.financialDatasets.snapshot(symbol)
    persist(data, source='financial_datasets')
    return data
  catch (err):
    if err is RateLimitError or err is ProviderError(5xx):
      data = await providers.yfinance.snapshot(symbol)
      persist(data, source='yfinance')
      return data
    if err is NotFoundError:
      throw                # don't fall back; ticker doesn't exist
    throw                  # unknown errors bubble
```

Rules:
- Never fall back on a 4xx that isn't 429. yfinance can't fix a not-found or a bad request.
- Always persist `source` on the row. Lets us spot when fallback fires more than expected and react.
- Retry happens inside the provider adapter (3 attempts, 250ms → 1s → 4s backoff). The service sees a final failure, not transient noise.
- Rate-limit awareness: a token-bucket in `lib/providers/financial-datasets.ts` enforces FD's free-tier RPS so we self-throttle instead of getting 429-rejected. The bucket lives in Redis so cron and on-demand share quota.

### Cache key layout

| Key                                | Value          | TTL                                |
| ---------------------------------- | -------------- | ---------------------------------- |
| `ticker:snapshot:AAPL`             | JSON           | 1h in-market, 24h off-market       |
| `ticker:financials:AAPL:annual`    | JSON           | 24h                                |
| `ticker:financials:AAPL:quarterly` | JSON           | 24h                                |
| `ticker:prices:AAPL:1Y`            | JSON           | 1h                                 |
| `user:watchlist:<uid>`             | JSON (tickers) | 5m                                 |

Postgres is the durable layer; Redis is a speed lane. On Redis miss, always check Postgres before calling a provider. On cron-driven refresh, write to both.

## Database schema

Drizzle ORM, Neon Postgres. RLS enabled on user-scoped tables, using JWT claims set per-connection from Stack Auth.

```sql
-- Identity lives in Stack Auth (external service). We do NOT have a foreign-key
-- relationship to a users table in this database. The `user_id` column on
-- `watchlist` and `notes` is the Stack Auth user id (uuid). It is enforced at
-- the application layer + RLS, not by a database FK.

companies (
  ticker            text primary key,
  name              text not null,
  cik               text,                -- nullable; set by Slice 2 EDGAR ingest
  exchange          text,
  sector            text,
  industry          text,
  is_seed           boolean not null default false,
  first_ingested_at timestamptz not null default now(),
  last_refreshed_at timestamptz,
  source            text not null default 'financial_datasets'
);

snapshots (
  ticker          text primary key references companies(ticker) on delete cascade,
  price           numeric(18,4),
  market_cap      numeric(20,2),
  week52_high     numeric(18,4),
  week52_low      numeric(18,4),
  pe              numeric(10,4),
  ps              numeric(10,4),
  pb              numeric(10,4),
  ev_ebitda       numeric(10,4),
  peg             numeric(10,4),
  as_of           timestamptz not null,
  fetched_at      timestamptz not null default now(),
  source          text not null
);

-- Tall shape so new line items don't require migrations.
fundamentals (
  ticker          text not null references companies(ticker) on delete cascade,
  period_end      date not null,
  period_type     text not null,         -- 'annual' | 'quarterly'
  statement_type  text not null,         -- 'income' | 'balance' | 'cash_flow'
  line_item       text not null,         -- 'revenue', 'gross_profit', ...
  value           numeric(20,2),
  currency        text not null default 'USD',
  fetched_at      timestamptz not null default now(),
  source          text not null,
  primary key (ticker, period_end, period_type, statement_type, line_item)
);
create index on fundamentals (ticker, statement_type, period_type, period_end desc);

prices (
  ticker          text not null references companies(ticker) on delete cascade,
  date            date not null,
  open            numeric(18,4),
  high            numeric(18,4),
  low             numeric(18,4),
  close           numeric(18,4) not null,
  adj_close       numeric(18,4),
  volume          bigint,
  source          text not null,
  primary key (ticker, date)
);

earnings (
  ticker          text not null references companies(ticker) on delete cascade,
  period_end      date not null,
  reported_date   date,
  eps_actual      numeric(10,4),
  price_1d_pct    numeric(10,6),
  price_5d_pct    numeric(10,6),
  source          text not null,
  fetched_at      timestamptz not null default now(),
  primary key (ticker, period_end)
);

-- user_id is the Stack Auth user uuid. No FK (Stack Auth users live elsewhere).
-- ON DELETE CASCADE is not possible without a referenced row; instead, a
-- Stack Auth webhook (Slice 4) can clean up rows when a user is deleted.
watchlist (
  user_id    uuid not null,
  ticker     text not null references companies(ticker) on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (user_id, ticker)
);
create index on watchlist (user_id, added_at desc);

notes (
  user_id    uuid not null,
  ticker     text not null references companies(ticker) on delete cascade,
  body       text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, ticker)
);

-- Operational observability; grows into Slice 2-4 ingestion monitor.
refresh_runs (
  id              bigserial primary key,
  ticker          text not null references companies(ticker) on delete cascade,
  kind            text not null,         -- 'snapshot' | 'financials' | 'prices' | 'earnings'
  started_at      timestamptz not null default now(),
  completed_at    timestamptz,
  ok              boolean,
  source_used     text,
  error           text
);
create index on refresh_runs (ticker, started_at desc);
```

RLS policies use a session-local setting `request.jwt.claim.sub` that the application sets via `SET LOCAL` at the start of each user-scoped DB transaction. The value comes from `stackServerApp.getUser()` server-side. Two database roles:

- `authenticated` — granted to a Neon role used by web requests; subject to RLS.
- `service_role` — granted to the role used by cron and server-side ingestion; bypasses RLS via `BYPASSRLS` attribute.

Helper function used in policies:

```sql
create or replace function current_user_id() returns uuid as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$ language sql stable;
```

Policies:

```sql
-- User-owned tables: users see only their own rows.
alter table watchlist enable row level security;
create policy "own watchlist read"  on watchlist for select using (user_id = current_user_id());
create policy "own watchlist write" on watchlist for all    using (user_id = current_user_id())
                                                         with check (user_id = current_user_id());

alter table notes enable row level security;
create policy "own notes read"  on notes for select using (user_id = current_user_id());
create policy "own notes write" on notes for all    using (user_id = current_user_id())
                                                  with check (user_id = current_user_id());

-- Reference data: any signed-in user can read; writes happen only via the
-- service_role connection, which bypasses RLS.
alter table companies     enable row level security;
alter table snapshots     enable row level security;
alter table fundamentals  enable row level security;
alter table prices        enable row level security;
alter table earnings      enable row level security;
alter table refresh_runs  enable row level security;

create policy "auth read companies"    on companies    for select to authenticated using (true);
create policy "auth read snapshots"    on snapshots    for select to authenticated using (true);
create policy "auth read fundamentals" on fundamentals for select to authenticated using (true);
create policy "auth read prices"       on prices       for select to authenticated using (true);
create policy "auth read earnings"     on earnings     for select to authenticated using (true);
-- refresh_runs intentionally has no policy for authenticated; only service_role reads it.
-- No INSERT/UPDATE/DELETE policies means writes require the service_role connection.
```

Application binding: every server route that handles an authenticated request must run inside a transaction that begins with `SET LOCAL request.jwt.claim.sub = <user_id>` before any user-scoped query. A helper `withUserContext(userId, fn)` in `lib/db/client.ts` encapsulates this so individual services don't have to remember.

Schema notes:

- The `fundamentals` table uses a tall shape (one row per line item) so Slice 2 and 3 can add line items without migrations.
- No prices rollup view in Slice 1. The 1Y sparkline and 5Y revenue chart both query small enough ranges that raw rows are fine. Add weekly/monthly materialized views when measured to be slow.
- `refresh_runs` is overkill for Slice 1 alone but earns its place because the cron handler in Slice 1 grows into the ingestion observability layer in Slices 2-4.
- No `users` table in this database; Stack Auth holds identity. The `user_id` columns are unenforced uuids — application-level checks plus RLS provide safety. A Stack Auth webhook in Slice 4 will clean up orphaned rows on user deletion.

## Error handling, rate limits, and security

### Error taxonomy

Provider adapters map wire errors to one of these:

```ts
class NotFoundError        extends Error {}  // provider 404 → ticker doesn't exist
class RateLimitError       extends Error {}  // 429 → trigger fallback
class ProviderError        extends Error {}  // 5xx → trigger fallback
class ValidationError      extends Error {}  // 4xx ≠ 429 → bubble; user-facing
class UnknownProviderError extends Error {}
```

API layer maps these to HTTP:

| Internal error                                                | HTTP | Body                                |
| ------------------------------------------------------------- | ---- | ----------------------------------- |
| `NotFoundError`                                               | 404  | `{ error: "Ticker not found" }`     |
| `ValidationError`                                             | 400  | `{ error: <message> }`              |
| `RateLimitError` / `ProviderError` after fallback also failed | 503  | with `Retry-After` header           |
| Anything else                                                 | 500  | generic message; full stack logged  |

### Rate limits

- **Financial Datasets free tier:** token-bucket in the adapter, conservatively 10 req/min. Bucket lives in Redis so cron and on-demand share quota.
- **yfinance:** unofficial, no documented RPS. Throttle to 30 req/min in the Python function to avoid IP blocking.
- **`/api/tickers/add` per-user:** 10/min, Redis counter keyed by `user_id`. Prevents a single user from torching the FD quota.

### Cron handler hardening

- `Authorization: Bearer ${CRON_SECRET}` required. In Slice 1 the local `scripts/refresh-local.ts` reads `CRON_SECRET` from `.env.local` and sets the header; after deploy, Vercel Cron sends it automatically. Unauthenticated calls are rejected.
- Idempotent: each ticker × kind run records a `refresh_runs` row and skips if there's an `ok=true` row inside the TTL window. Re-running is safe.
- Sequential per provider, parallel across providers — under FD's RPS without wasting wall-clock time.
- Hard 50s timeout (Vercel Cron Hobby limit is 60s). If a run can't finish all watchlisted tickers, it records progress and the next run picks up ordered by `last_refreshed_at asc`.

### Cron schedule

The handler accepts a `kind` query param so a single endpoint serves multiple schedules:

| Schedule                          | `kind`         | Cadence                                                       |
| --------------------------------- | -------------- | ------------------------------------------------------------- |
| Prices for watchlisted tickers    | `prices`       | Hourly during US market hours (Mon-Fri 9:30-16:00 ET)         |
| Snapshot multiples for watchlist  | `snapshot`     | Every 4 hours during market hours                             |
| Fundamentals + earnings for watchlist | `fundamentals` | Nightly at 02:00 ET                                       |

In Slice 1, `scripts/refresh-local.ts` invokes each kind on a developer-triggered basis (no real scheduler). After Vercel deploy, `vercel.json` declares the cron entries.

### Auth and secrets

- Stack Auth with email+password and Google OAuth in Slice 1. Magic links deferred to Slice 4.
- `@stackframe/stack` SDK with App Router integration; session cookie handled by Stack's middleware.
- Server-side: every user-scoped route opens a DB transaction and sets `request.jwt.claim.sub` to the Stack user id via the `withUserContext` helper. The transactional connection uses an `authenticated` Postgres role subject to RLS.
- Cron and provider/ingestion code uses a separate `service_role` Postgres role with `BYPASSRLS` — server-only, never shipped to the client.
- Env vars documented in `.env.example`:
  ```
  DATABASE_URL                            # Neon connection string (authenticated role)
  DATABASE_URL_SERVICE_ROLE               # Neon connection string (service_role, BYPASSRLS)
  NEXT_PUBLIC_STACK_PROJECT_ID
  NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY
  STACK_SECRET_SERVER_KEY
  FINANCIAL_DATASETS_API_KEY
  UPSTASH_REDIS_REST_URL
  UPSTASH_REDIS_REST_TOKEN
  CRON_SECRET
  ```

### Observability (Slice 1 only)

- Structured logs via `pino`, with `ticker`, `kind`, `source`, `duration_ms` fields. Goes to stdout → local terminal in dev; Vercel logs in prod.
- `refresh_runs` table queryable as a poor-man's dashboard.
- `/api/health` endpoint pings Supabase, Redis, and FD with 1s timeouts each. Useful for cron sanity and future uptime checks.

### Disclaimers UI

"Not investment advice" footer on every page. No buy/sell language in copy. This is a Slice 1 concern, not a Slice 4 polish item — easier to get right at the start than retrofit.

## Testing strategy

Three layers, weighted toward unit.

### Unit — `lib/compute/*` and provider adapters

Most tests live here.

- **`compute/multiples.ts`** — P/E, P/S, P/B, EV/EBITDA, PEG. Test known good values; edge cases: negative earnings, zero book value, missing inputs (return `null`, never `NaN`).
- **`compute/growth.ts`** — YoY and CAGR. Sign correctness, division by zero, partial-period handling.
- **`compute/returns.ts`** — ROE, ROA, ROIC. Same pattern.
- **`providers/financial-datasets.ts` and `providers/yfinance.ts`** — fixture-driven. Real responses snapshotted to `__fixtures__/`; tests cover the mapping. No network calls.
- **Backoff/retry logic** — fake timers; assert attempt counts and delays.

Tool: **Vitest**.

### Integration — services + cache + DB

One test database per CI run. Drizzle migrations applied fresh. Tests seed their own rows.

- **Service cache behavior** — Redis miss + Postgres hit returns cached, doesn't call provider. Redis miss + Postgres stale calls provider and writes both. Provider failure + Postgres fresh degrades gracefully to Postgres.
- **Fallback path** — mock FD to throw `RateLimitError`; assert yfinance is called and persisted row has `source='yfinance'`.
- **RLS enforcement** — open a transaction as user A (via `withUserContext(userA, ...)`), insert a watchlist row, then open a transaction as user B and assert the row is invisible. The helper sets `request.jwt.claim.sub` for the transaction; the `current_user_id()` function reads it inside RLS policies. Test user ids are just freshly-generated uuids — Stack Auth doesn't need to be involved for RLS tests since the policy only consults the local setting. Critical because RLS bugs are silent.
- **Cron idempotency** — run the handler twice in a row; assert provider is called once.

Tool: **Vitest** against a dedicated Neon test branch in CI; same locally — every developer runs against their own Neon branch (free tier supports many branches).

### End-to-end — happy paths only

Three Playwright tests:

1. Signup → login → empty watchlist visible.
2. Add ticker → ingest progress → land on `/stock/TSLA` → snapshot card renders.
3. Open a watchlisted seed ticker → switch to quarterly in financials tab → chart updates.

Hits a hosted test Supabase project. FD responses for seed tickers + TSLA recorded and replayed (HAR or MSW). E2E does not hit the real FD API on every run.

### Explicitly not tested in Slice 1

- Visual regression (UI is functional-first; no visual contract yet).
- Performance benchmarks (premature; add when something measurably slow surfaces).
- Cross-browser (Chromium only).
- Load testing on the cron handler (one user in Slice 1; size when it matters).

### CI shape

GitHub Actions, one workflow:

1. `eslint` + `prettier --check`
2. `tsc --noEmit`
3. Unit tests (Vitest)
4. Integration tests (Vitest + ephemeral Neon branch per CI run)
5. E2E (Playwright, ephemeral Vercel preview backed by a Neon preview branch)

Steps 1–4 on every push. Step 5 on PRs to `main`.

## Success criteria

Slice 1 is complete when:

1. A new user can sign up, log in, see an empty watchlist, and add TSLA, with the dashboard rendering snapshot + financials inside 5 seconds of clicking "Add."
2. All 10 seed tickers render `/stock/[ticker]` with both the snapshot card and the financials tab populated, Redis-warm, in under 300ms.
3. The yfinance fallback fires correctly when FD is throttled (verified via integration test).
4. Notes persist per user and per ticker and survive logout/login.
5. Nightly cron run completes successfully against all watchlisted tickers and writes `refresh_runs` rows.
6. RLS prevents user A from reading user B's watchlist or notes (verified via integration test).
7. All tests in steps 1–4 of the CI workflow pass on `main`.

## Open questions deferred to implementation

- Specific FD free-tier RPS limit (verify against current docs during implementation; size token bucket accordingly).
- Exact Drizzle vs Prisma decision (leaning Drizzle for lighter serverless footprint; final call when scaffolding).
- Whether to use shadcn's `<DataTable>` for the financials table or hand-roll (depends on column count, freezing, sticky headers).
- Whether the cron handler shells out to a separate Edge function for FD rate-limit isolation, or stays in the main route handler (defer until we measure cold-start cost).
- Whether to use Neon's `neon serverless` driver or plain `postgres-js` over TCP. The serverless driver is faster from Vercel Edge but only over HTTP. For Slice 1 (Node-runtime route handlers), `postgres-js` is simpler. Reassess in Phase 1B.

These are implementation-time decisions, not design-time decisions.

## Out of scope for Slice 1 (recap)

LLM features, EDGAR ingestion, DCF widgets, peer comparisons, consensus EPS, price alerts, admin dashboard, Bloomberg-aesthetic polish, keyboard shortcuts, mobile optimization, Vercel deployment.

Each is queued for the slice indicated in "Context and scope" above.
