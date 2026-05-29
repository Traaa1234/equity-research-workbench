# Natural-Language Ticker Discovery — Design Spec

> **Status:** Design complete.
> **Date:** 2026-05-29
> **Owner:** Equity Research Workbench

---

## Goal

Let the user type a free-form description like *"AI infrastructure"* / *"Brazilian CPG on US exchanges"* / *"Chinese internet ADRs"* and get a ranked list of relevant tickers from a curated 6,000–7,000-company universe. Standalone `/discover` page; clicking a ticker opens the existing `/stock/[ticker]` overview.

## Non-goals

- **Watchlist integration.** No "Add to watchlist" button on discovery rows. The existing add-ticker flow on `/stock/[ticker]` is one click away.
- **Real-time / streaming results.** Server-rendered page; submit triggers a fresh render.
- **Saved searches / alerts on new matches.** Separate feature.
- **"Similar to this ticker" reverse search.** Deferred.
- **ADR vs ordinary distinction.** We surface country-of-origin + exchange; the "is this an ADR?" question stays implicit.
- **ESG, climate, ownership-overlay filters.** Pure description-based discovery only.
- **Industry sub-classifications beyond yfinance defaults.**

## User value

Until this slice, the workbench only helps you analyze tickers you already know about. Discovery turns it into a tool for *finding* new tickers worth analyzing. The three queries you gave during brainstorming represent three distinct use cases:

- **Theme search** ("AI infrastructure"): a concept that cuts across multiple sectors. Semantic embedding match against company descriptions captures companies whose business is the concept, not just companies whose stated sector contains the word.
- **Geography + sector intersect** ("Brazilian CPG on US exchanges"): a structured filter (country = Brazil) combined with a sector concept. SQL prefilter narrows the universe, semantic search ranks within.
- **Geography + theme** ("Chinese internet ADRs"): country filter + theme — same hybrid mechanism.

The slice ships when typing all three queries returns sensible top-5 results.

## Architecture

```
                  Universe build (offline / scripts/seed-universe.ts)
                  ┌────────────────────────────────────────────────────┐
                  │  1. Fetch NYSE listed-companies from Nasdaq API    │
                  │  2. Fetch Nasdaq listed-companies                  │
                  │  3. Fetch thematic-ETF holdings                    │
                  │     (BOTZ, KWEB, EWZ, ARKK, SOXX, …)               │
                  │  4. Merge + dedupe by ticker                       │
                  │  5. For each ticker → yfinance .info               │
                  │     (longBusinessSummary, country, sector,         │
                  │      industry, exchange, marketCap)                │
                  │  6. Embed description with Qwen (1024d)             │
                  │  7. Upsert into companies_universe                 │
                  └────────────────────────────────────────────────────┘
                                       │
                                       ▼
                  ┌────────────────────────────────────────────────────┐
                  │  companies_universe (NEW table)                    │
                  │  RLS: authenticated SELECT, service-role writes    │
                  └────────────────────────────────────────────────────┘
                                       │
                                       │  (read at query time)
                                       ▼
                  ┌────────────────────────────────────────────────────┐
                  │  Query path                                        │
                  │                                                    │
                  │  user types: "Brazilian CPG on US exchanges"       │
                  │                  │                                 │
                  │  Step 1: parseQuery (Qwen)                         │
                  │   → { country:'BR', sector:'Consumer Defensive',   │
                  │      exchanges:['NYSE','NASDAQ'],                  │
                  │      conceptText:'consumer packaged goods', ... }  │
                  │                  │                                 │
                  │  Step 2: SQL prefilter                             │
                  │   WHERE country = 'BR' AND exchange IN (...)       │
                  │   → ~30 candidates                                 │
                  │                  │                                 │
                  │  Step 3: embed conceptText (Qwen)                  │
                  │                  │                                 │
                  │  Step 4: pgvector cosine search over candidates    │
                  │                  │                                 │
                  │  Step 5: return DiscoverResult[] with similarity   │
                  └────────────────────────────────────────────────────┘
                                       │
                                       ▼
                  /watchlist?tab=discover&q=... server-rendered page
```

**Reuses from prior slices:**
- `QwenProviderImpl` (Slice 2B) — embedding + LLM parsing
- `EmbeddingsService` (Slice 2C) — batch embed wrapper
- `pgvector` + custom Drizzle `vector()` column (Slice 2C)
- `api/fallback/yfinance.py` Python serverless (Phase 1C M7) — add `kind=info` handler

**Why a separate `companies_universe` table** (not extending `companies`):
- `companies` is the user's watchlist scope (~6 rows, has refresh state).
- `companies_universe` is the read-only discovery scope (~6500 rows, refreshed monthly).
- Different access patterns and lifecycles. Keeps existing watchlist code untouched.

## Schema

```ts
import { pgTable, text, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { vector } from './schema-helpers';      // custom column from Slice 2C

export const companiesUniverse = pgTable(
  'companies_universe',
  {
    ticker: text('ticker').primaryKey(),
    name: text('name').notNull(),
    exchange: text('exchange'),                        // 'NYSE' | 'NASDAQ' | other
    country: text('country'),                          // ISO 2-letter code
    sector: text('sector'),                            // yfinance categorical
    industry: text('industry'),                        // yfinance categorical
    description: text('description'),                  // longBusinessSummary
    descriptionEmbedding: vector('description_embedding', { dimensions: 1024 }),
    marketCap: numeric('market_cap', { precision: 20, scale: 2 }),
    sources: text('sources').array(),                  // ['nyse','nasdaq','etf:BOTZ']
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    descriptionEmbeddingIdx: index('cu_description_embedding_hnsw_idx')
      .using('hnsw', t.descriptionEmbedding.op('vector_cosine_ops')),
    countryIdx: index('cu_country_idx').on(t.country),
    exchangeIdx: index('cu_exchange_idx').on(t.exchange),
    sectorIdx: index('cu_sector_idx').on(t.sector)
  })
);
```

**Invariants:**
- `ticker` is the natural primary key. Upserts on re-seed.
- `description_embedding` nullable (some tickers' yfinance lookup returns no description).
- `sources` is a Postgres text array — a single ticker can appear in NYSE + ETF lists, and we want to know.
- HNSW index for fast ANN — but at query time we prefilter first, then exact-search the small remainder.

**RLS migration** `9991_rls_companies_universe.sql`: authenticated SELECT, service-role writes. Same pattern as other RLS migrations.

**Applied to both Neon branches via `_apply.ts`.** Never `drizzle-kit push --force`.

## Universe ingestion — `scripts/seed-universe.ts`

One-shot script, re-runnable monthly. Four phases.

### Phase 1 — Skeleton from listed-companies sources

**Nasdaq screener API** (public): `GET https://api.nasdaq.com/api/screener/stocks?download=true&exchange=NASDAQ`. Returns JSON with rows containing `{ symbol, name, country, sector, industry, marketCap, lastsale, ... }`. Repeat for `exchange=NYSE`. Combined ~6,300 rows.

**Thematic ETFs** — for each curated ETF, fetch holdings via the issuer's public CSV:
- **iShares** (BOTZ, KWEB, EWZ, EFA, IBB, ITA): `https://www.ishares.com/us/products/{product-id}/{slug}/1467271812596.ajax?fileType=csv&fileName={ticker}_holdings&dataType=fund`
- **ARK** (ARKK, ARKQ, ARKW, ARKG): `https://ark-funds.com/wp-content/uploads/funds-etf-csv/ARK_INNOVATION_ETF_ARKK_HOLDINGS.csv`
- **State Street** (XLK, XLF, XLY, XLV): `https://www.sectorspdrs.com/sectorspdr/IDCO.Client.Spdrs.Holdings/Export/ExcelExport?symbol={ticker}`
- **VanEck** (SMH, SOXX): public CSV

Per ETF: parse CSV/JSON, extract ticker symbols, add to the seed list with `sources = [..., 'etf:BOTZ']`.

Curated initial ETF list (12 ETFs covering AI/robotics/semis/China/Brazil/biotech/defense):
`BOTZ, KWEB, EWZ, ARKK, ARKQ, ARKW, ARKG, SOXX, SMH, XLK, XBI, ITA`.

Merge by ticker (uppercased). Sources field accumulates: `['nyse', 'etf:SOXX', 'etf:SMH']` for a chip name.

### Phase 2 — yfinance enrichment

For each ticker, call our Python serverless: `GET /api/fallback/yfinance?kind=info&ticker=X`. Returns `{ longBusinessSummary, country, sector, industry, exchange, marketCap }`.

**Add `kind=info` handler to `api/fallback/yfinance.py`** — the handler calls `yf.Ticker(ticker).info` and returns the dict, filtered to the fields we want. Existing rate-limiter applies.

Local crawl uses subprocess mode (existing pattern); not via deployed serverless. ~6,500 tickers × ~0.5s = ~30 min. Failures (delisted, malformed) get a warn log and skip — script continues. Idempotent re-run picks up missing ones.

### Phase 3 — Embed descriptions

For each enriched row where `description` is non-empty, batch-embed via `QwenProviderImpl.embedBatch(texts, dimensions=1024)`. Batch size 32. ~200 batches; ~3 min. Embeddings are 1024-d float arrays matching the schema column.

### Phase 4 — Upsert

Bulk `INSERT ... ON CONFLICT (ticker) DO UPDATE` keyed on ticker. Updates `lastRefreshedAt`. Old rows that fell off the source lists (delisted) stay in the DB — manual cleanup out of scope.

**Script entry** `pnpm seed-universe`. Logs progress every 100 tickers: counts skeleton/enriched/embedded so far.

## Query parsing — `lib/services/discover.ts` `parseQuery`

```ts
export interface ParsedQuery {
  country: string | null;          // ISO 2-letter
  sector: string | null;
  industry: string | null;
  exchanges: string[];             // [] = no constraint
  conceptText: string;             // remainder for semantic search
  marketCapMin: number | null;
  marketCapMax: number | null;
}
```

LLM prompt is locked v1 at `lib/services/discover-prompts.ts`:

```
You parse free-form stock-discovery queries into structured filters.

INPUT: "{user_text}"

Return JSON with these fields (use null when not specified):
- country: ISO 2-letter code (BR, CN, US, IN, JP, GB, DE, …)
- sector: one of [Technology, Healthcare, Financial Services, Consumer Cyclical,
  Consumer Defensive, Communication Services, Industrials, Energy, Basic Materials,
  Real Estate, Utilities]
- industry: yfinance industry string if recognized
- exchanges: array of ['NYSE','NASDAQ'] (default empty = no constraint)
- conceptText: what's left after extracting structured filters. Always a string.
- marketCapMin / marketCapMax: in USD, nullable

EXAMPLES:
"AI infrastructure" → {country:null, sector:'Technology',
                       conceptText:'AI infrastructure', ...}
"Brazilian CPG on US exchanges" → {country:'BR', sector:'Consumer Defensive',
                                    exchanges:['NYSE','NASDAQ'],
                                    conceptText:'consumer packaged goods', …}
"Chinese internet ADRs" → {country:'CN', sector:'Technology',
                            exchanges:['NYSE','NASDAQ'],
                            conceptText:'internet company ADR', …}

Return ONLY valid JSON. No prose.
```

Output validated against Zod schema. On parse failure, fall back to `conceptText = full input, all filters null`. Query never fails because the LLM hallucinated.

Cached in Redis 5 min keyed by normalized query text.

## Search execution — `lib/services/discover.ts` `search`

```ts
async function search(query: string, limit = 20): Promise<DiscoverResult[]>
```

Steps:
1. `parsed = await parseQuery(query)`.
2. **SQL prefilter** — single SELECT with WHERE clauses for each non-null parsed field. Returns candidate set.
3. **Embed `conceptText`** with Qwen (1024-d), cached 5 min in Redis.
4. **Vector search over the candidate set** via raw `sql` template:
   ```sql
   SELECT ticker, name, exchange, country, sector, industry, description, market_cap,
          1 - (description_embedding <=> $1) AS similarity
   FROM companies_universe
   WHERE description_embedding IS NOT NULL
     AND country = $2                  -- when parsed.country is non-null
     AND sector = $3                   -- when parsed.sector is non-null
     AND exchange = ANY($4)            -- when parsed.exchanges is non-empty
     AND market_cap >= $5              -- when parsed.marketCapMin is non-null
     AND market_cap <= $6              -- when parsed.marketCapMax is non-null
   ORDER BY description_embedding <=> $1
   LIMIT $7;
   ```
   Drizzle expresses the vector operator via `sql\`...\`` template since it's not in Drizzle's DSL.
5. If the prefilter yields zero rows (e.g. "Iranian fintech"), fall back to full-universe vector search and surface a UI hint `"no exact country match, showing closest concept matches"`.

**Why prefilter then exact-search rather than ANN + post-filter:** HNSW indexes don't compose cleanly with structured WHERE clauses (pgvector's documented limitation). For filtered sets under ~1000 rows, exact search is faster and more accurate. Typical filtered set is 50-500.

## API route — `app/api/discover/route.ts`

`POST /api/discover`. Body: `{ query: string; limit?: number }`. Returns `{ parsed: ParsedQuery; results: DiscoverResult[] }`.

- Auth: `requireUserId()`.
- Rate limit: **30/hour/user** (each query is one LLM parse + one embedding + a small vector search; cap is generous but bounded).
- Validation: query must be 1-500 chars, limit must be 1-100, defaults to 20.
- Errors via the standard `errorResponse` helper.

## UI

New tab on `<WatchlistTabs>`. Final order: **Roll-up · List · Discover · Search · Ask** (5 tabs).

### Page — `app/(app)/watchlist/discover/page.tsx`

Server component. Reads `?q=` from search params:
- No `q` → render input + `<DiscoverEmptyState>` with 4 clickable example queries.
- `q` set → call `DiscoverService.search(q)` server-side, render the parsed-filter summary + results list.

The page is rendered inside the existing `/watchlist` layout (header + tab nav) — this is a route nested under `/watchlist`, not a separate top-level route, so the tabs visually persist. Implementation note: in App Router, nested folders inherit layouts. Confirm the `(app)/watchlist/layout.tsx` (or `page.tsx` shared shell) renders tabs around `{children}`.

### Components

`app/(app)/watchlist/discover/_components/`:

- **`<DiscoverInput>`** (client). Controlled `<input>` + submit button. On submit, `router.push('/watchlist?tab=discover&q=' + encodeURIComponent(text))`.
- **`<DiscoverFilterSummary>`** (server). Shows parsed filters as small chips: Country / Sector / Industry / Exchanges / Market-cap range. Helps the user see what the LLM interpreted.
- **`<DiscoverResultRow>`** (server). One row per result. Layout:
  ```
  TICKER   Company Name                                  🇺🇸 Sector
   1-sentence description (truncated to ~120 chars)            96%  →
  ```
  Ticker is a `<Link>` to `/stock/[ticker]`. Right-arrow = visual affordance only.
- **`<DiscoverEmptyState>`** (server). Shown when no `q` param yet. Includes a brief intro and 4 example queries the user can click ("AI infrastructure" / "Brazilian CPG on US exchanges" / "Chinese internet ADRs" / "small-cap healthcare AI"). Each click pushes the URL.
- **`lib/compute/country-flags.ts`** — tiny pure module: `flagFor(code: string | null): string` returns the emoji flag, falls back to the code string.

### Tab nav

`<WatchlistTabs>` gets a `'discover'` entry positioned between `'list'` and `'search'`:

```tsx
export type WatchlistTab = 'rollup' | 'list' | 'discover' | 'search' | 'ask';
```

## File structure

| File | Action |
|---|---|
| `lib/db/schema.ts` | Modify — add `companiesUniverse` |
| `lib/db/migrations/<auto>.sql` | Generated (Drizzle) |
| `lib/db/migrations/9991_rls_companies_universe.sql` | Create |
| `lib/compute/country-flags.ts` | Create |
| `lib/services/discover-prompts.ts` | Create |
| `lib/services/discover.ts` | Create |
| `api/fallback/yfinance.py` | Modify — add `kind=info` handler |
| `app/api/discover/route.ts` | Create |
| `scripts/seed-universe.ts` | Create |
| `package.json` | Modify — add `seed-universe` script |
| `app/(app)/watchlist/_components/watchlist-tabs.tsx` | Modify — add `'discover'` |
| `app/(app)/watchlist/discover/page.tsx` | Create |
| `app/(app)/watchlist/discover/_components/discover-input.tsx` | Create |
| `app/(app)/watchlist/discover/_components/discover-filter-summary.tsx` | Create |
| `app/(app)/watchlist/discover/_components/discover-result-row.tsx` | Create |
| `app/(app)/watchlist/discover/_components/discover-empty-state.tsx` | Create |
| `tests/scripts/seed-universe.test.ts` | Create — 6 tests |
| `tests/services/discover-parse-query.test.ts` | Create — 8 tests |
| `tests/integration/discover-service.test.ts` | Create — 6 tests |
| `tests/integration/api-discover.test.ts` | Create — 3 tests |
| `tests/integration/companies-universe-rls.test.ts` | Create — 2 tests |
| `tests/compute/country-flags.test.ts` | Create — 2 tests |

17 new files, 4 modifications.

## Testing matrix

| Layer | Test file | Coverage |
|---|---|---|
| Universe seeder | `tests/scripts/seed-universe.test.ts` | Mock Nasdaq screener + Python yfinance + Qwen embed. Assert merge/dedupe, source-array preservation, upsert calls, batch size. 6 tests. |
| Parser | `tests/services/discover-parse-query.test.ts` | Mock Qwen. 8 fixture queries spanning examples + edge cases (empty input, gibberish, mixed-language). 8 tests. |
| Service | `tests/integration/discover-service.test.ts` | Seed test DB with 30 fake companies (3 countries × 3 sectors), deterministic embeddings, assert prefilter narrows + vector ranking. 6 tests. |
| API | `tests/integration/api-discover.test.ts` | POST happy path, 400 on empty query, 429 rate-limit. 3 tests. |
| RLS | `tests/integration/companies-universe-rls.test.ts` | Authenticated SELECT works, INSERT denied. 2 tests. |
| Compute | `tests/compute/country-flags.test.ts` | Known + unknown codes. 2 tests. |

Net new: ~27 tests.

## Rollout

1. Schema + RLS applied to both Neon branches via `_apply.ts`.
2. Implement everything, push, watch CI green.
3. Run `pnpm seed-universe` against the prod DB — ~30 minutes. Logs every 100 tickers. Expect some yfinance failures (delisted/malformed); script continues, idempotent re-run fills gaps.
4. Verify with `SELECT COUNT(*), COUNT(description_embedding) FROM companies_universe` — expect ~6,000 rows with embeddings.
5. Browser smoke on Vercel with the three sample queries:
   - "AI infrastructure" → NVDA / AVGO / TSM / MU / ARM / ANET / SMCI in top 7
   - "Brazilian CPG on US exchanges" → ABEV / NTCO / KOF (Mexican but adjacent) / others at the top
   - "Chinese internet ADRs" → BABA / JD / PDD / BIDU / NTES / TCEHY in top 6
6. Quality check: click a few result rows → confirm `/stock/[ticker]` opens correctly. For tickers not in the watchlist, the existing add-ticker flow handles ingestion-on-add.

## Risks and mitigations

- **yfinance flakiness on long crawls.** ~6,500 calls; some timeout or return None. Script logs each failure, continues, idempotent re-run picks up gaps.
- **Nasdaq screener API may change.** Public-ish endpoint, no contract. Lock the response shape into Zod; fail loudly with a clear error if shape shifts.
- **ETF holdings sources are heterogeneous.** Each issuer has its own URL pattern. Start with 12 ETFs covering the major themes; one parser per issuer.
- **LLM hallucinations on country codes.** Zod schema validates against ISO whitelist; out-of-range values get nulled out so the query still runs.
- **Slow first query.** First time a novel query runs: ~1.5s for two LLM round-trips. Redis cache makes same-query repeats instant.
- **Zero-prefilter edge case.** Tested explicitly: fall back to full-universe vector search with a UI hint.
- **Scope creep.** This is the biggest slice we've discussed today. Hard "no" to infinite scroll, similar-ticker reverse search, saved searches — all deferred.

## Out of scope (deferred)

- "Similar to this ticker" reverse search
- Saved searches / discovery alerts
- ADR-vs-ordinary listing flag (would require SEC Form F-6 lookups)
- ESG / climate-impact filters
- Insider-buying or 13F overlays on discovery results
- Industry sub-classifications beyond yfinance defaults

## Success criteria

- `pnpm seed-universe` completes in <45 minutes, ingests >5,500 enriched rows with embeddings.
- `/watchlist?tab=discover` shows the search input + empty state by default.
- Each of the three sample queries returns sensible top-5 results.
- The parsed-filter summary correctly identifies country/sector/exchange when present in the query.
- Click-through from a result row to `/stock/[ticker]` works for any universe ticker.
- All tests pass (target ~27 new, existing suite green).
- 5-tab nav renders correctly on `/watchlist`.
