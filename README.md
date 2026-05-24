# Equity Research Workbench

Single-pane research dossier for any US-listed equity. Snapshot, financials, watchlist, notes.

## Stack

- **Next.js 14** (App Router) + **TypeScript** strict
- **Neon Postgres** (with row-level security) + **Drizzle ORM**
- **Stack Auth** (email/password + OAuth)
- **Upstash Redis** (hot cache)
- **Financial Datasets API** (primary data) + **yfinance** fallback (currency-normalized for ADRs)
- **Tailwind CSS** + **shadcn/ui** + **Recharts**
- **Vitest** (unit + integration), **Playwright** (E2E)
- **Vercel** (deploy + cron)

## Local development

### Prerequisites

- Node 22+ and pnpm 11+
- Python 3.12+ (for the yfinance fallback)
- A free-tier account at: [Neon](https://neon.tech), [Stack Auth](https://stack-auth.com), [Upstash](https://upstash.com), [Financial Datasets](https://financialdatasets.ai)

### Setup

```bash
git clone https://github.com/Traaa1234/equity-research-workbench
cd equity-research-workbench
pnpm install
pip install -r scripts/requirements.txt
cp .env.example .env.local
# fill in .env.local with your provider keys — see "Provisioning" below
pnpm dev
# visit http://localhost:3000
```

### Provisioning

#### Neon (Postgres)

1. Create a project (any region)
2. From "Connection Details" copy the connection string → `DATABASE_URL`
3. In SQL editor:
   ```sql
   create role service_role with login password '<generate one>' bypassrls;
   create role authenticated nologin;
   grant connect on database neondb to service_role, authenticated;
   grant usage on schema public to authenticated;
   alter default privileges in schema public grant all on tables to service_role;
   alter default privileges in schema public grant all on sequences to service_role;
   alter default privileges in schema public grant select on tables to authenticated;
   grant authenticated to current_user;
   ```
4. Build `DATABASE_URL_SERVICE_ROLE` by swapping the username in `DATABASE_URL` to `service_role` and password to the one you set
5. Apply Drizzle schema: `pnpm db:generate && pnpm exec drizzle-kit push --force`
6. Apply RLS: paste the contents of `lib/db/migrations/9999_rls_policies.sql` into Neon's SQL editor and run
7. Create a second branch in Neon named `test`; repeat the role setup against it; save URLs as `DATABASE_URL_TEST` + `DATABASE_URL_TEST_SERVICE_ROLE` (integration tests run against the test branch so they don't wipe prod data)

#### Stack Auth

Create a project at https://stack-auth.com → API Keys → copy the three keys (`NEXT_PUBLIC_STACK_PROJECT_ID`, `NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY`, `STACK_SECRET_SERVER_KEY`) into `.env.local`.

#### Upstash

Create a free Redis database → REST API tab → copy URL + token into `.env.local`.

#### Financial Datasets

Sign up at https://financialdatasets.ai (free tier) → copy API key → `FINANCIAL_DATASETS_API_KEY`.

#### Generate `CRON_SECRET`

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

### Useful commands

```bash
pnpm dev                                       # dev server
pnpm test                                      # unit tests
pnpm test:integration                          # integration tests (against test Neon branch)
pnpm test:e2e                                  # Playwright tests (requires dev server running)
pnpm seed                                      # seed companies + initial fetch for 10 seed tickers
pnpm try AAPL                                  # smoke-test one ticker end-to-end
pnpm typecheck
pnpm lint
pnpm build
pnpm exec tsx scripts/refresh-local.ts snapshot     # manually trigger cron locally
pnpm exec tsx scripts/refresh-local.ts fundamentals
pnpm exec tsx scripts/refresh-local.ts prices
```

## Deploy

This project deploys to Vercel.

1. Import the GitHub repo at https://vercel.com → "Add New" → "Project"
2. Framework preset: Next.js (auto-detected)
3. Add all environment variables from `.env.local` **except** `DATABASE_URL_TEST*` (those are CI/local-test only)
4. Deploy

Cron schedules are declared in `vercel.json` and auto-register. Visit your-deploy-url/api/cron/jobs (Vercel dashboard) to confirm three schedules: prices (every 30min during US market hours), snapshot (3x daily during market hours), fundamentals (nightly 06:00 UTC).

## Architecture

```
UI (RSC + client islands)
   ↓
Service layer (lib/services/*)         — business logic, picks data source
   ↓
Cache layer (lib/cache/*)              — Redis hot, Postgres cold
   ↓
Provider adapters (lib/providers/*)    — Financial Datasets adapter, yfinance adapter
   ↓
External APIs
```

UI talks only to services. Services orchestrate cache + provider with fallback. RLS enforces per-user data isolation at the database layer via `current_user_id()` reading a session-local JWT claim that `withUserContext()` sets per transaction.

See `docs/superpowers/specs/` for the full design and `docs/superpowers/plans/` for the build plans.

## License

Private. Not for distribution.
