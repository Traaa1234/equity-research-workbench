# Natural-Language Ticker Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/watchlist?tab=discover` — a free-form ticker discovery surface backed by a ~6,500-company universe ingested from NYSE + Nasdaq + thematic ETF holdings and searched via hybrid LLM-parse + pgvector cosine.

**Architecture:** New `companies_universe` table holds enriched company records with 1024-d Qwen embeddings of `longBusinessSummary`. A one-shot seeder script populates the table from public sources. The search service parses user queries via `QwenProvider.summarize` into structured filters, narrows the universe with SQL, then re-ranks with pgvector cosine. Standalone `/watchlist/discover` route renders results server-side.

**Tech Stack:** Next.js 14, TypeScript strict, Drizzle ORM, Postgres/Neon, pgvector + HNSW, Qwen DashScope (existing), Python serverless (existing yfinance wrapper).

**Spec:** `docs/superpowers/specs/2026-05-29-discovery-search-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `lib/db/schema.ts` | Modify | Add `companiesUniverse` table |
| `lib/db/migrations/<auto>.sql` | Generated | DDL |
| `lib/db/migrations/9991_rls_companies_universe.sql` | Create | RLS policy |
| `lib/compute/country-flags.ts` | Create | ISO code → flag emoji |
| `tests/compute/country-flags.test.ts` | Create | 2 unit tests |
| `api/fallback/yfinance.py` | Modify | Add `kind=info` handler |
| `scripts/sec_fetch.py` | (no change) | yfinance lives in different file |
| `lib/providers/yfinance.ts` | Modify | Add `info(ticker)` method |
| `tests/providers/yfinance.test.ts` | Modify | Add 2 tests for `.info()` |
| `lib/services/discover-prompts.ts` | Create | Locked v1 LLM parsing prompt |
| `lib/services/discover.ts` | Create | `DiscoverService` with `parseQuery` + `search` |
| `tests/services/discover-parse-query.test.ts` | Create | 8 unit tests (mocked Qwen) |
| `tests/integration/discover-service.test.ts` | Create | 6 integration tests (test DB) |
| `app/api/discover/route.ts` | Create | POST endpoint |
| `tests/integration/api-discover.test.ts` | Create | 3 API tests |
| `tests/integration/companies-universe-rls.test.ts` | Create | 2 RLS tests |
| `scripts/seed-universe.ts` | Create | One-shot universe ingestion |
| `tests/scripts/seed-universe.test.ts` | Create | 6 unit tests (mocked HTTP) |
| `package.json` | Modify | Add `seed-universe` script |
| `app/(app)/watchlist/_components/watchlist-tabs.tsx` | Modify | Add `'discover'` tab |
| `app/(app)/watchlist/page.tsx` | Modify | Route `?tab=discover` to redirect to nested page |
| `app/(app)/watchlist/discover/page.tsx` | Create | Server-rendered results page |
| `app/(app)/watchlist/discover/_components/discover-input.tsx` | Create | Client search input |
| `app/(app)/watchlist/discover/_components/discover-filter-summary.tsx` | Create | Parsed-filter chips |
| `app/(app)/watchlist/discover/_components/discover-result-row.tsx` | Create | One row per result |
| `app/(app)/watchlist/discover/_components/discover-empty-state.tsx` | Create | Example queries |

20 new files, 5 modifications.

---

## Task 1: Schema — `companies_universe` table + RLS

**Files:**
- Modify: `lib/db/schema.ts`
- Generate: `lib/db/migrations/<auto>.sql` via drizzle-kit
- Create: `lib/db/migrations/9991_rls_companies_universe.sql`

**CRITICAL:** Apply via `_apply.ts` — never `drizzle-kit push --force`.

- [ ] **Step 1.1: Add Drizzle table to `lib/db/schema.ts`**

Append after the existing `institutionalHoldings` table:

```ts
export const companiesUniverse = pgTable(
  'companies_universe',
  {
    ticker: text('ticker').primaryKey(),
    name: text('name').notNull(),
    exchange: text('exchange'),
    country: text('country'),
    sector: text('sector'),
    industry: text('industry'),
    description: text('description'),
    descriptionEmbedding: vector('description_embedding', { dimensions: 1024 }),
    marketCap: numeric('market_cap', { precision: 20, scale: 2 }),
    sources: text('sources').array(),
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

The `vector` custom column already exists at the top of `schema.ts` (it was added in Slice 2C). The `numeric`, `index`, `text`, `timestamp` imports are all already in the file's imports. No new imports needed.

- [ ] **Step 1.2: Generate the Drizzle SQL migration**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm exec drizzle-kit generate
```

Expected: a new `lib/db/migrations/00XX_<name>.sql` containing `CREATE TABLE "companies_universe"` plus the HNSW index + 3 btree indexes. Note the filename.

Inspect the generated SQL — make sure the `description_embedding` column is `vector(1024)` (not a generic JSON or text). If it's wrong, the custom `vector` column type in `schema.ts` isn't applying — investigate before proceeding.

- [ ] **Step 1.3: Create the RLS migration**

Create `lib/db/migrations/9991_rls_companies_universe.sql`:

```sql
-- RLS for the discovery universe: authenticated users read, service role writes.
ALTER TABLE public.companies_universe ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated read companies_universe" ON public.companies_universe;
CREATE POLICY "authenticated read companies_universe"
  ON public.companies_universe FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.companies_universe TO authenticated;
```

- [ ] **Step 1.4: Apply both migrations to both Neon branches**

Substitute the actual filename from Step 1.2:

```bash
pnpm exec tsx _apply.ts --target prod --file lib/db/migrations/<auto-filename>
pnpm exec tsx _apply.ts --target test --file lib/db/migrations/<auto-filename>
pnpm exec tsx _apply.ts --target prod --file lib/db/migrations/9991_rls_companies_universe.sql
pnpm exec tsx _apply.ts --target test --file lib/db/migrations/9991_rls_companies_universe.sql
```

All four must print `Applied ... OK`.

- [ ] **Step 1.5: Verify on both branches**

```bash
pnpm exec tsx -e "
import { config } from 'dotenv'; config({ path: '.env.local' });
import postgres from 'postgres';
for (const [label, url] of [
  ['prod', process.env.DATABASE_URL_SERVICE_ROLE!],
  ['test', process.env.DATABASE_URL_TEST_SERVICE_ROLE!]
] as const) {
  const sql = postgres(url, { prepare: false, max: 1 });
  const cols = await sql\`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'companies_universe' ORDER BY ordinal_position\`;
  console.log(\`\\n\${label.toUpperCase()} companies_universe columns (\${cols.length}):\`);
  for (const c of cols) console.log(\`  \${c.column_name}: \${c.data_type}\`);
  const idx = await sql\`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'companies_universe'\`;
  console.log(\`  indexes: \${idx.length}\`);
  for (const i of idx) console.log(\`    \${i.indexname}\`);
  const pols = await sql\`SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'companies_universe'\`;
  console.log(\`  policies: \${pols.length}\`);
  for (const p of pols) console.log(\`    \${p.policyname}\`);
  await sql.end();
}
process.exit(0);
"
```

Expected: 11 columns + 5 indexes (1 PK + 1 HNSW + 3 btree) + 1 policy on each branch.

- [ ] **Step 1.6: Verify Drizzle is in sync**

```bash
pnpm exec drizzle-kit generate
```

Expected: `No schema changes, nothing to migrate 😴`.

- [ ] **Step 1.7: Commit**

```bash
git add lib/db/schema.ts lib/db/migrations/
git commit -m "$(cat <<'EOF'
feat(schema): companies_universe table + RLS for discovery slice

1024-d Qwen embeddings on description, HNSW cosine index for fast
ANN, btree indexes on country/exchange/sector for the SQL prefilter.
Applied via _apply.ts to both prod + test Neon branches.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `country-flags.ts` utility

**Files:**
- Create: `lib/compute/country-flags.ts`
- Create: `tests/compute/country-flags.test.ts`

Pure compute. Maps ISO 2-letter country codes to flag emoji. Used in `<DiscoverResultRow>` and `<DiscoverFilterSummary>`.

- [ ] **Step 2.1: Write failing tests**

Create `tests/compute/country-flags.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { flagFor } from '@/lib/compute/country-flags';

describe('flagFor', () => {
  it('returns flag emoji for known countries', () => {
    expect(flagFor('US')).toBe('🇺🇸');
    expect(flagFor('BR')).toBe('🇧🇷');
    expect(flagFor('CN')).toBe('🇨🇳');
    expect(flagFor('JP')).toBe('🇯🇵');
    expect(flagFor('GB')).toBe('🇬🇧');
    expect(flagFor('DE')).toBe('🇩🇪');
    expect(flagFor('IN')).toBe('🇮🇳');
    expect(flagFor('TW')).toBe('🇹🇼');
  });

  it('returns the code itself when unknown or null', () => {
    expect(flagFor(null)).toBe('');
    expect(flagFor('XX')).toBe('XX');
    expect(flagFor('')).toBe('');
    expect(flagFor('us')).toBe('🇺🇸');   // case-insensitive
  });
});
```

- [ ] **Step 2.2: Run tests, confirm fail**

```bash
pnpm test -- tests/compute/country-flags.test.ts
```

Expected: 2 tests fail with `Cannot find module '@/lib/compute/country-flags'`.

- [ ] **Step 2.3: Implement `lib/compute/country-flags.ts`**

```ts
/**
 * ISO 2-letter country code → flag emoji.
 * Unicode flag emojis are made of two regional-indicator code points,
 * one per letter. So 'BR' → 🇧🇷 = U+1F1E7 + U+1F1F7.
 *
 * We compute them programmatically for any valid 2-letter code rather
 * than maintaining a hardcoded map.
 */
export function flagFor(code: string | null): string {
  if (!code) return '';
  const upper = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return code;
  const A = 'A'.codePointAt(0)!;
  const REGIONAL_BASE = 0x1f1e6;       // 🇦
  const c1 = String.fromCodePoint(REGIONAL_BASE + (upper.codePointAt(0)! - A));
  const c2 = String.fromCodePoint(REGIONAL_BASE + (upper.codePointAt(1)! - A));
  return c1 + c2;
}
```

- [ ] **Step 2.4: Run tests, confirm all pass**

```bash
pnpm test -- tests/compute/country-flags.test.ts
```

Expected: 2/2 pass.

- [ ] **Step 2.5: Commit**

```bash
git add lib/compute/country-flags.ts tests/compute/country-flags.test.ts
git commit -m "$(cat <<'EOF'
feat(compute): country-flags helper for discovery UI

Pure: ISO 2-letter code → flag emoji via regional-indicator codepoints.
Falls back to the code string for unknown codes; returns '' for null.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Python `kind=info` handler + TS `info()` method

**Files:**
- Modify: `api/fallback/yfinance.py`
- Modify: `lib/providers/yfinance.ts`
- Modify: `tests/providers/yfinance.test.ts`

The Python serverless gains a new `kind=info` handler. The TS provider gains an `info(ticker)` method calling the new kind.

- [ ] **Step 3.1: Inspect `api/fallback/yfinance.py` to find the dispatcher style**

```bash
grep -n "if kind ==\|elif kind ==\|def fetch_" api/fallback/yfinance.py | head -20
```

You'll see the dispatcher uses `if kind == "X"` chained branches. The existing handlers are `fetch_company`, `fetch_snapshot`, `fetch_prices`, `fetch_earnings`, `fetch_statements`. Add a `fetch_info` handler.

- [ ] **Step 3.2: Add `fetch_info` to `api/fallback/yfinance.py`**

Place near the other `fetch_*` functions (around line 150-170). The function calls `yf.Ticker(ticker).info` and filters to the fields we care about:

```python
def fetch_info(ticker):
    """
    Return enrichment metadata for a ticker from yfinance .info dict.
    Returns only the fields the discovery seeder consumes.
    """
    import yfinance as yf
    t = yf.Ticker(ticker)
    info = t.info or {}
    # yfinance returns a huge dict; trim to what the seeder uses.
    return {
        'longBusinessSummary': info.get('longBusinessSummary') or None,
        'country': info.get('country') or None,
        'sector': info.get('sector') or None,
        'industry': info.get('industry') or None,
        'exchange': info.get('exchange') or None,
        'marketCap': info.get('marketCap') or None,
        'longName': info.get('longName') or info.get('shortName') or None
    }
```

Then wire into the dispatcher block. Find the existing `if kind == "company":` chain and add:

```python
if kind == "info":
    return fetch_info(ticker)
```

Match the dispatcher style of the existing handlers (the file uses `if kind == ...: return ...` not chained elif).

- [ ] **Step 3.3: Add a TS test stub for `.info()`** in `tests/providers/yfinance.test.ts`

Inspect existing tests in `tests/providers/yfinance.test.ts` to see the helper setup (likely `loadFixture`, `jsonResponse`, `makeProvider`). Mirror the pattern. Add a new describe block inside the existing top-level describe:

```ts
  describe('.info()', () => {
    it('returns info fields mapped from yfinance .info', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
        longBusinessSummary: 'Apple Inc. designs and sells iPhones.',
        country: 'United States',
        sector: 'Technology',
        industry: 'Consumer Electronics',
        exchange: 'NMS',
        marketCap: 3000000000000,
        longName: 'Apple Inc.'
      }));
      const provider = makeProvider(fetchMock);
      const result = await provider.info('AAPL');
      expect(fetchMock).toHaveBeenCalledOnce();
      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('kind=info');
      expect(url).toContain('ticker=AAPL');
      expect(result.longBusinessSummary).toContain('Apple');
      expect(result.country).toBe('United States');
      expect(result.sector).toBe('Technology');
      expect(result.marketCap).toBe(3000000000000);
    });

    it('returns nulls when the upstream returns null fields', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
        longBusinessSummary: null,
        country: null,
        sector: null,
        industry: null,
        exchange: null,
        marketCap: null,
        longName: null
      }));
      const provider = makeProvider(fetchMock);
      const result = await provider.info('DELISTED');
      expect(result.longBusinessSummary).toBeNull();
      expect(result.country).toBeNull();
      expect(result.marketCap).toBeNull();
    });
  });
```

If the existing tests use a different helper pattern (e.g. `makeYfinanceProvider`, `makeFakeProvider`), adapt to match. Look at how `.snapshot()` or `.prices()` tests are structured in the same file and mirror them.

- [ ] **Step 3.4: Run tests — confirm both fail with `provider.info is not a function`**

```bash
pnpm test -- tests/providers/yfinance.test.ts
```

Expected: 2 new tests fail.

- [ ] **Step 3.5: Add `info()` to `lib/providers/yfinance.ts`**

Read the existing file to confirm class name, constructor shape, request helper:

```bash
head -60 lib/providers/yfinance.ts
```

The existing methods like `.snapshot()` call a request helper that builds `/api/fallback/yfinance?kind=...&ticker=...` URLs and returns parsed JSON. Add an `info(ticker)` method that follows the same pattern.

Add a type interface near the top of the file:

```ts
export interface YfInfo {
  longBusinessSummary: string | null;
  country: string | null;
  sector: string | null;
  industry: string | null;
  exchange: string | null;
  marketCap: number | null;
  longName: string | null;
}
```

Add the method to the class. The exact body must mirror the existing methods' pattern — most likely:

```ts
  async info(ticker: string): Promise<YfInfo> {
    const data = await this.request<{
      longBusinessSummary: string | null;
      country: string | null;
      sector: string | null;
      industry: string | null;
      exchange: string | null;
      marketCap: number | null;
      longName: string | null;
    }>(`kind=info&ticker=${encodeURIComponent(ticker.toUpperCase())}`);
    return {
      longBusinessSummary: data.longBusinessSummary ?? null,
      country: data.country ?? null,
      sector: data.sector ?? null,
      industry: data.industry ?? null,
      exchange: data.exchange ?? null,
      marketCap: data.marketCap ?? null,
      longName: data.longName ?? null
    };
  }
```

If the actual `this.request` helper has a different shape (e.g. takes `(kind, params)` separately), adapt to match the existing methods exactly.

- [ ] **Step 3.6: Run tests — confirm both pass**

```bash
pnpm test -- tests/providers/yfinance.test.ts
```

Expected: all existing + 2 new tests pass.

- [ ] **Step 3.7: Commit**

```bash
git add api/fallback/yfinance.py lib/providers/yfinance.ts tests/providers/yfinance.test.ts
git commit -m "$(cat <<'EOF'
feat(yfinance): kind=info handler + TS .info() method for discovery

Python fetch_info returns a trimmed yf.Ticker(t).info dict with
longBusinessSummary, country, sector, industry, exchange, marketCap,
longName. TS wraps it as YFinanceProvider.info(ticker) returning
YfInfo. 2 unit tests covering populated + all-null upstream.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Locked LLM parsing prompt

**Files:**
- Create: `lib/services/discover-prompts.ts`

Tiny task. Locks the v1 system prompt for the query parser so future prompt-tuning is a deliberate edit, not silent drift.

- [ ] **Step 4.1: Create `lib/services/discover-prompts.ts`**

```ts
/**
 * Locked v1 system prompt for the discovery query parser.
 *
 * The LLM extracts structured filters from a free-form user query and
 * returns ONLY valid JSON matching ParsedQuery. The fewer hallucinations,
 * the better — so the prompt is restrictive and example-driven.
 *
 * If you need to change behavior, bump the version and update the call
 * site in lib/services/discover.ts. Don't edit silently.
 */

export const PARSE_QUERY_PROMPT_VERSION = 'v1';

export const PARSE_QUERY_SYSTEM_PROMPT = `You parse free-form stock-discovery queries into structured filters.

Return JSON with these fields (use null when not specified):
- country: ISO 2-letter code (BR, CN, US, IN, JP, GB, DE, KR, TW, HK, FR, IT, ES, MX, etc.)
- sector: one of [Technology, Healthcare, Financial Services, Consumer Cyclical, Consumer Defensive, Communication Services, Industrials, Energy, Basic Materials, Real Estate, Utilities]
- industry: yfinance industry string if recognized (e.g. "Internet Retail", "Semiconductors", "Beverages-Brewers")
- exchanges: array of ['NYSE','NASDAQ'] (default empty = no constraint)
- conceptText: what's left after extracting structured filters. Always a non-empty string.
- marketCapMin: number in USD (e.g. 10000000000 = $10B), nullable
- marketCapMax: number in USD, nullable

EXAMPLES:
"AI infrastructure" -> {"country":null,"sector":"Technology","industry":null,"exchanges":[],"conceptText":"AI infrastructure","marketCapMin":null,"marketCapMax":null}
"Brazilian CPG on US exchanges" -> {"country":"BR","sector":"Consumer Defensive","industry":null,"exchanges":["NYSE","NASDAQ"],"conceptText":"consumer packaged goods","marketCapMin":null,"marketCapMax":null}
"Chinese internet ADRs" -> {"country":"CN","sector":"Technology","industry":null,"exchanges":["NYSE","NASDAQ"],"conceptText":"internet company","marketCapMin":null,"marketCapMax":null}
"small-cap healthcare AI" -> {"country":null,"sector":"Healthcare","industry":null,"exchanges":[],"conceptText":"healthcare AI","marketCapMin":null,"marketCapMax":2000000000}
"large-cap Japanese automakers" -> {"country":"JP","sector":"Consumer Cyclical","industry":"Auto Manufacturers","exchanges":[],"conceptText":"automaker","marketCapMin":10000000000,"marketCapMax":null}

Return ONLY valid JSON. No prose. No markdown fences.`;

export const PARSE_QUERY_USER_PROMPT_TEMPLATE = (userText: string): string =>
  `INPUT: "${userText.replace(/"/g, '\\"')}"`;
```

- [ ] **Step 4.2: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 4.3: Commit**

```bash
git add lib/services/discover-prompts.ts
git commit -m "$(cat <<'EOF'
feat(discover): locked v1 system prompt for query parser

PARSE_QUERY_SYSTEM_PROMPT extracts country/sector/industry/exchanges/
conceptText/market-cap range from free-form text. Example-driven to
minimize LLM hallucination. Prompt version bumped explicitly when
behavior changes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `DiscoverService.parseQuery` — LLM parser + tests

**Files:**
- Create: `lib/services/discover.ts` (parseQuery method only — search added in T6)
- Create: `tests/services/discover-parse-query.test.ts`

`parseQuery` calls `QwenProvider.summarize` with our system prompt + the user query, parses the JSON response, validates with Zod, returns a `ParsedQuery`. Defensive: on JSON parse failure or schema validation failure, fall back to `{ ...all null, conceptText: originalQuery }`.

- [ ] **Step 5.1: Write failing tests**

Create `tests/services/discover-parse-query.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { DiscoverService } from '@/lib/services/discover';
import type { QwenProvider } from '@/lib/providers/types';

function mockQwen(jsonOutput: string): QwenProvider {
  return {
    summarize: vi.fn().mockResolvedValue({
      text: jsonOutput, inputTokens: 100, outputTokens: 50
    }),
    sentimentBatch: vi.fn()
  };
}

// Helper to instantiate just for parseQuery — embedding/db not exercised here.
function makeSvc(qwen: QwenProvider) {
  return new DiscoverService({
    db: null as any,            // unused by parseQuery
    qwenProvider: qwen,
    embeddingsProvider: null as any,    // unused
    redis: null as any                  // unused
  });
}

describe('DiscoverService.parseQuery', () => {
  it('parses "AI infrastructure" into Technology sector + concept text', async () => {
    const qwen = mockQwen(JSON.stringify({
      country: null, sector: 'Technology', industry: null,
      exchanges: [], conceptText: 'AI infrastructure',
      marketCapMin: null, marketCapMax: null
    }));
    const svc = makeSvc(qwen);
    const result = await svc.parseQuery('AI infrastructure');
    expect(result.sector).toBe('Technology');
    expect(result.country).toBeNull();
    expect(result.conceptText).toBe('AI infrastructure');
  });

  it('parses "Brazilian CPG on US exchanges" into BR + Consumer Defensive + NYSE/NASDAQ', async () => {
    const qwen = mockQwen(JSON.stringify({
      country: 'BR', sector: 'Consumer Defensive', industry: null,
      exchanges: ['NYSE', 'NASDAQ'], conceptText: 'consumer packaged goods',
      marketCapMin: null, marketCapMax: null
    }));
    const svc = makeSvc(qwen);
    const result = await svc.parseQuery('Brazilian CPG on US exchanges');
    expect(result.country).toBe('BR');
    expect(result.exchanges).toEqual(['NYSE', 'NASDAQ']);
  });

  it('parses "Chinese internet ADRs"', async () => {
    const qwen = mockQwen(JSON.stringify({
      country: 'CN', sector: 'Technology', industry: null,
      exchanges: ['NYSE', 'NASDAQ'], conceptText: 'internet company',
      marketCapMin: null, marketCapMax: null
    }));
    const svc = makeSvc(qwen);
    const result = await svc.parseQuery('Chinese internet ADRs');
    expect(result.country).toBe('CN');
  });

  it('parses market-cap qualifiers', async () => {
    const qwen = mockQwen(JSON.stringify({
      country: null, sector: 'Healthcare', industry: null,
      exchanges: [], conceptText: 'healthcare AI',
      marketCapMin: null, marketCapMax: 2000000000
    }));
    const svc = makeSvc(qwen);
    const result = await svc.parseQuery('small-cap healthcare AI');
    expect(result.marketCapMax).toBe(2_000_000_000);
  });

  it('strips markdown code fences from LLM output', async () => {
    // Defensive — some Qwen completions wrap JSON in ```json fences.
    const qwen = mockQwen('```json\n{"country":null,"sector":null,"industry":null,"exchanges":[],"conceptText":"hi","marketCapMin":null,"marketCapMax":null}\n```');
    const svc = makeSvc(qwen);
    const result = await svc.parseQuery('hi');
    expect(result.conceptText).toBe('hi');
  });

  it('falls back to defaults when LLM returns invalid JSON', async () => {
    const qwen = mockQwen('not json at all');
    const svc = makeSvc(qwen);
    const result = await svc.parseQuery('whatever');
    expect(result.country).toBeNull();
    expect(result.sector).toBeNull();
    expect(result.conceptText).toBe('whatever');
  });

  it('falls back when schema validation fails (e.g. non-array exchanges)', async () => {
    const qwen = mockQwen(JSON.stringify({
      country: null, sector: 'Technology', industry: null,
      exchanges: 'NYSE',     // wrong type — should be array
      conceptText: 'hi', marketCapMin: null, marketCapMax: null
    }));
    const svc = makeSvc(qwen);
    const result = await svc.parseQuery('hi');
    expect(result.exchanges).toEqual([]);
  });

  it('nulls out invalid country codes', async () => {
    const qwen = mockQwen(JSON.stringify({
      country: 'BRA',       // 3-letter — invalid
      sector: null, industry: null,
      exchanges: [], conceptText: 'hi',
      marketCapMin: null, marketCapMax: null
    }));
    const svc = makeSvc(qwen);
    const result = await svc.parseQuery('hi');
    expect(result.country).toBeNull();
  });
});
```

- [ ] **Step 5.2: Run tests — confirm all 8 fail with module-not-found**

```bash
pnpm test -- tests/services/discover-parse-query.test.ts
```

Expected: 8 tests fail with `Cannot find module '@/lib/services/discover'`.

- [ ] **Step 5.3: Implement `lib/services/discover.ts` — types + parseQuery only**

```ts
import { z } from 'zod';
import type { ServiceDb } from '@/lib/db/client';
import type { QwenProvider, EmbeddingsProvider } from '@/lib/providers/types';
import type { RedisCache } from '@/lib/cache/redis';
import { PARSE_QUERY_SYSTEM_PROMPT, PARSE_QUERY_USER_PROMPT_TEMPLATE } from './discover-prompts';
import { logger } from '@/lib/logger';

// ----- Types -----

export interface ParsedQuery {
  country: string | null;
  sector: string | null;
  industry: string | null;
  exchanges: string[];
  conceptText: string;
  marketCapMin: number | null;
  marketCapMax: number | null;
}

export interface DiscoverResult {
  ticker: string;
  name: string;
  exchange: string | null;
  country: string | null;
  sector: string | null;
  industry: string | null;
  description: string | null;
  marketCap: number | null;
  similarity: number;
}

interface Deps {
  db: ServiceDb;
  qwenProvider: QwenProvider;
  embeddingsProvider: EmbeddingsProvider;
  redis: RedisCache;
}

// ----- Zod schema for LLM response validation -----

const ISO_COUNTRY = /^[A-Z]{2}$/;
const VALID_EXCHANGES = new Set(['NYSE', 'NASDAQ']);

const parsedQuerySchema = z.object({
  country: z.string().nullable().transform((v) => (v && ISO_COUNTRY.test(v) ? v : null)),
  sector: z.string().nullable(),
  industry: z.string().nullable(),
  exchanges: z.array(z.string()).transform((arr) => arr.filter((e) => VALID_EXCHANGES.has(e))),
  conceptText: z.string(),
  marketCapMin: z.number().positive().nullable(),
  marketCapMax: z.number().positive().nullable()
});

function stripCodeFences(text: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const match = text.trim().match(fence);
  return match ? match[1]!.trim() : text.trim();
}

function fallbackParsed(originalQuery: string): ParsedQuery {
  return {
    country: null,
    sector: null,
    industry: null,
    exchanges: [],
    conceptText: originalQuery,
    marketCapMin: null,
    marketCapMax: null
  };
}

// ----- Service -----

export class DiscoverService {
  constructor(private readonly deps: Deps) {}

  async parseQuery(userQuery: string): Promise<ParsedQuery> {
    const trimmed = userQuery.trim();
    if (!trimmed) return fallbackParsed('');

    let raw: string;
    try {
      const result = await this.deps.qwenProvider.summarize({
        model: 'qwen-turbo',
        systemPrompt: PARSE_QUERY_SYSTEM_PROMPT,
        userPrompt: PARSE_QUERY_USER_PROMPT_TEMPLATE(trimmed),
        maxTokens: 400
      });
      raw = stripCodeFences(result.text);
    } catch (err) {
      logger.warn({ err: String(err), query: trimmed }, 'discover.parseQuery: LLM call failed');
      return fallbackParsed(trimmed);
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      logger.warn({ raw, query: trimmed }, 'discover.parseQuery: invalid JSON');
      return fallbackParsed(trimmed);
    }

    const validated = parsedQuerySchema.safeParse(json);
    if (!validated.success) {
      logger.warn({ issues: validated.error.issues, query: trimmed }, 'discover.parseQuery: schema validation failed');
      return fallbackParsed(trimmed);
    }
    // Ensure conceptText is non-empty; fall back to original if LLM stripped it
    const out = validated.data;
    if (!out.conceptText.trim()) out.conceptText = trimmed;
    return out;
  }

  // search() added in Task 6
}
```

`zod` is already a dependency (used elsewhere in the codebase — confirm by `grep -l "from 'zod'" lib/`).

- [ ] **Step 5.4: Run tests — confirm all 8 pass**

```bash
pnpm test -- tests/services/discover-parse-query.test.ts
```

Expected: 8/8 pass.

- [ ] **Step 5.5: Commit**

```bash
git add lib/services/discover.ts tests/services/discover-parse-query.test.ts
git commit -m "$(cat <<'EOF'
feat(discover): DiscoverService.parseQuery LLM-driven filter extraction

QwenProvider.summarize call → strip code fences → JSON.parse →
Zod-validate → ParsedQuery. Defensive fallback to all-null +
conceptText=originalQuery on any failure (LLM error, invalid JSON,
schema mismatch). Country code restricted to ISO 2-letter, exchanges
filtered to known values. 8 unit tests covering examples + edge cases.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `DiscoverService.search` — pgvector + integration tests

**Files:**
- Modify: `lib/services/discover.ts` (add `search` method + helpers)
- Create: `tests/integration/discover-service.test.ts`

`search(query)` orchestrates: parseQuery → embed conceptText → SQL prefilter + pgvector cosine → return DiscoverResult[]. With fallback to full-universe scan when prefilter is empty.

- [ ] **Step 6.1: Write failing integration tests**

Create `tests/integration/discover-service.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companiesUniverse } from '@/lib/db/schema';
import { DiscoverService } from '@/lib/services/discover';
import type { QwenProvider, EmbeddingsProvider } from '@/lib/providers/types';

config({ path: '.env.local' });

// Deterministic 1024-d embedding by seed. Same seed = same vector.
// We use 3 "directions" — concept A, B, C — to make ranking deterministic.
function vec(seed: 'A' | 'B' | 'C'): number[] {
  const v = new Array(1024).fill(0);
  if (seed === 'A') v[0] = 1;
  if (seed === 'B') v[1] = 1;
  if (seed === 'C') v[2] = 1;
  return v;
}

function mockQwen(parsed: any): QwenProvider {
  return {
    summarize: vi.fn().mockResolvedValue({
      text: JSON.stringify(parsed), inputTokens: 100, outputTokens: 50
    }),
    sentimentBatch: vi.fn()
  };
}

function mockEmbeddings(vector: number[]): EmbeddingsProvider {
  return {
    embed: vi.fn().mockResolvedValue({ vectors: [vector], inputTokens: 5 })
  };
}

const mockRedis = { get: async () => null, set: async () => undefined } as any;

describe('DiscoverService.search', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    // Seed 6 fake companies: 3 countries x 3 concept-directions
    await dbH.db.insert(companiesUniverse).values([
      { ticker: 'AAA', name: 'Alpha US-A',  country: 'US', exchange: 'NYSE',   sector: 'Technology', description: 'a', descriptionEmbedding: vec('A'), sources: ['nyse'] },
      { ticker: 'BBB', name: 'Beta US-B',   country: 'US', exchange: 'NYSE',   sector: 'Technology', description: 'b', descriptionEmbedding: vec('B'), sources: ['nyse'] },
      { ticker: 'CCC', name: 'Cee BR-A',    country: 'BR', exchange: 'NYSE',   sector: 'Consumer Defensive', description: 'c', descriptionEmbedding: vec('A'), sources: ['nyse'] },
      { ticker: 'DDD', name: 'Dee BR-C',    country: 'BR', exchange: 'NYSE',   sector: 'Consumer Defensive', description: 'd', descriptionEmbedding: vec('C'), sources: ['nyse'] },
      { ticker: 'EEE', name: 'Ee CN-A',     country: 'CN', exchange: 'NASDAQ', sector: 'Technology', description: 'e', descriptionEmbedding: vec('A'), sources: ['nasdaq'] },
      { ticker: 'FFF', name: 'Eff no-desc', country: 'US', exchange: 'NYSE',   sector: 'Technology', description: null, descriptionEmbedding: null, sources: ['nyse'] }
    ]);
  });

  it('prefilters by country then ranks by similarity', async () => {
    const qwen = mockQwen({
      country: 'BR', sector: null, industry: null,
      exchanges: [], conceptText: 'concept A', marketCapMin: null, marketCapMax: null
    });
    const emb = mockEmbeddings(vec('A'));
    const svc = new DiscoverService({ db: dbH.db, qwenProvider: qwen, embeddingsProvider: emb, redis: mockRedis });

    const results = await svc.search('Brazilian concept A', 10);
    expect(results).toHaveLength(2);
    expect(results[0]!.ticker).toBe('CCC');     // CCC has vec(A) — perfect match for query vec(A)
    expect(results[1]!.ticker).toBe('DDD');     // DDD has vec(C) — orthogonal
    expect(results[0]!.similarity).toBeGreaterThan(results[1]!.similarity);
  });

  it('prefilters by sector + exchange and ranks by similarity', async () => {
    const qwen = mockQwen({
      country: null, sector: 'Technology', industry: null,
      exchanges: ['NYSE', 'NASDAQ'], conceptText: 'concept A',
      marketCapMin: null, marketCapMax: null
    });
    const emb = mockEmbeddings(vec('A'));
    const svc = new DiscoverService({ db: dbH.db, qwenProvider: qwen, embeddingsProvider: emb, redis: mockRedis });

    const results = await svc.search('tech', 10);
    // Tech rows on NYSE/NASDAQ with non-null embeddings: AAA, BBB, EEE
    expect(results.map((r) => r.ticker).sort()).toEqual(['AAA', 'BBB', 'EEE']);
    // AAA and EEE both have vec(A) — highest similarity
    expect(results[0]!.similarity).toBeGreaterThan(0.99);
  });

  it('excludes rows with null description_embedding', async () => {
    const qwen = mockQwen({
      country: 'US', sector: null, industry: null,
      exchanges: [], conceptText: 'whatever',
      marketCapMin: null, marketCapMax: null
    });
    const emb = mockEmbeddings(vec('A'));
    const svc = new DiscoverService({ db: dbH.db, qwenProvider: qwen, embeddingsProvider: emb, redis: mockRedis });

    const results = await svc.search('whatever', 10);
    expect(results.map((r) => r.ticker)).not.toContain('FFF');     // FFF has null embedding
  });

  it('falls back to full-universe search when prefilter is empty', async () => {
    const qwen = mockQwen({
      country: 'JP',     // no JP rows in seed
      sector: null, industry: null,
      exchanges: [], conceptText: 'concept A',
      marketCapMin: null, marketCapMax: null
    });
    const emb = mockEmbeddings(vec('A'));
    const svc = new DiscoverService({ db: dbH.db, qwenProvider: qwen, embeddingsProvider: emb, redis: mockRedis });

    const results = await svc.search('Japanese concept A', 10);
    // Falls back to all 5 non-null-embedding rows ranked by sim
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results[0]!.similarity).toBeGreaterThan(0.99);    // vec(A) match
  });

  it('honors limit', async () => {
    const qwen = mockQwen({
      country: null, sector: null, industry: null,
      exchanges: [], conceptText: 'anything',
      marketCapMin: null, marketCapMax: null
    });
    const emb = mockEmbeddings(vec('A'));
    const svc = new DiscoverService({ db: dbH.db, qwenProvider: qwen, embeddingsProvider: emb, redis: mockRedis });

    const results = await svc.search('anything', 2);
    expect(results).toHaveLength(2);
  });

  it('returns empty array when conceptText is empty and no filters set', async () => {
    const qwen = mockQwen({
      country: null, sector: null, industry: null,
      exchanges: [], conceptText: '',
      marketCapMin: null, marketCapMax: null
    });
    const emb = mockEmbeddings(vec('A'));
    const svc = new DiscoverService({ db: dbH.db, qwenProvider: qwen, embeddingsProvider: emb, redis: mockRedis });

    // Empty user query upstream — search shouldn't go to LLM/embedding.
    const results = await svc.search('', 10);
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 6.2: Run tests — confirm 6 fail with method missing**

```bash
pnpm test:integration -- discover-service
```

Expected: 6 tests fail with `svc.search is not a function` (or similar — `search` doesn't exist yet).

- [ ] **Step 6.3: Add `search` method to `lib/services/discover.ts`**

Open the file and add these imports + helpers + method. Place the new method on the existing `DiscoverService` class:

```ts
import { sql, eq, and, inArray, gte, lte, isNotNull } from 'drizzle-orm';
import { companiesUniverse } from '@/lib/db/schema';
```

(Add these to the imports at the top — `sql` is for the vector operator, the rest for the prefilter WHERE clauses.)

Then add the search method to the class:

```ts
  async search(userQuery: string, limit = 20): Promise<DiscoverResult[]> {
    const trimmed = userQuery.trim();
    if (!trimmed) return [];

    const parsed = await this.parseQuery(trimmed);
    if (!parsed.conceptText.trim()) return [];

    // 1. Embed conceptText (Qwen text-embedding-v4, 1024-d to match the column).
    const embedResult = await this.deps.embeddingsProvider.embed({
      model: 'text-embedding-v4',
      texts: [parsed.conceptText]
    });
    const queryVec = embedResult.vectors[0];
    if (!queryVec) {
      logger.warn({ query: trimmed }, 'discover.search: empty embedding response');
      return [];
    }

    // 2. Build the WHERE clause from parsed filters. Description embedding must be non-null.
    const conditions = [isNotNull(companiesUniverse.descriptionEmbedding)];
    if (parsed.country) conditions.push(eq(companiesUniverse.country, parsed.country));
    if (parsed.sector) conditions.push(eq(companiesUniverse.sector, parsed.sector));
    if (parsed.industry) conditions.push(eq(companiesUniverse.industry, parsed.industry));
    if (parsed.exchanges.length > 0) conditions.push(inArray(companiesUniverse.exchange, parsed.exchanges));
    if (parsed.marketCapMin != null) conditions.push(gte(companiesUniverse.marketCap, String(parsed.marketCapMin)));
    if (parsed.marketCapMax != null) conditions.push(lte(companiesUniverse.marketCap, String(parsed.marketCapMax)));

    // 3. Run the vector search. pgvector cosine distance via raw SQL templated into ORDER BY.
    // The vector literal is the JSON array form '[1,0,0,...]' which pgvector accepts.
    const queryVecLit = '[' + queryVec.join(',') + ']';
    const rows = await this.deps.db
      .select({
        ticker: companiesUniverse.ticker,
        name: companiesUniverse.name,
        exchange: companiesUniverse.exchange,
        country: companiesUniverse.country,
        sector: companiesUniverse.sector,
        industry: companiesUniverse.industry,
        description: companiesUniverse.description,
        marketCap: companiesUniverse.marketCap,
        // cosine similarity = 1 - cosine distance
        similarity: sql<number>`1 - (${companiesUniverse.descriptionEmbedding} <=> ${queryVecLit}::vector)`
      })
      .from(companiesUniverse)
      .where(and(...conditions))
      .orderBy(sql`${companiesUniverse.descriptionEmbedding} <=> ${queryVecLit}::vector`)
      .limit(limit);

    // 4. If structured filters yielded zero rows, fall back to full-universe scan.
    if (rows.length === 0 && (parsed.country || parsed.sector || parsed.industry || parsed.exchanges.length > 0 || parsed.marketCapMin != null || parsed.marketCapMax != null)) {
      const fallbackRows = await this.deps.db
        .select({
          ticker: companiesUniverse.ticker,
          name: companiesUniverse.name,
          exchange: companiesUniverse.exchange,
          country: companiesUniverse.country,
          sector: companiesUniverse.sector,
          industry: companiesUniverse.industry,
          description: companiesUniverse.description,
          marketCap: companiesUniverse.marketCap,
          similarity: sql<number>`1 - (${companiesUniverse.descriptionEmbedding} <=> ${queryVecLit}::vector)`
        })
        .from(companiesUniverse)
        .where(isNotNull(companiesUniverse.descriptionEmbedding))
        .orderBy(sql`${companiesUniverse.descriptionEmbedding} <=> ${queryVecLit}::vector`)
        .limit(limit);
      return fallbackRows.map((r) => ({
        ...r,
        marketCap: r.marketCap == null ? null : Number(r.marketCap),
        similarity: Number(r.similarity)
      }));
    }

    return rows.map((r) => ({
      ...r,
      marketCap: r.marketCap == null ? null : Number(r.marketCap),
      similarity: Number(r.similarity)
    }));
  }
```

Note: Drizzle's `gte`/`lte` for `numeric` columns may require the value as a string (the column is `numeric` which Drizzle returns as string). Pass `String(parsed.marketCapMin)` and `String(parsed.marketCapMax)` — that's what the existing services do (e.g. `lib/services/holdings.ts` numToStr pattern).

- [ ] **Step 6.4: Run tests — confirm 6 pass**

```bash
pnpm test:integration -- discover-service
```

Expected: 6/6 pass.

If the vector operator `<=>` errors with "operator does not exist", the pgvector extension may not be loaded in your TEST branch. It IS in prod (Slice 2C set it up). Run on TEST:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```
(via `_apply.ts` with a one-liner migration if needed.)

- [ ] **Step 6.5: Commit**

```bash
git add lib/services/discover.ts tests/integration/discover-service.test.ts
git commit -m "$(cat <<'EOF'
feat(discover): DiscoverService.search with pgvector + prefilter fallback

Embeds conceptText, builds SQL WHERE from parsed filters, runs cosine
ranking via pgvector ORDER BY description_embedding <=> query_vec.
When the prefilter yields zero rows, falls back to full-universe scan
with the same vector ranking and a UI hint (caller responsibility).
Excludes rows with null description_embedding from both paths.
6 integration tests with deterministic 1024-d seed vectors.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: API route + tests

**Files:**
- Create: `app/api/discover/route.ts`
- Create: `tests/integration/api-discover.test.ts`
- Create: `tests/integration/companies-universe-rls.test.ts`

- [ ] **Step 7.1: Create `app/api/discover/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { QwenProviderImpl } from '@/lib/providers/qwen';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';
import { DiscoverService } from '@/lib/services/discover';
import { getRedisCache } from '@/lib/cache/redis';

const RATE_LIMIT_PER_HOUR = 30;

const requestSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(100).optional()
});

let svc: DiscoverService | null = null;
function service(): DiscoverService {
  if (svc) return svc;
  svc = new DiscoverService({
    db: getServiceDb(),
    qwenProvider: new QwenProviderImpl(),
    embeddingsProvider: new EmbeddingsProviderImpl(),
    redis: getRedisCache()
  });
  return svc;
}

async function rateLimit(userId: string): Promise<boolean> {
  const redis = getRedisCache();
  const key = `ratelimit:discover:${userId}`;
  const cur = (await redis.get<number>(key)) ?? 0;
  if (cur >= RATE_LIMIT_PER_HOUR) return false;
  await redis.set(key, cur + 1, 60 * 60);
  return true;
}

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    if (!(await rateLimit(userId))) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': '3600' } }
      );
    }
    const body = await req.json();
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(`Invalid request: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    const svc_ = service();
    const [parsedQuery, results] = await Promise.all([
      svc_.parseQuery(parsed.data.query),
      svc_.search(parsed.data.query, parsed.data.limit ?? 20)
    ]);
    return ok({ parsed: parsedQuery, results });
  } catch (err) {
    return errorResponse(err, { route: 'discover POST' });
  }
}
```

**Note:** the route calls `parseQuery` AND `search` in parallel — but `search` internally calls `parseQuery` again. That's two LLM calls per request, which is wasteful. Optimize by making `search` accept a pre-parsed query:

Edit `search` signature to accept an optional parsed query:
```ts
async search(userQuery: string, limit = 20, prefetchedParsed?: ParsedQuery): Promise<DiscoverResult[]>
```

If `prefetchedParsed` is provided, skip the internal `parseQuery` call. Then in the route:
```ts
const parsedQuery = await svc_.parseQuery(parsed.data.query);
const results = await svc_.search(parsed.data.query, parsed.data.limit ?? 20, parsedQuery);
```

Update the existing `search` integration tests to confirm both calling patterns still work (call with and without `prefetchedParsed`).

- [ ] **Step 7.2: Add API integration tests**

Create `tests/integration/api-discover.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companiesUniverse } from '@/lib/db/schema';

config({ path: '.env.local' });

function vec(seed: 'A'): number[] {
  const v = new Array(1024).fill(0);
  v[0] = 1;
  return v;
}

describe('POST /api/discover', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companiesUniverse).values({
      ticker: 'AAA', name: 'Alpha',
      country: 'US', exchange: 'NYSE', sector: 'Technology',
      description: 'a', descriptionEmbedding: vec('A'), sources: ['nyse']
    });
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => newUserId(),
      getCurrentUserId: async () => newUserId(),
      UnauthorizedError: class extends Error {}
    }));
    vi.doMock('@/lib/db/client', () => ({ getServiceDb: () => dbH.db }));
    vi.doMock('@/lib/providers/qwen', () => ({
      QwenProviderImpl: class {
        summarize = vi.fn().mockResolvedValue({
          text: JSON.stringify({
            country: null, sector: 'Technology', industry: null,
            exchanges: [], conceptText: 'tech',
            marketCapMin: null, marketCapMax: null
          }),
          inputTokens: 50, outputTokens: 20
        });
        sentimentBatch = vi.fn();
      }
    }));
    vi.doMock('@/lib/providers/embeddings', () => ({
      EmbeddingsProviderImpl: class {
        embed = vi.fn().mockResolvedValue({ vectors: [vec('A')], inputTokens: 5 });
      }
    }));
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({ get: async () => 0, set: async () => undefined })
    }));
  });

  it('POST happy path: returns parsed + results', async () => {
    const { POST } = await import('@/app/api/discover/route');
    const res = await POST(new Request('http://test.local/api/discover', {
      method: 'POST',
      body: JSON.stringify({ query: 'tech', limit: 10 }),
      headers: { 'content-type': 'application/json' }
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parsed.sector).toBe('Technology');
    expect(body.results).toHaveLength(1);
    expect(body.results[0].ticker).toBe('AAA');
  });

  it('POST returns 400 on empty query', async () => {
    const { POST } = await import('@/app/api/discover/route');
    const res = await POST(new Request('http://test.local/api/discover', {
      method: 'POST',
      body: JSON.stringify({ query: '' }),
      headers: { 'content-type': 'application/json' }
    }));
    expect(res.status).toBe(400);
  });

  it('POST returns 429 when rate-limited', async () => {
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({ get: async () => 999, set: async () => undefined })
    }));
    vi.resetModules();
    const { POST } = await import('@/app/api/discover/route');
    const res = await POST(new Request('http://test.local/api/discover', {
      method: 'POST',
      body: JSON.stringify({ query: 'tech' }),
      headers: { 'content-type': 'application/json' }
    }));
    expect(res.status).toBe(429);
  });
});
```

- [ ] **Step 7.3: Create RLS smoke test**

Create `tests/integration/companies-universe-rls.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, makeTestUserDb, newUserId, resetDb } from '../helpers/test-db';
import { companiesUniverse } from '@/lib/db/schema';

config({ path: '.env.local' });

function vec(): number[] {
  const v = new Array(1024).fill(0);
  v[0] = 1;
  return v;
}

describe('RLS: companies_universe', () => {
  let svc: ReturnType<typeof makeTestServiceDb>;
  let user: ReturnType<typeof makeTestUserDb>;

  beforeAll(() => { svc = makeTestServiceDb(); user = makeTestUserDb(); });
  afterAll(async () => { await svc.close(); await user.close(); });

  beforeEach(async () => {
    await resetDb(svc.db);
    await svc.db.insert(companiesUniverse).values({
      ticker: 'AAA', name: 'Alpha', country: 'US', exchange: 'NYSE', sector: 'Tech',
      description: 'a', descriptionEmbedding: vec(), sources: ['nyse']
    });
  });

  it('authenticated role can SELECT companies_universe', async () => {
    const uid = newUserId();
    const count = await user.asUser(uid, async (tx) => {
      const r = await tx.select().from(companiesUniverse);
      return r.length;
    });
    expect(count).toBe(1);
  });

  it('authenticated role cannot INSERT companies_universe', async () => {
    const uid = newUserId();
    await expect(
      user.asUser(uid, async (tx) => {
        await tx.insert(companiesUniverse).values({
          ticker: 'EVIL', name: 'Evil', country: 'XX', exchange: 'NYSE',
          sector: 'Tech', description: 'evil', descriptionEmbedding: vec(), sources: ['nyse']
        });
      })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 7.4: Run all the new tests**

```bash
pnpm test:integration -- discover api-discover companies-universe-rls
```

Expected: 6 service (T6) + 3 API + 2 RLS = 11 passing.

- [ ] **Step 7.5: Commit**

```bash
git add "app/api/discover/route.ts" lib/services/discover.ts \
        tests/integration/api-discover.test.ts \
        tests/integration/companies-universe-rls.test.ts
git commit -m "$(cat <<'EOF'
feat(discover): POST /api/discover route + RLS smoke

Auth-gated, rate-limited 30/hour/user. Zod-validated body {query, limit?}.
Calls parseQuery then search (with prefetched parsed, avoiding a 2nd
LLM call). Returns {parsed, results}. RLS smoke confirms authenticated
SELECT works, authenticated INSERT denied. 5 new tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Seeder Phase 1 — skeleton merge from sources

**Files:**
- Create: `scripts/seed-universe.ts` (Phase 1 only — yfinance/embed/upsert come in T9)
- Create: `tests/scripts/seed-universe.test.ts` (Phase 1 tests)
- Modify: `package.json` (add `seed-universe` script entry)

Phase 1 fetches the Nasdaq screener JSON for both NYSE + NASDAQ, fetches thematic-ETF holdings from issuer CSVs, merges by ticker, dedupes the `sources` array, and produces an in-memory `Map<ticker, SkeletonRow>`. Phases 2-4 (yfinance enrichment, embedding, upsert) land in T9.

This task ships a callable function `buildSkeleton()` that returns the merged map, plus a CLI wiring that prints summary statistics. We don't write to DB yet.

- [ ] **Step 8.1: Write failing tests**

Create `tests/scripts/seed-universe.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSkeleton, mergeSources } from '@/scripts/seed-universe';

const NASDAQ_NYSE_FIXTURE = {
  data: {
    table: {
      rows: [
        { symbol: 'AAA', name: 'Alpha Corp', country: 'United States', sector: 'Technology', industry: 'Software', marketCap: '1000000000' },
        { symbol: 'BBB', name: 'Beta Corp', country: 'Brazil', sector: 'Consumer Defensive', industry: 'Beverages', marketCap: '500000000' }
      ]
    }
  }
};

const NASDAQ_NASDAQ_FIXTURE = {
  data: {
    table: {
      rows: [
        { symbol: 'CCC', name: 'Cee Corp', country: 'China', sector: 'Technology', industry: 'Internet', marketCap: '2000000000' },
        { symbol: 'AAA', name: 'Alpha Corp', country: 'United States', sector: 'Technology', industry: 'Software', marketCap: '1000000000' }   // duplicate
      ]
    }
  }
};

// Sample iShares CSV (minimal — just headers + 2 rows)
const ISHARES_CSV = `Fund,iShares Test ETF
"Ticker","Name","Asset Class","Weight (%)"
"AAA","Alpha Corp","Equity","5.00"
"DDD","Dee Corp","Equity","3.00"
`;

describe('mergeSources', () => {
  it('dedupes by ticker and accumulates sources array', () => {
    const merged = mergeSources([
      { ticker: 'AAA', name: 'Alpha', country: null, sector: null, industry: null, exchange: 'NYSE',   marketCap: null, source: 'nyse' },
      { ticker: 'AAA', name: 'Alpha', country: null, sector: null, industry: null, exchange: 'NYSE',   marketCap: null, source: 'etf:BOTZ' },
      { ticker: 'BBB', name: 'Beta',  country: null, sector: null, industry: null, exchange: 'NASDAQ', marketCap: null, source: 'nasdaq' }
    ]);
    expect(merged.size).toBe(2);
    expect(merged.get('AAA')!.sources).toEqual(['nyse', 'etf:BOTZ']);
    expect(merged.get('BBB')!.sources).toEqual(['nasdaq']);
  });

  it('uses uppercase tickers as keys', () => {
    const merged = mergeSources([
      { ticker: 'aaa', name: 'Alpha', country: null, sector: null, industry: null, exchange: 'NYSE', marketCap: null, source: 'nyse' }
    ]);
    expect(merged.has('AAA')).toBe(true);
    expect(merged.has('aaa')).toBe(false);
  });

  it('preserves first non-null metadata field, ignores later nulls', () => {
    const merged = mergeSources([
      { ticker: 'AAA', name: 'Alpha', country: 'BR', sector: 'Tech',  industry: null, exchange: 'NYSE', marketCap: null, source: 'nyse' },
      { ticker: 'AAA', name: 'Alpha', country: null, sector: null,    industry: null, exchange: null,   marketCap: null, source: 'etf:KWEB' }
    ]);
    const row = merged.get('AAA')!;
    expect(row.country).toBe('BR');
    expect(row.sector).toBe('Tech');
  });
});

describe('buildSkeleton', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('exchange=NYSE')) {
        return Promise.resolve({ ok: true, json: async () => NASDAQ_NYSE_FIXTURE } as any);
      }
      if (url.includes('exchange=NASDAQ')) {
        return Promise.resolve({ ok: true, json: async () => NASDAQ_NASDAQ_FIXTURE } as any);
      }
      if (url.includes('ishares')) {
        return Promise.resolve({ ok: true, text: async () => ISHARES_CSV } as any);
      }
      return Promise.resolve({ ok: false, status: 404 } as any);
    });
  });

  it('merges NYSE + Nasdaq + one ETF and dedupes', async () => {
    const skeleton = await buildSkeleton({
      fetch: fetchMock,
      etfs: [{ id: 'BOTZ', issuer: 'ishares', url: 'https://ishares.com/botz-holdings.csv' }]
    });
    // Tickers: AAA (NYSE + NASDAQ + ETF), BBB (NYSE), CCC (NASDAQ), DDD (ETF)
    expect(skeleton.size).toBe(4);
    expect(skeleton.get('AAA')!.sources).toEqual(expect.arrayContaining(['nyse', 'nasdaq', 'etf:BOTZ']));
    expect(skeleton.get('BBB')!.sources).toEqual(['nyse']);
    expect(skeleton.get('DDD')!.sources).toEqual(['etf:BOTZ']);
  });

  it('skips ETFs whose fetch fails', async () => {
    const skeleton = await buildSkeleton({
      fetch: fetchMock,
      etfs: [{ id: 'BAD', issuer: 'unknown', url: 'https://nonexistent.example/holdings.csv' }]
    });
    // Should still have NYSE + NASDAQ rows
    expect(skeleton.has('AAA')).toBe(true);
  });

  it('normalizes country names to ISO codes when possible', async () => {
    const skeleton = await buildSkeleton({ fetch: fetchMock, etfs: [] });
    expect(skeleton.get('BBB')!.country).toBe('BR');   // "Brazil" → BR
    expect(skeleton.get('CCC')!.country).toBe('CN');   // "China" → CN
    expect(skeleton.get('AAA')!.country).toBe('US');
  });
});
```

- [ ] **Step 8.2: Run tests — confirm fail with module not found**

```bash
pnpm test -- tests/scripts/seed-universe.test.ts
```

Expected: 6 tests fail.

- [ ] **Step 8.3: Implement Phase 1 in `scripts/seed-universe.ts`**

Create the script:

```ts
#!/usr/bin/env tsx
/**
 * One-shot universe seeder for the discovery feature.
 * Re-runnable; idempotent. Logs progress every 100 tickers.
 *
 * Usage: pnpm seed-universe
 *
 * Phase 1: skeleton merge (Nasdaq screener + ETF holdings).
 * Phase 2: yfinance enrichment (longBusinessSummary, country, etc.).
 * Phase 3: batch embed via EmbeddingsProvider.
 * Phase 4: upsert into companies_universe.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

// ----- Public types -----

export interface SkeletonRow {
  ticker: string;
  name: string;
  exchange: string | null;     // NYSE | NASDAQ | null (ETF-only entries)
  country: string | null;      // ISO 2-letter when normalizable
  sector: string | null;
  industry: string | null;
  marketCap: string | null;    // string from screener; parsed later
  sources: string[];           // ['nyse', 'nasdaq', 'etf:BOTZ', ...]
}

interface RawRow {
  ticker: string;
  name: string;
  country: string | null;
  sector: string | null;
  industry: string | null;
  exchange: string | null;
  marketCap: string | null;
  source: string;
}

interface BuildOptions {
  fetch?: typeof fetch;
  etfs?: Array<{ id: string; issuer: 'ishares' | 'ark' | 'sectorspdr' | 'vaneck' | 'unknown'; url: string }>;
}

// ----- Curated ETF list -----

export const DEFAULT_ETFS = [
  { id: 'BOTZ', issuer: 'ishares' as const, url: 'https://www.ishares.com/us/products/239738/ishares-robotics-and-artificial-intelligence-multisector-etf/1467271812596.ajax?fileType=csv&fileName=BOTZ_holdings&dataType=fund' },
  { id: 'KWEB', issuer: 'ishares' as const, url: 'https://www.ishares.com/us/products/271281/kraneshares-csi-china-internet-etf/1467271812596.ajax?fileType=csv&fileName=KWEB_holdings&dataType=fund' },
  { id: 'EWZ',  issuer: 'ishares' as const, url: 'https://www.ishares.com/us/products/239630/ishares-msci-brazil-etf/1467271812596.ajax?fileType=csv&fileName=EWZ_holdings&dataType=fund' },
  { id: 'ARKK', issuer: 'ark' as const,     url: 'https://ark-funds.com/wp-content/uploads/funds-etf-csv/ARK_INNOVATION_ETF_ARKK_HOLDINGS.csv' },
  { id: 'ARKQ', issuer: 'ark' as const,     url: 'https://ark-funds.com/wp-content/uploads/funds-etf-csv/ARK_AUTONOMOUS_TECHNOLOGY_&_ROBOTICS_ETF_ARKQ_HOLDINGS.csv' },
  { id: 'ARKW', issuer: 'ark' as const,     url: 'https://ark-funds.com/wp-content/uploads/funds-etf-csv/ARK_NEXT_GENERATION_INTERNET_ETF_ARKW_HOLDINGS.csv' },
  { id: 'ARKG', issuer: 'ark' as const,     url: 'https://ark-funds.com/wp-content/uploads/funds-etf-csv/ARK_GENOMIC_REVOLUTION_ETF_ARKG_HOLDINGS.csv' },
  { id: 'SOXX', issuer: 'ishares' as const, url: 'https://www.ishares.com/us/products/239705/ishares-phlx-semiconductor-etf/1467271812596.ajax?fileType=csv&fileName=SOXX_holdings&dataType=fund' },
  { id: 'SMH',  issuer: 'vaneck' as const,  url: 'https://www.vaneck.com/etf/equity/smh/holdings/' },     // placeholder — VanEck format varies
  { id: 'XLK',  issuer: 'sectorspdr' as const, url: 'https://www.sectorspdrs.com/sectorspdr/IDCO.Client.Spdrs.Holdings/Export/ExcelExport?symbol=XLK' },
  { id: 'XBI',  issuer: 'sectorspdr' as const, url: 'https://www.sectorspdrs.com/sectorspdr/IDCO.Client.Spdrs.Holdings/Export/ExcelExport?symbol=XBI' },
  { id: 'ITA',  issuer: 'ishares' as const, url: 'https://www.ishares.com/us/products/239502/ishares-us-aerospace-defense-etf/1467271812596.ajax?fileType=csv&fileName=ITA_holdings&dataType=fund' }
];

// ----- Country name normalization -----

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  'United States': 'US', 'USA': 'US', 'US': 'US',
  'Brazil': 'BR', 'BR': 'BR',
  'China': 'CN', 'CN': 'CN',
  'Japan': 'JP', 'JP': 'JP',
  'United Kingdom': 'GB', 'UK': 'GB', 'GB': 'GB',
  'Germany': 'DE', 'DE': 'DE',
  'France': 'FR', 'FR': 'FR',
  'India': 'IN', 'IN': 'IN',
  'Taiwan': 'TW', 'TW': 'TW',
  'South Korea': 'KR', 'Korea': 'KR', 'KR': 'KR',
  'Hong Kong': 'HK', 'HK': 'HK',
  'Mexico': 'MX', 'MX': 'MX',
  'Italy': 'IT', 'IT': 'IT',
  'Spain': 'ES', 'ES': 'ES'
};

function normalizeCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return COUNTRY_NAME_TO_CODE[trimmed] ?? (trimmed.length === 2 ? trimmed.toUpperCase() : null);
}

// ----- Source fetchers -----

async function fetchNasdaqScreener(exchange: 'NYSE' | 'NASDAQ', fetchImpl: typeof fetch): Promise<RawRow[]> {
  const url = `https://api.nasdaq.com/api/screener/stocks?download=true&exchange=${exchange}`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 EquityResearchWorkbench/1.0' }
  } as any);
  if (!res.ok) {
    throw new Error(`Nasdaq screener ${exchange} fetch failed: ${res.status}`);
  }
  const json = await res.json() as any;
  const rows: any[] = json?.data?.table?.rows ?? json?.data?.rows ?? [];
  return rows.map((r) => ({
    ticker: String(r.symbol ?? '').toUpperCase().trim(),
    name: String(r.name ?? ''),
    country: normalizeCountry(r.country),
    sector: r.sector ?? null,
    industry: r.industry ?? null,
    exchange,
    marketCap: r.marketCap ? String(r.marketCap).replace(/[$,]/g, '') : null,
    source: exchange.toLowerCase()
  })).filter((r) => r.ticker && /^[A-Z][A-Z.]{0,5}$/.test(r.ticker));
}

async function fetchIsharesEtf(etfId: string, url: string, fetchImpl: typeof fetch): Promise<RawRow[]> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 EquityResearchWorkbench/1.0' }
  } as any);
  if (!res.ok) throw new Error(`ETF ${etfId} fetch failed: ${res.status}`);
  const text = await res.text();
  return parseIsharesCsv(text, etfId);
}

async function fetchArkEtf(etfId: string, url: string, fetchImpl: typeof fetch): Promise<RawRow[]> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 EquityResearchWorkbench/1.0' }
  } as any);
  if (!res.ok) throw new Error(`ETF ${etfId} fetch failed: ${res.status}`);
  const text = await res.text();
  return parseArkCsv(text, etfId);
}

// ----- ETF CSV parsers (best-effort; resilient to format quirks) -----

export function parseIsharesCsv(text: string, etfId: string): RawRow[] {
  const lines = text.split(/\r?\n/);
  // iShares format: first ~9 lines are fund metadata, then a header row, then data
  const headerIdx = lines.findIndex((l) => l.toLowerCase().includes('ticker') && l.toLowerCase().includes('name'));
  if (headerIdx < 0) return [];
  const header = parseCsvRow(lines[headerIdx]!);
  const tickerCol = header.findIndex((h) => /^ticker$/i.test(h));
  const nameCol = header.findIndex((h) => /^name$/i.test(h));
  if (tickerCol < 0) return [];
  const out: RawRow[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    const cols = parseCsvRow(line);
    const ticker = (cols[tickerCol] ?? '').toUpperCase().trim();
    if (!ticker || !/^[A-Z][A-Z.]{0,5}$/.test(ticker)) continue;
    const name = nameCol >= 0 ? (cols[nameCol] ?? '') : '';
    out.push({
      ticker, name,
      country: null, sector: null, industry: null,
      exchange: null, marketCap: null,
      source: `etf:${etfId}`
    });
  }
  return out;
}

export function parseArkCsv(text: string, etfId: string): RawRow[] {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  // ARK format: header row first, columns include "ticker" and "company"
  const header = parseCsvRow(lines[0]!);
  const tickerCol = header.findIndex((h) => /ticker/i.test(h));
  const nameCol = header.findIndex((h) => /company/i.test(h));
  if (tickerCol < 0) return [];
  const out: RawRow[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = parseCsvRow(line);
    const ticker = (cols[tickerCol] ?? '').toUpperCase().trim();
    if (!ticker || !/^[A-Z][A-Z.]{0,5}$/.test(ticker)) continue;
    const name = nameCol >= 0 ? (cols[nameCol] ?? '') : '';
    out.push({
      ticker, name,
      country: null, sector: null, industry: null,
      exchange: null, marketCap: null,
      source: `etf:${etfId}`
    });
  }
  return out;
}

function parseCsvRow(line: string): string[] {
  // Minimal CSV parser supporting "..." quoted fields with embedded commas.
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// ----- Merge logic -----

export function mergeSources(rows: RawRow[]): Map<string, SkeletonRow> {
  const merged = new Map<string, SkeletonRow>();
  for (const row of rows) {
    const ticker = row.ticker.toUpperCase();
    if (!ticker) continue;
    const existing = merged.get(ticker);
    if (!existing) {
      merged.set(ticker, {
        ticker, name: row.name,
        exchange: row.exchange, country: row.country, sector: row.sector, industry: row.industry,
        marketCap: row.marketCap, sources: [row.source]
      });
    } else {
      // Accumulate sources (dedupe)
      if (!existing.sources.includes(row.source)) existing.sources.push(row.source);
      // Fill in nulls from later rows
      existing.exchange ??= row.exchange;
      existing.country ??= row.country;
      existing.sector ??= row.sector;
      existing.industry ??= row.industry;
      existing.marketCap ??= row.marketCap;
    }
  }
  return merged;
}

// ----- Orchestrator -----

export async function buildSkeleton(opts: BuildOptions = {}): Promise<Map<string, SkeletonRow>> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const etfs = opts.etfs ?? DEFAULT_ETFS;

  const allRows: RawRow[] = [];

  // NYSE + NASDAQ
  for (const exch of ['NYSE', 'NASDAQ'] as const) {
    try {
      const rows = await fetchNasdaqScreener(exch, fetchImpl);
      allRows.push(...rows);
      console.log(`  [${exch}] fetched ${rows.length} rows`);
    } catch (err) {
      console.warn(`  [${exch}] fetch failed: ${String(err)}`);
    }
  }

  // ETFs
  for (const etf of etfs) {
    try {
      let rows: RawRow[] = [];
      if (etf.issuer === 'ishares' || etf.issuer === 'sectorspdr' || etf.issuer === 'vaneck') {
        rows = await fetchIsharesEtf(etf.id, etf.url, fetchImpl);
      } else if (etf.issuer === 'ark') {
        rows = await fetchArkEtf(etf.id, etf.url, fetchImpl);
      }
      allRows.push(...rows);
      console.log(`  [etf:${etf.id}] fetched ${rows.length} rows`);
    } catch (err) {
      console.warn(`  [etf:${etf.id}] fetch failed: ${String(err)}`);
    }
  }

  return mergeSources(allRows);
}

// ----- CLI entry -----

async function main() {
  console.log('Phase 1: building skeleton from public sources...');
  const skeleton = await buildSkeleton();
  console.log(`\nMerged skeleton: ${skeleton.size} unique tickers`);
  let nyseCount = 0, nasdaqCount = 0, etfOnly = 0;
  for (const row of skeleton.values()) {
    if (row.sources.includes('nyse')) nyseCount++;
    if (row.sources.includes('nasdaq')) nasdaqCount++;
    if (!row.sources.includes('nyse') && !row.sources.includes('nasdaq')) etfOnly++;
  }
  console.log(`  NYSE: ${nyseCount}, NASDAQ: ${nasdaqCount}, ETF-only: ${etfOnly}`);
  console.log('\n(Phase 2-4 land in Task 9 — yfinance enrichment, embedding, upsert)');
  process.exit(0);
}

// Only run main() when invoked as a script (not when imported by tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('seed-universe failed:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 8.4: Add `seed-universe` to `package.json` scripts**

In the `scripts` block alongside `try-13f` etc., add:

```json
"seed-universe": "tsx scripts/seed-universe.ts"
```

- [ ] **Step 8.5: Run the tests — confirm all 6 pass**

```bash
pnpm test -- tests/scripts/seed-universe.test.ts
```

Expected: 6/6 pass.

- [ ] **Step 8.6: Commit**

```bash
git add scripts/seed-universe.ts tests/scripts/seed-universe.test.ts package.json
git commit -m "$(cat <<'EOF'
feat(discover): seed-universe Phase 1 — skeleton merge from public sources

buildSkeleton fetches NYSE + NASDAQ screeners from the Nasdaq public
API, fetches 12 thematic-ETF holdings (iShares / ARK / SectorSPDR /
VanEck), normalizes country names to ISO 2-letter, merges by uppercase
ticker with deduped sources arrays. Phase 2-4 (yfinance enrich + embed
+ upsert) land in T9. 6 unit tests cover merge dedupe, country
normalization, ETF-fetch failure isolation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Seeder Phases 2-4 — yfinance + embed + upsert

**Files:**
- Modify: `scripts/seed-universe.ts` (add Phase 2-4 logic + extend main())
- Modify: `tests/scripts/seed-universe.test.ts` (add 3 tests for enrichment + batch + upsert flow)

- [ ] **Step 9.1: Append tests for enrichment + batch + upsert**

Append to `tests/scripts/seed-universe.test.ts`:

```ts
describe('enrichWithYfinance', () => {
  it('calls yfinance .info for each skeleton ticker and fills metadata', async () => {
    const { enrichWithYfinance } = await import('@/scripts/seed-universe');
    const skeleton = new Map([
      ['AAA', { ticker: 'AAA', name: 'Alpha', exchange: 'NYSE', country: 'US', sector: null, industry: null, marketCap: null, sources: ['nyse'] }],
      ['BBB', { ticker: 'BBB', name: 'Beta',  exchange: 'NYSE', country: null, sector: null, industry: null, marketCap: null, sources: ['nyse'] }]
    ] as any);

    const mockYf = {
      info: vi.fn().mockImplementation(async (ticker: string) => {
        if (ticker === 'AAA') return { longBusinessSummary: 'Alpha makes chips.', country: 'United States', sector: 'Technology', industry: 'Semiconductors', exchange: 'NMS', marketCap: 1_000_000_000, longName: 'Alpha Corporation' };
        if (ticker === 'BBB') return { longBusinessSummary: 'Beta brews beer.', country: 'Brazil', sector: 'Consumer Defensive', industry: 'Beverages-Brewers', exchange: 'NYQ', marketCap: 500_000_000, longName: 'Beta Brewery' };
        throw new Error('unknown');
      })
    };
    const enriched = await enrichWithYfinance(skeleton, mockYf as any);
    expect(enriched.get('AAA')!.description).toBe('Alpha makes chips.');
    expect(enriched.get('AAA')!.sector).toBe('Technology');     // yfinance fills sector
    expect(enriched.get('BBB')!.country).toBe('BR');             // normalized from "Brazil"
    expect(enriched.get('BBB')!.marketCap).toBe(500_000_000);
  });

  it('skips entries whose yfinance call throws (delisted/malformed)', async () => {
    const { enrichWithYfinance } = await import('@/scripts/seed-universe');
    const skeleton = new Map([
      ['AAA', { ticker: 'AAA', name: 'Alpha', exchange: 'NYSE', country: null, sector: null, industry: null, marketCap: null, sources: ['nyse'] }],
      ['ZZZ', { ticker: 'ZZZ', name: 'Delisted', exchange: 'NYSE', country: null, sector: null, industry: null, marketCap: null, sources: ['nyse'] }]
    ] as any);
    const mockYf = {
      info: vi.fn().mockImplementation(async (ticker: string) => {
        if (ticker === 'ZZZ') throw new Error('delisted');
        return { longBusinessSummary: 'ok', country: 'United States', sector: 'Tech', industry: 'Soft', exchange: 'NMS', marketCap: 1, longName: 'Alpha' };
      })
    };
    const enriched = await enrichWithYfinance(skeleton, mockYf as any);
    expect(enriched.get('AAA')!.description).toBe('ok');
    expect(enriched.get('ZZZ')!.description).toBeNull();   // preserved skeleton with null fields
  });
});

describe('batchEmbedDescriptions', () => {
  it('batches in chunks of 25 (DashScope limit)', async () => {
    const { batchEmbedDescriptions } = await import('@/scripts/seed-universe');
    const enriched = new Map();
    for (let i = 0; i < 60; i++) {
      enriched.set(`T${i}`, { ticker: `T${i}`, name: `Co ${i}`, description: `desc ${i}`, country: 'US', sector: 'Tech', industry: 'Soft', exchange: 'NYSE', marketCap: 1, sources: ['nyse'] });
    }
    const mockEmb = {
      embed: vi.fn().mockImplementation(async (req: any) => ({
        vectors: req.texts.map(() => new Array(1024).fill(0.1)),
        inputTokens: 10
      }))
    };
    const withVecs = await batchEmbedDescriptions(enriched, mockEmb as any);
    expect(mockEmb.embed).toHaveBeenCalledTimes(3);   // ceil(60/25)
    expect(withVecs.get('T0')!.embedding).toHaveLength(1024);
    expect(withVecs.get('T59')!.embedding).toHaveLength(1024);
  });

  it('skips rows with null description', async () => {
    const { batchEmbedDescriptions } = await import('@/scripts/seed-universe');
    const enriched = new Map([
      ['AAA', { ticker: 'AAA', name: 'A', description: 'has text',   country: null, sector: null, industry: null, exchange: null, marketCap: null, sources: [] }],
      ['BBB', { ticker: 'BBB', name: 'B', description: null,         country: null, sector: null, industry: null, exchange: null, marketCap: null, sources: [] }]
    ] as any);
    const mockEmb = {
      embed: vi.fn().mockResolvedValue({ vectors: [new Array(1024).fill(0.1)], inputTokens: 5 })
    };
    const withVecs = await batchEmbedDescriptions(enriched, mockEmb as any);
    expect(withVecs.get('AAA')!.embedding).toHaveLength(1024);
    expect(withVecs.get('BBB')!.embedding).toBeNull();
  });
});
```

- [ ] **Step 9.2: Run the new tests — confirm fail with imports missing**

```bash
pnpm test -- tests/scripts/seed-universe.test.ts
```

Expected: 3 new tests fail with `enrichWithYfinance is not a function` (or similar). Existing 6 still pass.

- [ ] **Step 9.3: Add Phase 2-4 to `scripts/seed-universe.ts`**

Append at the top of the file (below the imports):

```ts
import { eq } from 'drizzle-orm';
import { getServiceDb } from '@/lib/db/client';
import { companiesUniverse } from '@/lib/db/schema';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';
```

Add this to the public types:

```ts
export interface EnrichedRow extends SkeletonRow {
  description: string | null;     // yfinance longBusinessSummary
  // country/sector/industry/marketCap/name may be overwritten by yfinance
}

export interface EmbeddedRow extends EnrichedRow {
  embedding: number[] | null;     // 1024-d Qwen vector
}

// yfinance .info() shape (subset of YfInfo we care about for the seeder)
interface YfInfoLike {
  info(ticker: string): Promise<{
    longBusinessSummary: string | null;
    country: string | null;
    sector: string | null;
    industry: string | null;
    exchange: string | null;
    marketCap: number | null;
    longName: string | null;
  }>;
}

interface EmbProviderLike {
  embed(req: { model: string; texts: string[] }): Promise<{ vectors: number[][]; inputTokens: number }>;
}
```

Add the three exported functions:

```ts
export async function enrichWithYfinance(
  skeleton: Map<string, SkeletonRow>,
  yf: YfInfoLike,
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, EnrichedRow>> {
  const out = new Map<string, EnrichedRow>();
  let done = 0;
  for (const [ticker, row] of skeleton) {
    let info: Awaited<ReturnType<YfInfoLike['info']>> | null = null;
    try {
      info = await yf.info(ticker);
    } catch {
      // delisted or malformed — fall through with skeleton-only row
    }
    out.set(ticker, {
      ...row,
      name: info?.longName ?? row.name,
      description: info?.longBusinessSummary ?? null,
      country: normalizeCountry(info?.country ?? null) ?? row.country,
      sector: info?.sector ?? row.sector,
      industry: info?.industry ?? row.industry,
      exchange: info?.exchange ?? row.exchange,
      marketCap: info?.marketCap != null ? String(info.marketCap) : row.marketCap
    });
    done++;
    if (onProgress && done % 100 === 0) onProgress(done, skeleton.size);
  }
  return out;
}

const EMBED_BATCH = 25;     // DashScope limit

export async function batchEmbedDescriptions(
  enriched: Map<string, EnrichedRow>,
  emb: EmbProviderLike,
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, EmbeddedRow>> {
  const withEmbeddable = Array.from(enriched.entries()).filter(([, r]) => r.description && r.description.trim().length > 0);
  const out = new Map<string, EmbeddedRow>();
  // Carry over rows without descriptions as null embedding
  for (const [t, r] of enriched) {
    if (!r.description || !r.description.trim()) out.set(t, { ...r, embedding: null });
  }
  for (let i = 0; i < withEmbeddable.length; i += EMBED_BATCH) {
    const batch = withEmbeddable.slice(i, i + EMBED_BATCH);
    const result = await emb.embed({
      model: 'text-embedding-v4',
      texts: batch.map(([, r]) => r.description!)
    });
    for (let j = 0; j < batch.length; j++) {
      const [ticker, row] = batch[j]!;
      const vec = result.vectors[j];
      out.set(ticker, { ...row, embedding: vec ?? null });
    }
    if (onProgress) onProgress(Math.min(i + EMBED_BATCH, withEmbeddable.length), withEmbeddable.length);
  }
  return out;
}

export async function upsertUniverse(
  embedded: Map<string, EmbeddedRow>
): Promise<{ inserted: number; skipped: number }> {
  const db = getServiceDb();
  let inserted = 0;
  let skipped = 0;
  const allRows = Array.from(embedded.values());

  // Upsert in chunks of 100 to keep insert statements reasonable.
  const CHUNK = 100;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    const chunk = allRows.slice(i, i + CHUNK);
    const values = chunk.map((r) => ({
      ticker: r.ticker,
      name: r.name,
      exchange: r.exchange,
      country: r.country,
      sector: r.sector,
      industry: r.industry,
      description: r.description,
      descriptionEmbedding: r.embedding,
      marketCap: r.marketCap,
      sources: r.sources,
      lastRefreshedAt: new Date()
    }));
    try {
      await db.insert(companiesUniverse).values(values).onConflictDoUpdate({
        target: companiesUniverse.ticker,
        set: {
          name: sqlExcluded('name'),
          exchange: sqlExcluded('exchange'),
          country: sqlExcluded('country'),
          sector: sqlExcluded('sector'),
          industry: sqlExcluded('industry'),
          description: sqlExcluded('description'),
          descriptionEmbedding: sqlExcluded('description_embedding'),
          marketCap: sqlExcluded('market_cap'),
          sources: sqlExcluded('sources'),
          lastRefreshedAt: sqlExcluded('last_refreshed_at')
        }
      });
      inserted += chunk.length;
    } catch (err) {
      console.warn(`  upsert chunk ${i / CHUNK} failed: ${String(err)}`);
      skipped += chunk.length;
    }
  }
  return { inserted, skipped };
}

import { sql as drizzleSql } from 'drizzle-orm';
function sqlExcluded(col: string) {
  return drizzleSql.raw(`excluded.${col}`);
}
```

Replace the existing `main()` function with the full pipeline:

```ts
async function main() {
  console.log('Phase 1: building skeleton from public sources...');
  const skeleton = await buildSkeleton();
  console.log(`  → ${skeleton.size} unique tickers`);

  console.log('\nPhase 2: enriching with yfinance .info() (rate-limited)...');
  const yf = new YFinanceProvider();
  const enriched = await enrichWithYfinance(skeleton, yf as any, (done, total) => {
    console.log(`  yfinance progress: ${done}/${total}`);
  });
  const enrichedDescCount = Array.from(enriched.values()).filter((r) => r.description).length;
  console.log(`  → ${enrichedDescCount}/${enriched.size} have descriptions`);

  console.log('\nPhase 3: batch-embedding descriptions (Qwen text-embedding-v4)...');
  const emb = new EmbeddingsProviderImpl();
  const embedded = await batchEmbedDescriptions(enriched, emb as any, (done, total) => {
    console.log(`  embed progress: ${done}/${total}`);
  });
  const embeddedCount = Array.from(embedded.values()).filter((r) => r.embedding).length;
  console.log(`  → ${embeddedCount} embedded`);

  console.log('\nPhase 4: upserting into companies_universe...');
  const { inserted, skipped } = await upsertUniverse(embedded);
  console.log(`  → upserted ${inserted}, skipped ${skipped}`);

  console.log('\nDone.');
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('seed-universe failed:', err);
    process.exit(1);
  });
}
```

(Remove the placeholder `main()` from T8 — replaced by the full version above.)

- [ ] **Step 9.4: Run all seeder tests — confirm 9 pass**

```bash
pnpm test -- tests/scripts/seed-universe.test.ts
```

Expected: 9/9 pass (6 from T8 + 3 new).

- [ ] **Step 9.5: Commit**

```bash
git add scripts/seed-universe.ts tests/scripts/seed-universe.test.ts
git commit -m "$(cat <<'EOF'
feat(discover): seed-universe Phases 2-4 — yfinance enrich, embed, upsert

enrichWithYfinance loops the skeleton, calls yf.info per ticker,
preserves skeleton fields for delisted/failed lookups, normalizes
country to ISO. batchEmbedDescriptions batches 25 (DashScope limit),
preserves rows with null descriptions as embedding=null.
upsertUniverse writes in chunks of 100 via ON CONFLICT DO UPDATE.
3 new unit tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: UI components (cells)

**Files:**
- Create: `app/(app)/watchlist/discover/_components/discover-input.tsx`
- Create: `app/(app)/watchlist/discover/_components/discover-filter-summary.tsx`
- Create: `app/(app)/watchlist/discover/_components/discover-result-row.tsx`
- Create: `app/(app)/watchlist/discover/_components/discover-empty-state.tsx`

Four small components, all UI-only. No new tests at the component level (formatters already covered; pages tested via E2E later).

- [ ] **Step 10.1: Create `discover-input.tsx` (client)**

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

interface Props { initialQuery?: string; }

export function DiscoverInput({ initialQuery = '' }: Props) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    const qs = new URLSearchParams({ tab: 'discover', q: trimmed }).toString();
    router.push(`/watchlist?${qs}`);
  }

  return (
    <form onSubmit={onSubmit} className="flex items-center gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Describe what you're looking for — e.g. 'AI infrastructure'"
        className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        autoFocus
      />
      <Button type="submit" disabled={!value.trim()}>Search</Button>
    </form>
  );
}
```

- [ ] **Step 10.2: Create `discover-filter-summary.tsx` (server)**

```tsx
import { flagFor } from '@/lib/compute/country-flags';
import type { ParsedQuery } from '@/lib/services/discover';

interface Props { parsed: ParsedQuery; }

function fmtMarketCap(n: number | null): string {
  if (n == null) return '';
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(0)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(0)}M`;
  return `$${n.toLocaleString()}`;
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded border border-border bg-muted/30 px-2 py-0.5 text-xs">
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-medium">{value}</span>
    </span>
  );
}

export function DiscoverFilterSummary({ parsed }: Props) {
  const chips: Array<{ label: string; value: string }> = [];
  if (parsed.country) chips.push({ label: 'Country', value: `${flagFor(parsed.country)} ${parsed.country}` });
  if (parsed.sector) chips.push({ label: 'Sector', value: parsed.sector });
  if (parsed.industry) chips.push({ label: 'Industry', value: parsed.industry });
  if (parsed.exchanges.length > 0) chips.push({ label: 'Exchange', value: parsed.exchanges.join(' / ') });
  if (parsed.marketCapMin != null || parsed.marketCapMax != null) {
    const min = parsed.marketCapMin != null ? `≥ ${fmtMarketCap(parsed.marketCapMin)}` : '';
    const max = parsed.marketCapMax != null ? `≤ ${fmtMarketCap(parsed.marketCapMax)}` : '';
    chips.push({ label: 'Market cap', value: [min, max].filter(Boolean).join(', ') });
  }
  chips.push({ label: 'Concept', value: parsed.conceptText });

  return (
    <section className="space-y-1">
      <div className="text-xs text-muted-foreground">Filters detected:</div>
      <div className="flex flex-wrap items-baseline gap-2">
        {chips.map((c, i) => <Chip key={i} {...c} />)}
      </div>
    </section>
  );
}
```

- [ ] **Step 10.3: Create `discover-result-row.tsx` (server)**

```tsx
import Link from 'next/link';
import { flagFor } from '@/lib/compute/country-flags';
import type { DiscoverResult } from '@/lib/services/discover';

interface Props { result: DiscoverResult; }

function truncate(s: string | null, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

export function DiscoverResultRow({ result }: Props) {
  const pct = Math.round(result.similarity * 100);
  return (
    <li className="border-b border-border py-3 last:border-0">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2 min-w-0">
          <Link
            href={`/stock/${result.ticker}`}
            className="font-mono font-medium tabular-nums text-base hover:text-primary"
          >
            {result.ticker}
          </Link>
          <span className="text-sm truncate">{result.name}</span>
        </div>
        <div className="flex items-baseline gap-2 text-xs text-muted-foreground shrink-0">
          {result.country && <span>{flagFor(result.country)}</span>}
          {result.sector && <span>{result.sector}</span>}
          <span className="font-medium text-foreground">{pct}%</span>
        </div>
      </div>
      {result.description && (
        <div className="mt-1 text-xs text-muted-foreground">
          {truncate(result.description, 180)}
        </div>
      )}
    </li>
  );
}
```

- [ ] **Step 10.4: Create `discover-empty-state.tsx` (server)**

```tsx
import Link from 'next/link';

const EXAMPLES = [
  'AI infrastructure',
  'Brazilian CPG on US exchanges',
  'Chinese internet ADRs',
  'small-cap healthcare AI'
];

export function DiscoverEmptyState() {
  return (
    <section className="space-y-3 py-8 text-center">
      <div className="text-sm text-muted-foreground">
        Search the universe of ~6,500 NYSE + Nasdaq + ETF-tracked companies.
      </div>
      <div className="text-xs text-muted-foreground">
        Try:
      </div>
      <ul className="space-y-1.5">
        {EXAMPLES.map((q) => (
          <li key={q}>
            <Link
              href={`/watchlist?tab=discover&q=${encodeURIComponent(q)}`}
              className="text-sm text-primary hover:underline"
            >
              "{q}"
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 10.5: Typecheck + lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: clean.

- [ ] **Step 10.6: Commit**

```bash
git add "app/(app)/watchlist/discover/_components/"
git commit -m "$(cat <<'EOF'
feat(discover): 4 UI components for /watchlist?tab=discover

DiscoverInput: client search input that pushes ?q= on submit.
DiscoverFilterSummary: server, renders parsed-filter chips (country flag,
sector, exchanges, market-cap range, concept text).
DiscoverResultRow: server, one row per result with ticker link, name,
country flag, sector, similarity %, truncated description.
DiscoverEmptyState: server, 4 clickable example queries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: `/discover` page + tab nav

**Files:**
- Create: `app/(app)/watchlist/discover/page.tsx`
- Modify: `app/(app)/watchlist/_components/watchlist-tabs.tsx` (add `'discover'`)
- Modify: `app/(app)/watchlist/page.tsx` (route `?tab=discover` to redirect)

- [ ] **Step 11.1: Create `app/(app)/watchlist/discover/page.tsx`**

```tsx
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { getRedisCache } from '@/lib/cache/redis';
import { QwenProviderImpl } from '@/lib/providers/qwen';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';
import { DiscoverService } from '@/lib/services/discover';
import { WatchlistTabs } from '../_components/watchlist-tabs';
import { DiscoverInput } from './_components/discover-input';
import { DiscoverFilterSummary } from './_components/discover-filter-summary';
import { DiscoverResultRow } from './_components/discover-result-row';
import { DiscoverEmptyState } from './_components/discover-empty-state';

interface PageProps {
  searchParams: { q?: string };
}

export default async function DiscoverPage({ searchParams }: PageProps) {
  await requireUserId();
  const q = searchParams.q?.trim() ?? '';

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Watchlist</h1>
        <WatchlistTabs active="discover" />
      </header>

      <div className="space-y-4">
        <DiscoverInput initialQuery={q} />

        {q === '' ? (
          <DiscoverEmptyState />
        ) : (
          /* @ts-expect-error Async Server Component */
          <DiscoverResults query={q} />
        )}
      </div>
    </div>
  );
}

async function DiscoverResults({ query }: { query: string }) {
  const svc = new DiscoverService({
    db: getServiceDb(),
    qwenProvider: new QwenProviderImpl(),
    embeddingsProvider: new EmbeddingsProviderImpl(),
    redis: getRedisCache()
  });

  const parsed = await svc.parseQuery(query);
  const results = await svc.search(query, 20, parsed);

  return (
    <div className="space-y-4">
      <DiscoverFilterSummary parsed={parsed} />
      {results.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matches found.</p>
      ) : (
        <section>
          <div className="text-xs text-muted-foreground mb-2">
            {results.length} {results.length === 1 ? 'match' : 'matches'}
          </div>
          <ul className="space-y-0">
            {results.map((r) => (
              <DiscoverResultRow key={r.ticker} result={r} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
```

The `@ts-expect-error` may not be needed; T4 of the watchlist roll-up showed the project's tsconfig handles async server components natively. Try without; add back if typecheck complains.

- [ ] **Step 11.2: Add `'discover'` to `<WatchlistTabs>`**

Open `app/(app)/watchlist/_components/watchlist-tabs.tsx`. Add `'discover'` to the `WatchlistTab` union (between `'list'` and `'search'`):

```tsx
export type WatchlistTab = 'rollup' | 'list' | 'discover' | 'search' | 'ask';
```

Add a new `TabsTrigger` for `'discover'` after the `'list'` trigger. Mirror the existing trigger style (the file uses shadcn `Tabs` with `value/onValueChange` router-push from T6 of the watchlist roll-up). The trigger should display the label "Discover".

When `'discover'` is selected, the `setTab` handler should push `/watchlist?tab=discover` (preserving any existing `q` from the URL).

- [ ] **Step 11.3: Wire `?tab=discover` in `app/(app)/watchlist/page.tsx`**

Currently the page handles `tab === 'rollup'` and falls through to the legacy list/search/ask layout for other values. The cleanest pattern is to **redirect** to the nested `/watchlist/discover` route when `tab === 'discover'`:

Open `app/(app)/watchlist/page.tsx`. After the `tab === 'rollup'` branch, add (before the fallback render):

```tsx
import { redirect } from 'next/navigation';
// ... at the top with other imports

// inside the page function, after the tab parsing:
if (tab === 'discover') {
  const qs = new URLSearchParams();
  if (searchParams.q) qs.set('q', searchParams.q);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  redirect(`/watchlist/discover${suffix}`);
}
```

The DiscoverPage at `/watchlist/discover/page.tsx` renders the full page with tabs and content, so the redirect preserves the deep-link semantic.

- [ ] **Step 11.4: Typecheck + lint + tests**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: clean.

- [ ] **Step 11.5: Commit**

```bash
git add "app/(app)/watchlist/discover/page.tsx" \
        "app/(app)/watchlist/_components/watchlist-tabs.tsx" \
        "app/(app)/watchlist/page.tsx"
git commit -m "$(cat <<'EOF'
feat(discover): /watchlist/discover page + tab nav update

Adds 'discover' to the 5-tab union, positioned between List and
Search. Bare /watchlist?tab=discover redirects to /watchlist/discover
preserving ?q=. Discover page server-renders <DiscoverInput> +
empty-state-or-results (with parsed-filter chips, similarity %).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Push + CI + seed universe + browser smoke

**Files:** none modified; rollout task.

- [ ] **Step 12.1: Push to GitHub**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git push origin master
```

- [ ] **Step 12.2: Watch CI to green**

```bash
gh run list --limit 1 --json status,databaseId,headSha
gh run watch <run-id> --exit-status
```

Expected: exits 0.

- [ ] **Step 12.3: Run the seeder against the prod Neon branch**

```bash
pnpm seed-universe 2>&1 | tee /tmp/seed-universe.log
```

Expected runtime: 25-45 minutes. Progress logs every 100 tickers during enrichment + embedding phases. Some yfinance failures are expected — they're warn-logged and the script continues.

Verify final population:

```bash
pnpm exec tsx -e "
import { config } from 'dotenv'; config({ path: '.env.local' });
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL_SERVICE_ROLE!, { prepare: false, max: 1 });
const total = await sql\`SELECT COUNT(*)::int as c FROM companies_universe\`;
const withEmb = await sql\`SELECT COUNT(*)::int as c FROM companies_universe WHERE description_embedding IS NOT NULL\`;
const byCountry = await sql\`SELECT country, COUNT(*)::int as c FROM companies_universe GROUP BY country ORDER BY c DESC LIMIT 10\`;
console.log('Total rows:', total[0].c);
console.log('With embedding:', withEmb[0].c);
console.log('Top 10 countries:');
for (const r of byCountry) console.log(\`  \${r.country ?? '(null)'}: \${r.c}\`);
await sql.end();
process.exit(0);
"
```

Expected: 5,500-7,000 total rows; 5,000-6,500 with embedding; top countries dominated by US with BR/CN/JP/KR/GB/DE appearing.

- [ ] **Step 12.4: Browser smoke on Vercel**

Wait ~30s for Vercel deploy, then in the browser:

1. https://equity-research-workbench-mauve.vercel.app/watchlist?tab=discover — empty state with 4 example queries.
2. Click "AI infrastructure" — page reloads, shows parsed filters (Sector: Technology), top results should include NVDA, AVGO, TSM, AMD, MU, ANET, SMCI in the top 10.
3. Type "Brazilian CPG on US exchanges" + Submit. Parsed filters should show 🇧🇷 BR / Consumer Defensive / NYSE+NASDAQ. Results should include ABEV, NTCO at the top.
4. Type "Chinese internet ADRs" + Submit. Parsed filters: 🇨🇳 CN / Technology / NYSE+NASDAQ. Results: BABA, JD, PDD, BIDU, NTES at the top.
5. Click any result ticker → opens `/stock/[ticker]` overview correctly.
6. Verify 5-tab nav: Roll-up · List · Discover · Search · Ask.

- [ ] **Step 12.5: No commit step — rollout only**

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `companies_universe` table + 1024-d vector + HNSW + RLS | T1 |
| Drizzle schema in sync | T1.6 |
| `lib/compute/country-flags.ts` ISO→emoji | T2 |
| Python `kind=info` handler | T3 |
| TS `YFinanceProvider.info()` method | T3 |
| Locked v1 LLM prompt at `discover-prompts.ts` | T4 |
| `DiscoverService.parseQuery` with Zod validation + fallback | T5 |
| Country code ISO whitelist | T5 (Zod transform) |
| `DiscoverService.search` with prefilter + pgvector cosine | T6 |
| Zero-prefilter fallback to full universe | T6 |
| Skip rows with null embedding | T6 |
| `POST /api/discover` with auth + rate limit + Zod body | T7 |
| RLS smoke (authenticated SELECT works, INSERT denied) | T7 |
| `scripts/seed-universe.ts` Phase 1: Nasdaq screener + 12 ETFs + merge | T8 |
| Country name → ISO normalization | T8 |
| `scripts/seed-universe.ts` Phase 2-4: enrich + embed + upsert | T9 |
| Batch size 25 for DashScope | T9 |
| `<DiscoverInput>` client search box | T10 |
| `<DiscoverFilterSummary>` chip display | T10 |
| `<DiscoverResultRow>` with ticker link + similarity % | T10 |
| `<DiscoverEmptyState>` with example queries | T10 |
| `/watchlist/discover/page.tsx` server-rendered | T11 |
| `'discover'` added to `WatchlistTabs` union | T11 |
| `/watchlist?tab=discover` redirects to `/watchlist/discover` | T11 |
| Push + CI + seed + browser smoke | T12 |

All spec requirements have a task. No gaps.
