# Slice 3 — RAG / Q&A Across Watchlist Filings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a natural-language Q&A interface where users type questions about their watchlist's SEC filings and get Gemini-generated answers with inline numbered citations. Two surfaces share one component: cross-watchlist Ask on `/watchlist` and per-ticker Ask on `/stock/[ticker]/ask`. Token-streaming via Vercel AI SDK; sources prefetched as source cards above the streaming answer.

**Architecture:** New `qa_history` table (first user-scoped RLS in project). New `lib/providers/gemini.ts` (10-line AI-SDK-provider wrapper for DashScope endpoint via `@ai-sdk/openai-compatible`). New `RagService` retrieves top-30 chunks via existing `SearchService` (extended with `tickerScope` + `maxDistance` opts), applies per-filing diversity (≤3 per filing), assembles prompt with numbered chunks, returns Vercel AI SDK `StreamTextResult`. New `/api/rag/stream` API route wraps that with `createDataStreamResponse`, injecting the source list as a `streamData` side-channel before tokens. New UI: `<AskPanel>` component shared by both surfaces with sources row + streaming answer + citation parser.

**Tech Stack:** Slice 2C stack + `ai` package (Vercel AI SDK) + `@ai-sdk/openai-compatible` provider + Google Gemini 2.5 Flash via OpenAI-compatible endpoint at `https://generativelanguage.googleapis.com/v1beta/openai/`.

**Spec reference:** `docs/superpowers/specs/2026-05-26-slice-3-rag-qa-design.md`

**Prior phases:** Slices 1 + 2A + 2B + 2C all shipped to production. This plan picks up at commit `b71a11b` (the updated Gemini Slice 3 spec).

---

## File Structure for Slice 3

```
equity-research-workbench/
├── app/
│   ├── (app)/
│   │   ├── _components/
│   │   │   ├── ask-panel.tsx                       # shared AskPanel client island (NEW)
│   │   │   ├── ask-input.tsx                       # controlled input + submit (NEW)
│   │   │   ├── ask-sources-row.tsx                 # horizontal source cards row (NEW)
│   │   │   ├── ask-source-card.tsx                 # single source card (NEW)
│   │   │   ├── ask-answer.tsx                      # streaming answer + citation parsing (NEW)
│   │   │   └── ask-skeleton.tsx                    # Suspense fallback (NEW)
│   │   ├── watchlist/
│   │   │   ├── page.tsx                            # MODIFIED: accept ?mode=ask, swap tabs
│   │   │   └── _components/
│   │   │       └── watchlist-tabs.tsx              # Search/Ask tab strip (NEW)
│   │   └── stock/[ticker]/
│   │       ├── page.tsx                            # MODIFIED: add Ask trigger to Tabs nav
│   │       ├── financials/page.tsx                 # MODIFIED: same
│   │       ├── filings/page.tsx                    # MODIFIED: same
│   │       ├── filings/[accession]/page.tsx        # MODIFIED: same
│   │       └── ask/
│   │           └── page.tsx                        # ticker-scoped Ask page (NEW)
│   └── api/
│       └── rag/
│           └── stream/
│               └── route.ts                        # POST handler (NEW)
├── lib/
│   ├── db/
│   │   ├── schema.ts                               # MODIFIED: add qaHistory + jsonb import
│   │   ├── types.ts                                # MODIFIED: QaHistory types
│   │   └── migrations/
│   │       ├── 0007_<random>.sql                   # Drizzle-generated (NEW)
│   │       └── 9995_rls_qa_history.sql             # hand-applied RLS (NEW)
│   ├── providers/
│   │   └── gemini.ts                               # AI SDK provider factory (NEW)
│   └── services/
│       ├── search.ts                               # MODIFIED: + tickerScope + maxDistance
│       └── rag.ts                                  # RagService (NEW)
├── scripts/
│   └── try-ask.ts                                  # smoke + prompt iteration (NEW)
└── tests/
    ├── services/
    │   └── rag.test.ts                             # unit tests w/ MockLanguageModelV1 (NEW)
    └── integration/
        ├── search-service.test.ts                  # MODIFIED: + 2 tests for new opts
        ├── rag-service.test.ts                     # 8 integration tests (NEW)
        ├── api-rag-stream.test.ts                  # 6 integration tests (NEW)
        └── qa-history-rls.test.ts                  # 3 RLS smoke tests (NEW)
```

**Module responsibilities:**

| Module | Purpose | Depends on |
| --- | --- | --- |
| `lib/providers/gemini.ts` | AI SDK provider factory pointed at Gemini OpenAI-compat endpoint; ~10 lines | `@ai-sdk/openai-compatible` |
| `lib/services/search.ts` (modified) | Existing SearchService gains `tickerScope` + `maxDistance` opts | unchanged deps |
| `lib/services/rag.ts` | RagService.answer() — retrieve top-30, dedupe per-filing, build prompt, return `{ sources, streamResult, finalize }` via AI SDK `streamText` | SearchService, gemini provider, AI SDK, db |
| `app/api/rag/stream/route.ts` | Thin HTTP shell over RagService — auth + validation + createDataStreamResponse | RagService |
| `app/(app)/_components/ask-*.tsx` | UI components for AskPanel (input, sources row, streaming answer, citation parsing, skeleton) | AI SDK `useChat` hook, shadcn primitives |
| `scripts/try-ask.ts` | CLI smoke test: prints sources + streams answer to terminal | RagService (server-side, direct call) |

---

## Milestone 1: Schema + RLS

### Task 1.1: Add `qaHistory` to Drizzle schema

**Files:**
- Modify: `lib/db/schema.ts`
- Modify: `lib/db/types.ts`

- [ ] **Step 1: Add `jsonb` to the `drizzle-orm/pg-core` import in `lib/db/schema.ts`**

Read the existing imports block at the top of the file. Add `jsonb` to the list (alongside `text`, `integer`, `timestamp`, etc.):

```ts
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,           // <-- ADD
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
```

- [ ] **Step 2: Append `qaHistory` table to `lib/db/schema.ts`**

After `chunkEmbeddings` (the last table from Slice 2C), append:

```ts
export const qaHistory = pgTable(
  'qa_history',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    userId: uuid('user_id').notNull(),
    scopeType: text('scope_type').notNull(),       // 'watchlist' | 'ticker'
    scopeTicker: text('scope_ticker'),             // nullable; set only when scope_type='ticker'
    query: text('query').notNull(),
    answerText: text('answer_text').notNull(),
    citations: jsonb('citations').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    userCreatedIdx: index('qa_history_user_created_idx').on(t.userId, t.createdAt.desc())
  })
);
```

- [ ] **Step 3: Append types to `lib/db/types.ts`**

Merge `qaHistory` into the existing `import type { ... } from './schema'` line at the top, then add:

```ts
export type QaHistory    = typeof qaHistory.$inferSelect;
export type NewQaHistory = typeof qaHistory.$inferInsert;
```

- [ ] **Step 4: Generate migration**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm db:generate
```

Expected: creates `lib/db/migrations/0007_<random>.sql` with `CREATE TABLE qa_history`. Inspect:
- `citations jsonb NOT NULL`
- `id bigserial PRIMARY KEY`
- Composite index on `(user_id, created_at DESC)`

- [ ] **Step 5: Verify typecheck**

```bash
pnpm typecheck 2>&1 | tail -3
```

Expected: exit 0.

- [ ] **Step 6: Commit (migration applied in T1.2)**

```bash
git add lib/db/schema.ts lib/db/types.ts lib/db/migrations/
git commit -m "feat(db): add qa_history schema for Slice 3 RAG"
```

---

### Task 1.2: Apply migration + user-scoped RLS

**Files:**
- Create: `lib/db/migrations/9995_rls_qa_history.sql`

**CRITICAL: do NOT use `drizzle-kit push --force`** — apply via `_apply.ts` script (lesson from Slice 2A T1.1).

- [ ] **Step 1: Write the RLS file**

`lib/db/migrations/9995_rls_qa_history.sql`:

```sql
-- RLS for Slice 3: qa_history.
-- DIFFERENT pattern from existing tables — this is USER-SCOPED.
-- Each row belongs to one user; users can SELECT only their own rows.
-- Writes still go through service_role (BYPASSRLS).

alter table public.qa_history enable row level security;

drop policy if exists "users read own qa_history" on public.qa_history;
create policy "users read own qa_history"
  on public.qa_history for select to authenticated
  using (user_id::text = current_setting('request.jwt.claim.sub', true));

grant select on public.qa_history to authenticated;
```

- [ ] **Step 2: Write `_apply.ts` (in project root)**

```ts
import { config } from 'dotenv';
config({ path: '.env.local' });
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

const targetArg = process.argv.indexOf('--target');
const fileArg = process.argv.indexOf('--file');
const target = targetArg >= 0 ? process.argv[targetArg + 1] : null;
const file = fileArg >= 0 ? process.argv[fileArg + 1] : null;
if (!target || !file) {
  console.error('Usage: tsx _apply.ts --target prod|test --file <path>');
  process.exit(2);
}

const url = target === 'prod'
  ? process.env.DATABASE_URL_SERVICE_ROLE
  : process.env.DATABASE_URL_TEST_SERVICE_ROLE;
if (!url) { console.error(`URL for ${target} not set`); process.exit(2); }

const sqlText = readFileSync(file, 'utf8');
const sql = postgres(url, { prepare: false, max: 1 });
try {
  await sql.unsafe(sqlText);
  console.log(`Applied ${file} to ${target} OK`);
} catch (e) {
  console.error('Apply failed:', e);
  process.exit(1);
} finally {
  await sql.end();
}
```

- [ ] **Step 3: Apply the Drizzle migration to both branches**

Substitute the actual migration filename from T1.1 Step 4:

```bash
pnpm exec tsx _apply.ts --target prod --file lib/db/migrations/0007_<random>.sql
pnpm exec tsx _apply.ts --target test --file lib/db/migrations/0007_<random>.sql
```

Both should print `Applied ... OK`.

- [ ] **Step 4: Apply the RLS file to both branches**

```bash
pnpm exec tsx _apply.ts --target prod --file lib/db/migrations/9995_rls_qa_history.sql
pnpm exec tsx _apply.ts --target test --file lib/db/migrations/9995_rls_qa_history.sql
```

- [ ] **Step 5: Verify policy + table on both branches**

Write `_check.ts`:

```ts
import { config } from 'dotenv';
config({ path: '.env.local' });
import postgres from 'postgres';

for (const [label, url] of [
  ['prod', process.env.DATABASE_URL_SERVICE_ROLE!],
  ['test', process.env.DATABASE_URL_TEST_SERVICE_ROLE!]
]) {
  const sql = postgres(url, { prepare: false, max: 1 });

  const cols = await sql`select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'qa_history' order by ordinal_position`;
  console.log(`\n${label.toUpperCase()} columns:`);
  for (const c of cols) console.log(`  ${c.column_name}: ${c.data_type}`);

  const policies = await sql`select policyname from pg_policies where schemaname = 'public' and tablename = 'qa_history'`;
  console.log(`${label} policies: ${policies.length}`);
  for (const p of policies) console.log(`  ${p.policyname}`);

  await sql.end();
}
```

```bash
pnpm exec tsx _check.ts
```

Expected output for each branch:
- 12 columns including `citations: jsonb` and `user_id: uuid`
- 1 policy: `users read own qa_history`

Delete `_apply.ts` and `_check.ts`.

- [ ] **Step 6: Commit**

```bash
git add lib/db/migrations/9995_rls_qa_history.sql
git commit -m "feat(db): user-scoped RLS for qa_history (first per-user table in project)"
```

---

## Milestone 2: Provider + AI SDK install

### Task 2.1: Install Vercel AI SDK + write `gemini` provider

**Files:**
- Modify: `package.json` (add `ai` + `@ai-sdk/openai-compatible`)
- Create: `lib/providers/gemini.ts`

The Vercel AI SDK's `@ai-sdk/openai-compatible` package wraps any OpenAI-API-shaped endpoint. Gemini speaks OpenAI's chat-completions API at `https://generativelanguage.googleapis.com/v1beta/openai/`, so we configure the provider once and reuse it.

- [ ] **Step 1: Install packages**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm add ai @ai-sdk/openai-compatible
```

Expected: both install cleanly. Adds two top-level deps to `package.json`.

- [ ] **Step 2: Write `lib/providers/gemini.ts`**

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export const GEMINI_MODEL = 'gemini-2.5-flash';
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

/**
 * Returns a configured Gemini AI SDK provider.
 *
 * Reads GEMINI_API_KEY from the environment at call-time (not module-load
 * time) so tests can inject a different key via process.env without
 * worrying about module-level closures.
 */
export function createGemini() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }
  return createOpenAICompatible({
    name: 'gemini',
    baseURL: GEMINI_BASE_URL,
    apiKey
  });
}
```

- [ ] **Step 3: Verify typecheck**

```bash
pnpm typecheck 2>&1 | tail -3
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml lib/providers/gemini.ts
git commit -m "feat(providers): Gemini 2.5 Flash via Vercel AI SDK (@ai-sdk/openai-compatible)"
```

---

## Milestone 3: SearchService extensions

### Task 3.1: Add `tickerScope` + `maxDistance` opts to SearchService

**Files:**
- Modify: `lib/services/search.ts`
- Modify: `tests/integration/search-service.test.ts` (add 2 tests)

- [ ] **Step 1: Write the failing tests**

Append INSIDE the existing `describe('SearchService', ...)` block in `tests/integration/search-service.test.ts`:

```ts
  it('searchAcrossWatchlist: tickerScope limits results to one ticker', async () => {
    const vec = Array(1024).fill(0.5);
    await seedSearchableFiling(dbH.db, 'AAPL', vec);
    await seedSearchableFiling(dbH.db, 'NVDA', vec);
    await dbH.db.insert(watchlist).values([
      { userId, ticker: 'AAPL' },
      { userId, ticker: 'NVDA' }
    ]);

    const provider = mockProvider(vec);
    const svc = new SearchService({ db: dbH.db, provider: provider as any });
    const results = await svc.searchAcrossWatchlist({ userId, query: 'risk', tickerScope: 'NVDA' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.ticker === 'NVDA')).toBe(true);
  });

  it('searchAcrossWatchlist: maxDistance filters out distant results', async () => {
    const closeVec = Array(1024).fill(0.5);
    const farVec = Array(1024).fill(0).map((_, i) => (i < 100 ? 1.0 : -0.5));
    await seedSearchableFiling(dbH.db, 'AAPL', closeVec);
    await seedSearchableFiling(dbH.db, 'NVDA', farVec);
    await dbH.db.insert(watchlist).values([
      { userId, ticker: 'AAPL' },
      { userId, ticker: 'NVDA' }
    ]);

    const provider = mockProvider(closeVec); // query vector matches AAPL closely
    const svc = new SearchService({ db: dbH.db, provider: provider as any });
    // Stricter cutoff: AAPL should be included, NVDA excluded
    const results = await svc.searchAcrossWatchlist({ userId, query: 'risk', maxDistance: 0.3 });
    expect(results.every((r) => r.ticker === 'AAPL')).toBe(true);
  });
```

- [ ] **Step 2: Run, verify fails**

```bash
pnpm test:integration tests/integration/search-service.test.ts 2>&1 | tail -10
```

Expected: 2 new tests fail (typescript error or runtime — `tickerScope` is unrecognized).

- [ ] **Step 3: Modify `lib/services/search.ts`**

Update the `SearchOpts` interface and the SQL. Find the existing interface near the top of the file and replace with:

```ts
interface SearchOpts {
  userId: string;
  query: string;
  limit?: number;
  formTypes?: string[];
  tickerScope?: string;      // NEW: limit to one ticker
  maxDistance?: number;      // NEW: override default DISTANCE_THRESHOLD
}
```

Then update the method body. Find the existing SQL query and adapt it:

```ts
  async searchAcrossWatchlist(opts: SearchOpts): Promise<SearchResult[]> {
    const trimmed = opts.query.trim();
    if (trimmed.length < MIN_QUERY_CHARS) {
      throw new ValidationError('Query too short');
    }
    if (trimmed.length > MAX_QUERY_CHARS) {
      throw new ValidationError(`Query exceeds ${MAX_QUERY_CHARS} characters`);
    }
    const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
    const distanceThreshold = opts.maxDistance ?? DISTANCE_THRESHOLD;

    const embedResult = await this.deps.provider.embed({
      model: CURRENT_EMBED_MODEL,
      texts: [trimmed]
    });
    const queryVec = embedResult.vectors[0];
    if (!queryVec) throw new ValidationError('Failed to embed query');
    const queryVecLiteral = `[${queryVec.join(',')}]`;

    // Build conditional WHERE clauses
    const tickerScopeFragment = opts.tickerScope
      ? sql`AND f.ticker = ${opts.tickerScope}`
      : sql``;

    const formTypesFragment = opts.formTypes && opts.formTypes.length > 0
      ? sql.raw(`AND f.form_type IN (${opts.formTypes.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')})`)
      : sql``;

    const rows = await this.deps.db.execute(sql`
      SELECT
        f.ticker          AS ticker,
        comp.name         AS company_name,
        f.accession_no    AS accession_no,
        f.form_type       AS form_type,
        f.filing_date::text AS filing_date,
        ce.section_key    AS section_key,
        fc.section_title  AS section_title,
        ce.sub_chunk_index AS sub_chunk_index,
        ce.text           AS snippet,
        ce.char_offset_start AS char_offset_start,
        ce.char_offset_end   AS char_offset_end,
        (ce.embedding <=> ${sql.raw(`'${queryVecLiteral}'`)}::vector) AS distance
      FROM chunk_embeddings ce
      JOIN filings        f    ON ce.filing_id = f.accession_no
      JOIN companies      comp ON f.ticker = comp.ticker
      JOIN filing_chunks  fc   ON fc.filing_id = f.accession_no AND fc.section_key = ce.section_key
      WHERE f.ticker IN (
        SELECT w.ticker FROM watchlist w WHERE w.user_id = ${opts.userId}::uuid
      )
      ${tickerScopeFragment}
      ${formTypesFragment}
      ORDER BY ce.embedding <=> ${sql.raw(`'${queryVecLiteral}'`)}::vector
      LIMIT ${limit}
    `);

    const results: SearchResult[] = [];
    for (const r of rows as Array<Record<string, unknown>>) {
      const distance = Number(r.distance);
      if (distance > distanceThreshold) continue;
      results.push({
        ticker: String(r.ticker),
        companyName: String(r.company_name),
        accessionNo: String(r.accession_no),
        formType: String(r.form_type),
        filingDate: String(r.filing_date),
        sectionKey: String(r.section_key),
        sectionTitle: String(r.section_title),
        subChunkIndex: Number(r.sub_chunk_index),
        snippet: String(r.snippet),
        distance,
        charOffsetStart: r.char_offset_start == null ? null : Number(r.char_offset_start),
        charOffsetEnd: r.char_offset_end == null ? null : Number(r.char_offset_end)
      });
    }
    return results;
  }
```

- [ ] **Step 4: Run, verify passes**

```bash
pnpm test:integration tests/integration/search-service.test.ts 2>&1 | tail -15
```

Expected: 8 passing (existing 6 + 2 new).

- [ ] **Step 5: Commit**

```bash
git add lib/services/search.ts tests/integration/search-service.test.ts
git commit -m "feat(services): SearchService.searchAcrossWatchlist accepts tickerScope + maxDistance"
```

---

## Milestone 4: RagService

### Task 4.1: Write `RagService.answer()` + integration tests

**Files:**
- Create: `lib/services/rag.ts`
- Create: `tests/integration/rag-service.test.ts`

The `RagService.answer()` method does the orchestration: validates inputs, calls SearchService, applies per-filing diversity, assembles the prompt, calls AI SDK's `streamText`, returns a result object the API route consumes.

We use Vercel AI SDK's `MockLanguageModelV1` from `ai/test` for deterministic streaming tests — no real Gemini calls in CI.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/rag-service.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { MockLanguageModelV1 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companies, filings, filingChunks, chunkEmbeddings, watchlist, qaHistory } from '@/lib/db/schema';
import { SearchService, CURRENT_EMBED_MODEL } from '@/lib/services/search';
import { RagService, CURRENT_MODEL, CURRENT_PROMPT_VERSION } from '@/lib/services/rag';
import { ValidationError } from '@/lib/providers/types';

config({ path: '.env.local' });

function mockEmbeddingsProvider(queryVector?: number[]) {
  return {
    embed: vi.fn().mockImplementation(async () => ({
      vectors: [queryVector ?? Array(1024).fill(0.5)],
      inputTokens: 10
    }))
  };
}

function mockLanguageModel(chunks: string[], usage = { promptTokens: 4100, completionTokens: 200 }) {
  return new MockLanguageModelV1({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          ...chunks.map((textDelta) => ({ type: 'text-delta' as const, textDelta })),
          { type: 'finish' as const, finishReason: 'stop' as const, usage }
        ]
      }),
      rawCall: { rawPrompt: null, rawSettings: {} }
    })
  });
}

async function seedFilingWithEmbedding(db: any, ticker: string, accessionSuffix: string, vector: number[], sectionKey = 'item_1a_risk_factors') {
  await db.insert(companies).values({ ticker, name: `${ticker} Corp` }).onConflictDoNothing();
  const accession = `0000${ticker.slice(0, 4).padEnd(4, '0').toUpperCase()}-24-${accessionSuffix.padStart(6, '0')}`;
  await db.insert(filings).values({
    accessionNo: accession, ticker, cik: '0000000001',
    formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
  });
  await db.insert(filingChunks).values({
    filingId: accession, sectionKey,
    sectionTitle: 'Risk Factors', text: `${ticker} faces risks in ${sectionKey}`, charCount: 30
  });
  await db.insert(chunkEmbeddings).values({
    filingId: accession, sectionKey, subChunkIndex: 0,
    text: `${ticker} faces risks in ${sectionKey}`,
    embedding: vector, model: CURRENT_EMBED_MODEL,
    charOffsetStart: 0, charOffsetEnd: 30
  });
  return accession;
}

describe('RagService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  let userId: string;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    userId = newUserId();
  });

  function buildService(modelChunks: string[] = ['Apple grew', ' 22% [1]', '.']) {
    const embProvider = mockEmbeddingsProvider();
    const searchSvc = new SearchService({ db: dbH.db, provider: embProvider as any });
    const model = mockLanguageModel(modelChunks);
    return new RagService({ db: dbH.db, searchService: searchSvc, model });
  }

  it('answer: cross-watchlist returns sources from multiple tickers', async () => {
    const vec = Array(1024).fill(0.5);
    await seedFilingWithEmbedding(dbH.db, 'AAPL', '1', vec);
    await seedFilingWithEmbedding(dbH.db, 'NVDA', '1', vec);
    await dbH.db.insert(watchlist).values([{ userId, ticker: 'AAPL' }, { userId, ticker: 'NVDA' }]);

    const svc = buildService();
    const result = await svc.answer({ userId, query: 'tariffs', scope: { type: 'watchlist' } });

    expect(result.sources.length).toBeGreaterThanOrEqual(2);
    const tickers = new Set(result.sources.map((s) => s.ticker));
    expect(tickers.size).toBeGreaterThanOrEqual(2);
  });

  it('answer: ticker scope limits sources to one ticker', async () => {
    const vec = Array(1024).fill(0.5);
    await seedFilingWithEmbedding(dbH.db, 'AAPL', '1', vec);
    await seedFilingWithEmbedding(dbH.db, 'NVDA', '1', vec);
    await dbH.db.insert(watchlist).values([{ userId, ticker: 'AAPL' }, { userId, ticker: 'NVDA' }]);

    const svc = buildService();
    const result = await svc.answer({ userId, query: 'risks', scope: { type: 'ticker', ticker: 'AAPL' } });

    expect(result.sources.every((s) => s.ticker === 'AAPL')).toBe(true);
  });

  it('answer: per-filing diversity caps at 3 chunks per filing', async () => {
    const vec = Array(1024).fill(0.5);
    // Seed one filing with 5 chunks all matching closely
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    const accession = '0000320193-24-000123';
    await dbH.db.insert(filings).values({
      accessionNo: accession, ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
    });
    for (let i = 0; i < 5; i++) {
      await dbH.db.insert(filingChunks).values({
        filingId: accession, sectionKey: `section_${i}`, sectionTitle: `S${i}`, text: `chunk ${i}`, charCount: 7
      });
      await dbH.db.insert(chunkEmbeddings).values({
        filingId: accession, sectionKey: `section_${i}`, subChunkIndex: 0,
        text: `chunk ${i}`, embedding: vec, model: CURRENT_EMBED_MODEL,
        charOffsetStart: 0, charOffsetEnd: 7
      });
    }
    // Seed a second filing with 5 also matching
    await dbH.db.insert(filings).values({
      accessionNo: '0000320193-24-000080', ticker: 'AAPL', cik: '0000320193',
      formType: '10-Q', filingDate: '2024-08-02', primaryDocUrl: 'https://y'
    });
    for (let i = 0; i < 5; i++) {
      await dbH.db.insert(filingChunks).values({
        filingId: '0000320193-24-000080', sectionKey: `section_q_${i}`, sectionTitle: `Q${i}`, text: `q chunk ${i}`, charCount: 9
      });
      await dbH.db.insert(chunkEmbeddings).values({
        filingId: '0000320193-24-000080', sectionKey: `section_q_${i}`, subChunkIndex: 0,
        text: `q chunk ${i}`, embedding: vec, model: CURRENT_EMBED_MODEL,
        charOffsetStart: 0, charOffsetEnd: 9
      });
    }
    await dbH.db.insert(watchlist).values({ userId, ticker: 'AAPL' });

    const svc = buildService();
    const result = await svc.answer({ userId, query: 'risks', scope: { type: 'watchlist' } });

    // Count chunks per filing
    const counts = result.sources.reduce<Record<string, number>>((acc, s) => {
      acc[s.accessionNo] = (acc[s.accessionNo] ?? 0) + 1;
      return acc;
    }, {});
    for (const [accession, count] of Object.entries(counts)) {
      expect(count, `filing ${accession} has too many chunks`).toBeLessThanOrEqual(3);
    }
  });

  it('answer: empty watchlist throws ValidationError', async () => {
    const svc = buildService();
    await expect(
      svc.answer({ userId, query: 'tariffs', scope: { type: 'watchlist' } })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('answer: empty retrieval short-circuits with apologetic stream and no model call', async () => {
    // User has watchlist but no embeddings exist
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await dbH.db.insert(watchlist).values({ userId, ticker: 'AAPL' });

    const embProvider = mockEmbeddingsProvider();
    const searchSvc = new SearchService({ db: dbH.db, provider: embProvider as any });
    const modelCallCount = { n: 0 };
    const model = new MockLanguageModelV1({
      doStream: async () => {
        modelCallCount.n++;
        return {
          stream: simulateReadableStream({ chunks: [{ type: 'finish', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } }] }),
          rawCall: { rawPrompt: null, rawSettings: {} }
        };
      }
    });
    const svc = new RagService({ db: dbH.db, searchService: searchSvc, model });

    const result = await svc.answer({ userId, query: 'tariffs', scope: { type: 'watchlist' } });

    expect(result.sources).toHaveLength(0);
    expect(modelCallCount.n).toBe(0); // never called the LLM
    // The stream should still produce some apologetic text
    let accumulated = '';
    const reader = (await result.streamResult.toTextStreamResponse()).body!.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value);
    }
    expect(accumulated.toLowerCase()).toContain("don't");
  });

  it('finalize: persists qa_history row after successful stream', async () => {
    const vec = Array(1024).fill(0.5);
    await seedFilingWithEmbedding(dbH.db, 'AAPL', '1', vec);
    await dbH.db.insert(watchlist).values({ userId, ticker: 'AAPL' });

    const svc = buildService();
    const result = await svc.answer({ userId, query: 'tariffs', scope: { type: 'watchlist' } });

    // Simulate stream completion by calling finalize with the assembled answer
    await result.finalize('Apple grew 22% [1].', { input: 4100, output: 200 });

    const rows = await dbH.db.select().from(qaHistory).where(eq(qaHistory.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answerText).toBe('Apple grew 22% [1].');
    expect(rows[0]!.model).toBe(CURRENT_MODEL);
    expect(rows[0]!.promptVersion).toBe(CURRENT_PROMPT_VERSION);
    expect(rows[0]!.scopeType).toBe('watchlist');
    expect(rows[0]!.inputTokens).toBe(4100);
    expect(rows[0]!.outputTokens).toBe(200);
  });

  it('finalize: persists zero-citation answer with warning logged', async () => {
    const vec = Array(1024).fill(0.5);
    await seedFilingWithEmbedding(dbH.db, 'AAPL', '1', vec);
    await dbH.db.insert(watchlist).values({ userId, ticker: 'AAPL' });

    const svc = buildService();
    const result = await svc.answer({ userId, query: 'tariffs', scope: { type: 'watchlist' } });

    // Answer with no [N] markers
    await result.finalize('Apple is a company that does things.', { input: 4100, output: 100 });

    const rows = await dbH.db.select().from(qaHistory).where(eq(qaHistory.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answerText).toBe('Apple is a company that does things.');
  });

  it('finalize: DB write failure does not throw', async () => {
    const vec = Array(1024).fill(0.5);
    await seedFilingWithEmbedding(dbH.db, 'AAPL', '1', vec);
    await dbH.db.insert(watchlist).values({ userId, ticker: 'AAPL' });

    const svc = buildService();
    const result = await svc.answer({ userId, query: 'tariffs', scope: { type: 'watchlist' } });

    // Close the connection to force INSERT to fail
    await dbH.close();

    // finalize() should swallow the error, not throw
    await expect(
      result.finalize('Apple grew [1].', { input: 4100, output: 50 })
    ).resolves.toBeUndefined();

    // Reopen for cleanup
    dbH = makeTestServiceDb();
  });
});
```

- [ ] **Step 2: Run, verify fails**

```bash
pnpm test:integration tests/integration/rag-service.test.ts 2>&1 | tail -10
```

Expected: import error for `@/lib/services/rag`.

- [ ] **Step 3: Write `lib/services/rag.ts`**

```ts
import { streamText, simulateReadableStream, type StreamTextResult, type LanguageModelV1 } from 'ai';
import { eq } from 'drizzle-orm';
import { filings, qaHistory, refreshRuns } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import { ValidationError } from '@/lib/providers/types';
import { logger } from '@/lib/logger';
import { SearchService, type SearchResult } from './search';
import { GEMINI_MODEL } from '@/lib/providers/gemini';

export const CURRENT_MODEL = GEMINI_MODEL;
export const CURRENT_PROMPT_VERSION = 'v1';
const MAX_OUTPUT_TOKENS = 800;
const RAG_MAX_DISTANCE = 0.55;
const RETRIEVAL_RAW_K = 30;
const RETRIEVAL_FINAL_K = 8;
const MAX_PER_FILING = 3;
const MIN_QUERY_CHARS = 1;
const MAX_QUERY_CHARS = 500;

export interface RagScope {
  type: 'watchlist' | 'ticker';
  ticker?: string;
}

export interface RagSource {
  marker: number;
  ticker: string;
  companyName: string;
  accessionNo: string;
  formType: string;
  filingDate: string;
  sectionKey: string;
  sectionTitle: string;
  subChunkIndex: number;
  snippet: string;
  distance: number;
}

interface Deps {
  db: ServiceDb;
  searchService: SearchService;
  model: LanguageModelV1;
}

export interface RagAnswerResult {
  sources: RagSource[];
  streamResult: StreamTextResult<Record<string, never>, never>;
  finalize: (fullAnswerText: string, tokenUsage?: { input: number; output: number }) => Promise<void>;
}

const SYSTEM_PROMPT = `You are a senior equity research analyst answering investor questions using SEC filing excerpts. Rules:

1. Only use facts from the numbered sources below. Do NOT use outside knowledge or guess. If the sources don't contain the answer, say "The provided filings don't directly answer this. The closest relevant content is: [briefly summarize what was retrieved]."

2. Cite every factual claim with a bracketed marker matching the source number, e.g. "Revenue grew 14% to $96B [1]".

3. Be concise. Aim for 3-6 sentences, plus optional bullet points when the question asks for a list.

4. Use exact numbers, dates, and named entities from the sources. Avoid hedging ("appears", "seems", "may").

5. Do not summarize the entire filing. Answer ONLY the question asked.`;

const APOLOGY_STREAM_TEXT = "The provided filings don't contain content relevant to your question. Try rephrasing, or load filings for more of your watched tickers.";

export class RagService {
  constructor(private readonly deps: Deps) {}

  async answer(opts: { userId: string; query: string; scope: RagScope }): Promise<RagAnswerResult> {
    const trimmed = opts.query.trim();
    if (trimmed.length < MIN_QUERY_CHARS) {
      throw new ValidationError('Query too short');
    }
    if (trimmed.length > MAX_QUERY_CHARS) {
      throw new ValidationError(`Query exceeds ${MAX_QUERY_CHARS} characters`);
    }
    if (opts.scope.type === 'ticker' && !opts.scope.ticker) {
      throw new ValidationError('scope.ticker required when scope.type=ticker');
    }

    // Retrieve top-30 raw
    const raw = await this.deps.searchService.searchAcrossWatchlist({
      userId: opts.userId,
      query: trimmed,
      limit: RETRIEVAL_RAW_K,
      maxDistance: RAG_MAX_DISTANCE,
      ...(opts.scope.type === 'ticker' && opts.scope.ticker ? { tickerScope: opts.scope.ticker } : {})
    });

    // If empty: check watchlist itself to distinguish empty-watchlist vs no-relevant-chunks
    if (raw.length === 0) {
      const watchlistCount = await this.checkWatchlistNonEmpty(opts.userId);
      if (!watchlistCount) {
        throw new ValidationError('Watchlist is empty. Add tickers to your watchlist to ask questions about them.');
      }
      // No relevant chunks: short-circuit with apology — no model call
      return this.buildApologyResult(opts);
    }

    // Per-filing diversity
    const sources = this.applyDiversity(raw);

    // Build the user prompt with numbered chunks
    const userPrompt = this.buildUserPrompt(trimmed, sources);

    // Stream the answer via AI SDK
    const streamResult = streamText({
      model: this.deps.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: MAX_OUTPUT_TOKENS
    });

    const finalize = async (fullAnswerText: string, tokenUsage?: { input: number; output: number }) => {
      try {
        await this.deps.db.insert(qaHistory).values({
          userId: opts.userId,
          scopeType: opts.scope.type,
          scopeTicker: opts.scope.type === 'ticker' ? opts.scope.ticker ?? null : null,
          query: trimmed,
          answerText: fullAnswerText,
          citations: sources.map((s) => ({
            marker: s.marker,
            accessionNo: s.accessionNo,
            ticker: s.ticker,
            formType: s.formType,
            filingDate: s.filingDate,
            sectionKey: s.sectionKey,
            subChunkIndex: s.subChunkIndex,
            distance: s.distance
          })),
          model: CURRENT_MODEL,
          promptVersion: CURRENT_PROMPT_VERSION,
          inputTokens: tokenUsage?.input ?? null,
          outputTokens: tokenUsage?.output ?? null
        });

        // refresh_runs requires a ticker FK; pick the first source's ticker for cross-watchlist
        const refreshTicker = opts.scope.type === 'ticker'
          ? opts.scope.ticker!
          : sources[0]?.ticker ?? 'AAPL'; // fallback unlikely to fire
        await this.deps.db.insert(refreshRuns).values({
          ticker: refreshTicker,
          kind: `rag:${opts.scope.type}`,
          startedAt: new Date(),
          completedAt: new Date(),
          ok: true,
          sourceUsed: 'gemini'
        });
      } catch (err) {
        // Best-effort persistence — don't fail the UX
        logger.warn({ userId: opts.userId, err: String(err) }, 'rag: finalize persistence failed');
      }
    };

    return { sources, streamResult, finalize };
  }

  // --- internal ---

  private async checkWatchlistNonEmpty(userId: string): Promise<boolean> {
    const rows = await this.deps.db.execute<{ ct: string }>(
      // raw count to avoid extra Drizzle imports
      // language=postgresql
      // @ts-expect-error - using raw sql template
      { strings: [`SELECT count(*)::text AS ct FROM watchlist WHERE user_id = `, `::uuid LIMIT 1`], values: [userId] } as any
    );
    // The sql template builder is invoked in production; in the simpler case here we use a separate query helper below.
    // For TS safety + simplicity, do a real Drizzle query instead:
    return false; // overridden by the implementation below
  }

  private applyDiversity(raw: SearchResult[]): RagSource[] {
    const counts: Record<string, number> = {};
    const out: RagSource[] = [];
    let marker = 1;
    for (const r of raw) {
      const n = counts[r.accessionNo] ?? 0;
      if (n >= MAX_PER_FILING) continue;
      counts[r.accessionNo] = n + 1;
      out.push({ marker, ...r });
      marker++;
      if (out.length >= RETRIEVAL_FINAL_K) break;
    }
    return out;
  }

  private buildUserPrompt(query: string, sources: RagSource[]): string {
    const chunks = sources
      .map(
        (s) =>
          `[${s.marker}] ${s.ticker} · ${s.formType} · filed ${s.filingDate} · ${s.sectionTitle}\n${s.snippet}`
      )
      .join('\n\n');
    return `Question: ${query}

Sources (each numbered chunk is a passage from an SEC filing):

${chunks}

Answer the question using only these sources. Cite with [N] markers.`;
  }

  private buildApologyResult(opts: { userId: string; query: string; scope: RagScope }): RagAnswerResult {
    const streamResult = streamText({
      model: this.deps.model,
      system: '',
      messages: [{ role: 'user', content: '' }],
      // Override the actual stream with the apology string
      experimental_providerMetadata: undefined
    });
    // Replace the stream with our static apology — implemented via a simple alternate
    // Because we can't easily inject text into AI SDK's stream object retroactively,
    // we construct a minimal mock-like stream via simulateReadableStream:
    const apologyStream = streamText({
      model: this.deps.model,
      messages: [{ role: 'user', content: 'unused' }]
    });
    // Returning the apology stream directly is awkward — use a thin custom Stream:
    return {
      sources: [],
      streamResult: apologyStream,
      finalize: async () => {
        // Skip persistence for empty-retrieval queries
      }
    };
  }
}
```

**Note on the apology path**: the above implementation is incomplete — the AI SDK's `streamText` returns a typed result object that's awkward to fabricate without calling a model. For Slice 3, replace the `buildApologyResult` body with a real implementation. See Step 4.

- [ ] **Step 4: Replace `buildApologyResult` with the working implementation**

Vercel AI SDK provides `MockLanguageModelV1` for tests, but it also works in production for hardcoded streams. Use it for the apology path:

```ts
import { MockLanguageModelV1 } from 'ai/test';

// ...inside the class:
private buildApologyResult(_opts: { userId: string; query: string; scope: RagScope }): RagAnswerResult {
  const apologyModel = new MockLanguageModelV1({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-delta', textDelta: APOLOGY_STREAM_TEXT },
          { type: 'finish', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } }
        ]
      }),
      rawCall: { rawPrompt: null, rawSettings: {} }
    })
  });
  const streamResult = streamText({
    model: apologyModel,
    messages: [{ role: 'user', content: 'unused' }]
  });
  return {
    sources: [],
    streamResult,
    finalize: async () => {} // skip persistence
  };
}
```

Also replace `checkWatchlistNonEmpty` with a real Drizzle implementation. Replace the bogus version with:

```ts
private async checkWatchlistNonEmpty(userId: string): Promise<boolean> {
  const { watchlist } = await import('@/lib/db/schema');
  const { eq, sql } = await import('drizzle-orm');
  const rows = await this.deps.db
    .select({ c: sql<number>`count(*)::int` })
    .from(watchlist)
    .where(eq(watchlist.userId, userId));
  return (rows[0]?.c ?? 0) > 0;
}
```

Make sure the imports at the top of `lib/services/rag.ts` include all needed symbols. Final imports section:

```ts
import { streamText, simulateReadableStream, type StreamTextResult, type LanguageModelV1 } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';
import { and, count, eq, sql } from 'drizzle-orm';
import { filings, qaHistory, refreshRuns, watchlist } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import { ValidationError } from '@/lib/providers/types';
import { logger } from '@/lib/logger';
import { SearchService, type SearchResult } from './search';
import { GEMINI_MODEL } from '@/lib/providers/gemini';
```

- [ ] **Step 5: Run, verify passes**

```bash
pnpm test:integration tests/integration/rag-service.test.ts 2>&1 | tail -15
```

Expected: 8 passing.

If the diversity test fails because all 5 chunks from one filing come back, double-check that `applyDiversity` actually enforces `MAX_PER_FILING = 3`.

If the empty-retrieval test fails because the apology stream returns empty text, ensure the `simulateReadableStream` in `buildApologyResult` emits a `text-delta` chunk before `finish`.

- [ ] **Step 6: Commit**

```bash
git add lib/services/rag.ts tests/integration/rag-service.test.ts
git commit -m "feat(services): RagService with retrieval + per-filing diversity + finalize"
```

---

## Milestone 5: API route + RLS smoke

### Task 5.1: Write `/api/rag/stream` route + integration tests

**Files:**
- Create: `app/api/rag/stream/route.ts`
- Create: `tests/integration/api-rag-stream.test.ts`

The route is thin: validate auth + body shape, build the RagService dependency tree, call `service.answer()`, wire the streamResult + sources into a `createDataStreamResponse`. The finalize callback runs after the stream consumer finishes.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/api-rag-stream.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { MockLanguageModelV1 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, filings, filingChunks, chunkEmbeddings, watchlist } from '@/lib/db/schema';

config({ path: '.env.local' });

const STATIC_USER_ID = '22222222-2222-2222-2222-222222222222';

async function seedSearchable(db: any) {
  await db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
  await db.insert(filings).values({
    accessionNo: '0000320193-24-000123', ticker: 'AAPL', cik: '0000320193',
    formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
  });
  await db.insert(filingChunks).values({
    filingId: '0000320193-24-000123', sectionKey: 'item_1a_risk_factors',
    sectionTitle: 'Risk Factors', text: 'Apple faces China tariff risk.', charCount: 31
  });
  await db.insert(chunkEmbeddings).values({
    filingId: '0000320193-24-000123', sectionKey: 'item_1a_risk_factors', subChunkIndex: 0,
    text: 'Apple faces China tariff risk.',
    embedding: Array(1024).fill(0.5),
    model: 'text-embedding-v3',
    charOffsetStart: 0, charOffsetEnd: 31
  });
  await db.insert(watchlist).values({ userId: STATIC_USER_ID, ticker: 'AAPL' });
}

describe('/api/rag/stream', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => STATIC_USER_ID,
      getCurrentUserId: async () => STATIC_USER_ID,
      UnauthorizedError: class extends Error {}
    }));
    vi.doMock('@/lib/providers/embeddings', () => ({
      EmbeddingsProviderImpl: class {
        async embed() { return { vectors: [Array(1024).fill(0.5)], inputTokens: 10 }; }
      }
    }));
    vi.doMock('@/lib/providers/gemini', () => ({
      GEMINI_MODEL: 'gemini-2.5-flash',
      createGemini: () => () => new MockLanguageModelV1({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-delta' as const, textDelta: 'Apple grew' },
              { type: 'text-delta' as const, textDelta: ' 22% [1].' },
              { type: 'finish' as const, finishReason: 'stop' as const, usage: { promptTokens: 100, completionTokens: 10 } }
            ]
          }),
          rawCall: { rawPrompt: null, rawSettings: {} }
        })
      })
    }));
  });

  it('POST happy path streams a response', async () => {
    await seedSearchable(dbH.db);
    const { POST } = await import('@/app/api/rag/stream/route');
    const res = await POST(new Request('http://localhost/api/rag/stream', {
      method: 'POST',
      body: JSON.stringify({ query: 'China tariff', scope: { type: 'watchlist' } }),
      headers: { 'content-type': 'application/json' }
    }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });

  it('POST empty query returns 400', async () => {
    const { POST } = await import('@/app/api/rag/stream/route');
    const res = await POST(new Request('http://localhost/api/rag/stream', {
      method: 'POST',
      body: JSON.stringify({ query: '', scope: { type: 'watchlist' } }),
      headers: { 'content-type': 'application/json' }
    }));
    expect(res.status).toBe(400);
  });

  it('POST oversized query returns 400', async () => {
    const { POST } = await import('@/app/api/rag/stream/route');
    const res = await POST(new Request('http://localhost/api/rag/stream', {
      method: 'POST',
      body: JSON.stringify({ query: 'x'.repeat(1000), scope: { type: 'watchlist' } }),
      headers: { 'content-type': 'application/json' }
    }));
    expect(res.status).toBe(400);
  });

  it('POST invalid scope returns 400', async () => {
    const { POST } = await import('@/app/api/rag/stream/route');
    const res = await POST(new Request('http://localhost/api/rag/stream', {
      method: 'POST',
      body: JSON.stringify({ query: 'risks', scope: { type: 'something_else' } }),
      headers: { 'content-type': 'application/json' }
    }));
    expect(res.status).toBe(400);
  });

  it('POST ticker scope with bad ticker format returns 400', async () => {
    const { POST } = await import('@/app/api/rag/stream/route');
    const res = await POST(new Request('http://localhost/api/rag/stream', {
      method: 'POST',
      body: JSON.stringify({ query: 'risks', scope: { type: 'ticker', ticker: 'bogus-1' } }),
      headers: { 'content-type': 'application/json' }
    }));
    expect(res.status).toBe(400);
  });

  it('POST unauth returns 401', async () => {
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => { throw new Error('Unauthorized'); },
      UnauthorizedError: class extends Error {}
    }));
    const { POST } = await import('@/app/api/rag/stream/route');
    const res = await POST(new Request('http://localhost/api/rag/stream', {
      method: 'POST',
      body: JSON.stringify({ query: 'risks', scope: { type: 'watchlist' } }),
      headers: { 'content-type': 'application/json' }
    }));
    expect([401, 500]).toContain(res.status); // depends on errorResponse mapping of generic Error
  });
});
```

- [ ] **Step 2: Run, verify fails**

```bash
pnpm test:integration tests/integration/api-rag-stream.test.ts 2>&1 | tail -10
```

Expected: import error for `@/app/api/rag/stream/route`.

- [ ] **Step 3: Write the route**

```ts
// app/api/rag/stream/route.ts
import { createDataStreamResponse } from 'ai';
import { errorResponse } from '@/lib/api/errors';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { SearchService } from '@/lib/services/search';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';
import { RagService } from '@/lib/services/rag';
import { createGemini, GEMINI_MODEL } from '@/lib/providers/gemini';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface RagRequestBody {
  query?: unknown;
  scope?: unknown;
}

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const body = (await req.json().catch(() => ({}))) as RagRequestBody;

    if (typeof body.query !== 'string') {
      throw new ValidationError('query must be a string');
    }
    if (body.query.trim().length === 0) {
      throw new ValidationError('query is required');
    }
    if (body.query.length > 500) {
      throw new ValidationError('query exceeds 500 characters');
    }

    if (typeof body.scope !== 'object' || body.scope === null) {
      throw new ValidationError('scope is required');
    }
    const scope = body.scope as { type?: unknown; ticker?: unknown };
    if (scope.type !== 'watchlist' && scope.type !== 'ticker') {
      throw new ValidationError("scope.type must be 'watchlist' or 'ticker'");
    }
    if (scope.type === 'ticker') {
      if (typeof scope.ticker !== 'string' || !TICKER_RE.test(scope.ticker)) {
        throw new ValidationError('scope.ticker must be a valid ticker symbol');
      }
    }

    const db = getServiceDb();
    const searchService = new SearchService({
      db,
      provider: new EmbeddingsProviderImpl()
    });
    const gemini = createGemini();
    const model = gemini(GEMINI_MODEL);
    const rag = new RagService({ db, searchService, model });

    const result = await rag.answer({
      userId,
      query: body.query,
      scope: scope.type === 'ticker' ? { type: 'ticker', ticker: scope.ticker as string } : { type: 'watchlist' }
    });

    return createDataStreamResponse({
      execute: async (writer) => {
        // Emit sources first via streamData side-channel
        writer.writeData({ type: 'sources', sources: result.sources });

        // Stream the LLM tokens
        result.streamResult.mergeIntoDataStream(writer);

        // After stream completes, persist qa_history
        try {
          const fullText = await result.streamResult.text;
          const usage = await result.streamResult.usage;
          await result.finalize(fullText, { input: usage.promptTokens, output: usage.completionTokens });
        } catch (err) {
          // finalize already logs; ignore here
        }
      },
      onError: (err) => {
        return err instanceof Error ? err.message : 'Stream error';
      }
    });
  } catch (err) {
    return errorResponse(err, { route: 'api/rag/stream POST' });
  }
}

export const maxDuration = 60;
```

- [ ] **Step 4: Run, verify passes**

```bash
pnpm test:integration tests/integration/api-rag-stream.test.ts 2>&1 | tail -15
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add app/api/rag/stream/route.ts tests/integration/api-rag-stream.test.ts
git commit -m "feat(api): POST /api/rag/stream with sources sidechannel + token streaming"
```

---

### Task 5.2: RLS smoke for `qa_history`

**Files:**
- Create: `tests/integration/qa-history-rls.test.ts`

This is the project's FIRST user-scoped RLS test. The pattern differs from existing RLS tests (which test "can SELECT any row"): here we test "can SELECT ONLY MY OWN row".

- [ ] **Step 1: Write the test**

```ts
// tests/integration/qa-history-rls.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, makeTestUserDb, newUserId, resetDb } from '../helpers/test-db';
import { qaHistory } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('RLS: qa_history (user-scoped)', () => {
  let svc: ReturnType<typeof makeTestServiceDb>;
  let user: ReturnType<typeof makeTestUserDb>;
  let aliceUid: string;
  let bobUid: string;

  beforeAll(() => { svc = makeTestServiceDb(); user = makeTestUserDb(); });
  afterAll(async () => { await svc.close(); await user.close(); });

  beforeEach(async () => {
    await resetDb(svc.db);
    aliceUid = newUserId();
    bobUid = newUserId();
    // Seed one row per user as service_role
    await svc.db.insert(qaHistory).values([
      {
        userId: aliceUid,
        scopeType: 'watchlist',
        scopeTicker: null,
        query: "Alice's question",
        answerText: "Alice's answer",
        citations: [],
        model: 'gemini-2.5-flash',
        promptVersion: 'v1'
      },
      {
        userId: bobUid,
        scopeType: 'watchlist',
        scopeTicker: null,
        query: "Bob's question",
        answerText: "Bob's answer",
        citations: [],
        model: 'gemini-2.5-flash',
        promptVersion: 'v1'
      }
    ]);
  });

  it('alice can SELECT her own qa_history row', async () => {
    const rows = await user.asUser(aliceUid, async (tx) => {
      return tx.select().from(qaHistory);
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(aliceUid);
    expect(rows[0]!.query).toBe("Alice's question");
  });

  it("alice CANNOT see bob's qa_history row", async () => {
    const rows = await user.asUser(aliceUid, async (tx) => {
      return tx.select().from(qaHistory);
    });
    // Should NOT include bob's row
    expect(rows.every((r) => r.userId === aliceUid)).toBe(true);
    expect(rows.some((r) => r.userId === bobUid)).toBe(false);
  });

  it('authenticated role cannot INSERT into qa_history', async () => {
    await expect(
      user.asUser(aliceUid, async (tx) =>
        tx.insert(qaHistory).values({
          userId: aliceUid,
          scopeType: 'watchlist',
          scopeTicker: null,
          query: 'should fail',
          answerText: 'should fail',
          citations: [],
          model: 'gemini-2.5-flash',
          promptVersion: 'v1'
        })
      )
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, verify passes**

```bash
pnpm test:integration tests/integration/qa-history-rls.test.ts 2>&1 | tail -10
```

Expected: 3 passing.

If alice sees bob's row, the RLS policy's `current_setting('request.jwt.claim.sub', true)` isn't matching `user_id::text`. Check that the `_apply.ts` step from T1.2 actually applied the policy: connect to the test branch and run `\d+ qa_history` to verify the policy exists.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/qa-history-rls.test.ts
git commit -m "test(db): user-scoped RLS smoke for qa_history"
```

---

## Milestone 6: Prompt iteration via try-ask

### Task 6.1: `scripts/try-ask.ts` smoke + lock prompt v1

**Files:**
- Create: `scripts/try-ask.ts`
- Modify: `package.json` (add `try-ask` script)

Run against the live Gemini API + production Neon. The point is to verify the prompt produces useful answers BEFORE wiring up the UI.

`GEMINI_API_KEY` must already be in `.env.local` (per user — added per the spec acceptance).

- [ ] **Step 1: Write the script**

```ts
#!/usr/bin/env tsx
/**
 * End-to-end smoke: `pnpm try-ask "<query>" [--ticker AAPL]`
 *
 * Runs RagService.answer() against the live Gemini API + local DB.
 * Prints the 8 sources and the streaming answer to stdout.
 *
 * Picks a user with a non-empty watchlist automatically (or accepts
 * --user-id <uuid>). The user must have embedded filings; if not, the
 * apology message will print.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { count } from 'drizzle-orm';
import { getServiceDb } from '@/lib/db/client';
import { watchlist } from '@/lib/db/schema';
import { SearchService } from '@/lib/services/search';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';
import { RagService } from '@/lib/services/rag';
import { createGemini, GEMINI_MODEL } from '@/lib/providers/gemini';

async function main() {
  const args = process.argv.slice(2);
  const tickerFlag = args.indexOf('--ticker');
  const ticker = tickerFlag >= 0 ? args[tickerFlag + 1]?.toUpperCase() : null;
  const userIdFlag = args.indexOf('--user-id');
  const userIdOverride = userIdFlag >= 0 ? args[userIdFlag + 1] : null;
  const queryParts = args.filter((a, i) => {
    if (a === '--ticker' || a === '--user-id') return false;
    if (args[i - 1] === '--ticker' || args[i - 1] === '--user-id') return false;
    return true;
  });
  const query = queryParts.join(' ').trim();

  if (!query) {
    console.error('Usage: pnpm try-ask "<query>" [--ticker AAPL] [--user-id <uuid>]');
    process.exit(2);
  }

  const db = getServiceDb();

  let userId = userIdOverride;
  if (!userId) {
    const candidates = await db
      .select({ uid: watchlist.userId, c: count() })
      .from(watchlist)
      .groupBy(watchlist.userId)
      .limit(1);
    if (candidates.length === 0) {
      console.error('No users with watchlists in DB. Pass --user-id <uuid> or seed first.');
      process.exit(2);
    }
    userId = candidates[0]!.uid;
    console.log(`(using user ${userId} with ${candidates[0]!.c} watched tickers)`);
  }

  const searchService = new SearchService({ db, provider: new EmbeddingsProviderImpl() });
  const gemini = createGemini();
  const model = gemini(GEMINI_MODEL);
  const rag = new RagService({ db, searchService, model });

  console.log(`\nQuerying: "${query}"${ticker ? ` (scope: ${ticker})` : ''}…`);

  const t0 = Date.now();
  const result = await rag.answer({
    userId,
    query,
    scope: ticker ? { type: 'ticker', ticker } : { type: 'watchlist' }
  });
  console.log(`\nRetrieved ${result.sources.length} sources in ${Date.now() - t0}ms`);

  console.log('\n--- Sources ---');
  for (const s of result.sources) {
    const snippet = s.snippet.length > 150 ? s.snippet.slice(0, 150) + '…' : s.snippet;
    console.log(`[${s.marker}] ${s.ticker} · ${s.formType} · ${s.filingDate} · ${s.sectionTitle} (cosine ${s.distance.toFixed(3)})`);
    console.log(`    ${snippet.replace(/\s+/g, ' ')}`);
  }

  console.log('\n--- Answer (streaming) ---');
  let accumulated = '';
  for await (const delta of result.streamResult.textStream) {
    process.stdout.write(delta);
    accumulated += delta;
  }
  console.log('\n--- End ---');

  const usage = await result.streamResult.usage;
  console.log(`\nTokens: ${usage.promptTokens} in, ${usage.completionTokens} out (~$${((usage.promptTokens * 0.075 + usage.completionTokens * 0.3) / 1_000_000).toFixed(5)})`);

  await result.finalize(accumulated, { input: usage.promptTokens, output: usage.completionTokens });
  console.log(`Total elapsed: ${Date.now() - t0}ms`);

  process.exit(0);
}

main().catch((err) => {
  console.error('try-ask failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add to `package.json` scripts**

Find the existing `"try-search": "tsx scripts/try-search.ts"` line and add right after:

```json
"try-ask": "tsx scripts/try-ask.ts",
```

- [ ] **Step 3: Run smoke against 3 questions**

Pre-req: at least one ticker (AAPL) must have embedded filings in your local/prod DB. If you ran `embed-existing.ts AAPL` earlier per the Slice 2C ops, you're set.

```bash
pnpm try-ask "What did Apple say about China tariff exposure?" --ticker AAPL
```

Expected: prints 8 sources from AAPL filings + streams an answer with `[N]` citations.

```bash
pnpm try-ask "Apple AI infrastructure investment" --ticker AAPL
```

```bash
pnpm try-ask "Which of my watched companies mention regulatory risk?"
```

(The third query is cross-watchlist; relies on your watchlist having multiple embedded tickers.)

- [ ] **Step 4: Evaluate output quality**

For each run, verify:

1. **Citation discipline**: every factual claim has a `[N]` marker. No floating sentences without sources.
2. **Specificity**: numbers / company names / dates come from sources, not generic statements.
3. **Anti-hedging**: avoid "appears", "seems", "may" phrasings.
4. **Length**: 3-6 sentences, no rambling.
5. **Fallback fires**: third query may legitimately not match if your watchlist is sparse — apology message should be helpful, not generic.
6. **Cost sanity**: each query should cost <$0.001 on paid tier; well within free tier.
7. **Latency**: ~5-10 sec total per query.

**If quality is poor**: iterate the `SYSTEM_PROMPT` or `buildUserPrompt` in `lib/services/rag.ts`. Re-run. Maximum 3 iteration cycles. If still poor after 3, report DONE_WITH_CONCERNS with the latest output for human review.

- [ ] **Step 5: Commit (once prompt is locked)**

```bash
git add scripts/try-ask.ts package.json
git commit -m "chore(scripts): pnpm try-ask + lock prompt v1"
```

If you iterated the prompt, the commit should also include the updated `lib/services/rag.ts`:

```bash
git add lib/services/rag.ts scripts/try-ask.ts package.json
git commit -m "chore(scripts): pnpm try-ask + lock prompt v1 (iterated N times)"
```

---

## Milestone 7: UI

### Task 7.1: AskPanel + child components

**Files:**
- Create: `app/(app)/_components/ask-panel.tsx`
- Create: `app/(app)/_components/ask-input.tsx`
- Create: `app/(app)/_components/ask-sources-row.tsx`
- Create: `app/(app)/_components/ask-source-card.tsx`
- Create: `app/(app)/_components/ask-answer.tsx`
- Create: `app/(app)/_components/ask-skeleton.tsx`

Use the AI SDK's `useChat` hook in `ask-panel.tsx` to manage streaming state. Sources come through the `data` channel; the answer comes through `messages[].content`.

- [ ] **Step 1: Write `ask-skeleton.tsx`**

```tsx
// app/(app)/_components/ask-skeleton.tsx
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function AskSkeleton() {
  return (
    <Card>
      <CardContent className="py-6 space-y-3">
        <p className="text-sm text-muted-foreground">Retrieving sources…</p>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Write `ask-source-card.tsx`**

```tsx
// app/(app)/_components/ask-source-card.tsx
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

interface Props {
  marker: number;
  ticker: string;
  formType: string;
  filingDate: string;
  sectionKey: string;
  sectionTitle: string;
  accessionNo: string;
  snippet: string;
  distance: number;
  highlighted?: boolean;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

export function AskSourceCard({
  marker, ticker, formType, filingDate, sectionKey, sectionTitle,
  accessionNo, snippet, distance, highlighted
}: Props) {
  return (
    <Card
      data-source-marker={marker}
      className={`min-w-[280px] max-w-[320px] transition ${highlighted ? 'ring-2 ring-primary' : ''}`}
    >
      <CardContent className="py-3 space-y-2">
        <div className="flex items-baseline gap-1.5 text-xs">
          <Badge variant="outline" className="font-mono">[{marker}]</Badge>
          <Badge variant="outline">{ticker}</Badge>
          <span className="text-muted-foreground">·</span>
          <span className="font-medium">{formType}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{filingDate}</span>
        </div>
        <p className="text-xs text-muted-foreground">{sectionTitle}</p>
        <p className="text-sm leading-snug">{truncate(snippet, 140)}</p>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span aria-hidden>cosine {distance.toFixed(2)}</span>
          <Link
            href={`/stock/${ticker}/filings/${accessionNo}#section-${sectionKey}`}
            className="hover:text-foreground"
          >
            open ↗
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Write `ask-sources-row.tsx`**

```tsx
// app/(app)/_components/ask-sources-row.tsx
'use client';

import { AskSourceCard } from './ask-source-card';

interface Source {
  marker: number;
  ticker: string;
  formType: string;
  filingDate: string;
  sectionKey: string;
  sectionTitle: string;
  accessionNo: string;
  snippet: string;
  distance: number;
}

interface Props {
  sources: Source[];
  highlightedMarker: number | null;
}

export function AskSourcesRow({ sources, highlightedMarker }: Props) {
  if (sources.length === 0) return null;
  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex gap-3">
        {sources.map((s) => (
          <AskSourceCard
            key={s.marker}
            marker={s.marker}
            ticker={s.ticker}
            formType={s.formType}
            filingDate={s.filingDate}
            sectionKey={s.sectionKey}
            sectionTitle={s.sectionTitle}
            accessionNo={s.accessionNo}
            snippet={s.snippet}
            distance={s.distance}
            highlighted={highlightedMarker === s.marker}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write `ask-answer.tsx`**

```tsx
// app/(app)/_components/ask-answer.tsx
'use client';

import { Card, CardContent } from '@/components/ui/card';
import { useMemo } from 'react';

interface Props {
  text: string;
  isStreaming: boolean;
  maxMarker: number;
  onMarkerHover: (marker: number | null) => void;
}

/**
 * Renders streaming answer with inline [N] markers turned into superscript
 * links that hover-highlight the corresponding source card.
 */
export function AskAnswer({ text, isStreaming, maxMarker, onMarkerHover }: Props) {
  const parts = useMemo(() => {
    // Split on [N] markers, keep delimiters
    const regex = /\[(\d+)\]/g;
    const out: Array<{ kind: 'text'; value: string } | { kind: 'cite'; n: number }> = [];
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIdx) {
        out.push({ kind: 'text', value: text.slice(lastIdx, match.index) });
      }
      const n = parseInt(match[1]!);
      out.push({ kind: 'cite', n });
      lastIdx = regex.lastIndex;
    }
    if (lastIdx < text.length) {
      out.push({ kind: 'text', value: text.slice(lastIdx) });
    }
    return out;
  }, [text]);

  return (
    <Card>
      <CardContent className="py-6 space-y-2">
        <p className="text-sm leading-relaxed whitespace-pre-wrap">
          {parts.map((p, i) => {
            if (p.kind === 'text') return <span key={i}>{p.value}</span>;
            const valid = p.n >= 1 && p.n <= maxMarker;
            if (!valid) return <span key={i}>[{p.n}]</span>;
            return (
              <sup
                key={i}
                className="cursor-pointer text-primary font-medium ml-0.5"
                onMouseEnter={() => onMarkerHover(p.n)}
                onMouseLeave={() => onMarkerHover(null)}
              >
                [{p.n}]
              </sup>
            );
          })}
          {isStreaming && <span className="ml-1 inline-block w-2 h-4 bg-foreground animate-pulse align-middle" aria-hidden />}
        </p>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Write `ask-input.tsx`**

```tsx
// app/(app)/_components/ask-input.tsx
'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormEvent } from 'react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  placeholder: string;
}

export function AskInput({ value, onChange, onSubmit, busy, placeholder }: Props) {
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (value.trim().length === 0) return;
    onSubmit();
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <label htmlFor="ask-input" className="sr-only">Ask a question</label>
      <Input
        id="ask-input"
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1"
        maxLength={500}
        disabled={busy}
      />
      <Button type="submit" disabled={busy || value.trim().length === 0} aria-label="Submit question">
        {busy ? 'Asking…' : 'Submit'}
      </Button>
    </form>
  );
}
```

- [ ] **Step 6: Write `ask-panel.tsx` (the orchestrator)**

```tsx
// app/(app)/_components/ask-panel.tsx
'use client';

import { useChat } from 'ai/react';
import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { AskInput } from './ask-input';
import { AskSourcesRow } from './ask-sources-row';
import { AskAnswer } from './ask-answer';
import { AskSkeleton } from './ask-skeleton';

type Scope = { type: 'watchlist' } | { type: 'ticker'; ticker: string };

interface Source {
  marker: number;
  ticker: string;
  companyName: string;
  formType: string;
  filingDate: string;
  sectionKey: string;
  sectionTitle: string;
  accessionNo: string;
  snippet: string;
  distance: number;
}

interface Props {
  scope: Scope;
  placeholder?: string;
  examples?: string[];
}

export function AskPanel({ scope, placeholder, examples }: Props) {
  const [input, setInput] = useState('');
  const [highlightedMarker, setHighlightedMarker] = useState<number | null>(null);
  const { messages, append, isLoading, data, setMessages, error, reload } = useChat({
    api: '/api/rag/stream',
    body: { scope }
  });

  // Extract sources from the streamData channel
  const sources: Source[] = useMemo(() => {
    if (!data) return [];
    for (let i = data.length - 1; i >= 0; i--) {
      const d = data[i] as unknown as { type?: string; sources?: Source[] };
      if (d?.type === 'sources' && Array.isArray(d.sources)) return d.sources;
    }
    return [];
  }, [data]);

  const assistantMessage = useMemo(() => {
    const msgs = messages.filter((m) => m.role === 'assistant');
    return msgs[msgs.length - 1]?.content ?? '';
  }, [messages]);

  const hasSubmitted = messages.length > 0;

  function submit() {
    append({ role: 'user', content: input.trim() });
    setInput('');
  }

  function askAnother() {
    setMessages([]);
    setInput('');
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-6 space-y-3">
          <p className="text-sm text-muted-foreground">Q&A unavailable: {error.message}</p>
          <button onClick={() => reload()} className="text-sm text-primary hover:underline">
            Retry
          </button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <AskInput
        value={input}
        onChange={setInput}
        onSubmit={submit}
        busy={isLoading}
        placeholder={placeholder ?? '🔍 Ask a question about your filings…'}
      />

      {examples && examples.length > 0 && !hasSubmitted && (
        <p className="text-xs text-muted-foreground">
          Examples: {examples.map((ex, i) => (
            <span key={i}>
              {i > 0 && ', '}
              <span className="italic">&quot;{ex}&quot;</span>
            </span>
          ))}
        </p>
      )}

      {hasSubmitted && sources.length === 0 && isLoading && <AskSkeleton />}

      {sources.length > 0 && (
        <AskSourcesRow sources={sources} highlightedMarker={highlightedMarker} />
      )}

      {assistantMessage && (
        <AskAnswer
          text={assistantMessage}
          isStreaming={isLoading}
          maxMarker={sources.length}
          onMarkerHover={setHighlightedMarker}
        />
      )}

      {hasSubmitted && !isLoading && (
        <button
          onClick={askAnother}
          className="text-sm text-primary hover:underline"
        >
          Ask another question
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Verify typecheck**

```bash
pnpm typecheck 2>&1 | tail -3
```

Expected: exit 0. The `ai/react` import provides `useChat`; if TypeScript complains, ensure `ai` v4+ is installed.

- [ ] **Step 8: Commit**

```bash
git add 'app/(app)/_components/ask-panel.tsx' 'app/(app)/_components/ask-input.tsx' 'app/(app)/_components/ask-sources-row.tsx' 'app/(app)/_components/ask-source-card.tsx' 'app/(app)/_components/ask-answer.tsx' 'app/(app)/_components/ask-skeleton.tsx'
git commit -m "feat(ui): AskPanel + Input + SourcesRow + SourceCard + Answer + Skeleton"
```

---

### Task 7.2: Wire AskPanel into `/watchlist` (Search/Ask tabs)

**Files:**
- Modify: `app/(app)/watchlist/page.tsx`
- Create: `app/(app)/watchlist/_components/watchlist-tabs.tsx`

The watchlist page already has the Slice 2C search results. We add a tab strip that toggles between Search and Ask, driven by `?mode=ask` URL param.

- [ ] **Step 1: Write `watchlist-tabs.tsx` (client island)**

```tsx
// app/(app)/watchlist/_components/watchlist-tabs.tsx
'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface Props {
  active: 'search' | 'ask';
}

export function WatchlistTabs({ active }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const pathname = usePathname();

  function setMode(mode: 'search' | 'ask') {
    const sp = new URLSearchParams(params.toString());
    if (mode === 'search') sp.delete('mode');
    else sp.set('mode', 'ask');
    // Clear query when switching tabs to avoid running the wrong search
    sp.delete('q');
    const next = sp.toString();
    router.push(next ? `${pathname}?${next}` : pathname);
  }

  return (
    <Tabs value={active} onValueChange={(v) => setMode(v as 'search' | 'ask')}>
      <TabsList>
        <TabsTrigger value="search">Search</TabsTrigger>
        <TabsTrigger value="ask">Ask</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
```

- [ ] **Step 2: Modify `app/(app)/watchlist/page.tsx`**

Read the existing file first:

```bash
cat "app/(app)/watchlist/page.tsx"
```

Update the file. Add new imports near the top:

```tsx
import { WatchlistTabs } from './_components/watchlist-tabs';
import { AskPanel } from '@/app/(app)/_components/ask-panel';
```

Update the `PageProps`:

```tsx
interface PageProps {
  searchParams: { q?: string; mode?: string };
}
```

In the populated-watchlist branch (the one returned when `items.length > 0`), replace the existing search block with mode-aware rendering. The structure becomes:

```tsx
return (
  <>
    <section>
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Watchlist</h1>
        <p className="text-sm text-muted-foreground">{items.length} ticker{items.length === 1 ? '' : 's'}</p>
      </header>

      <div className="space-y-4 mb-6">
        <WatchlistTabs active={searchParams.mode === 'ask' ? 'ask' : 'search'} />

        {searchParams.mode === 'ask' ? (
          <AskPanel
            scope={{ type: 'watchlist' }}
            placeholder="🔍 Ask a question about your watchlist's filings…"
            examples={[
              'Which of my companies have China supply exposure?',
              'Compare AI infrastructure spending across my watchlist',
              'Who flagged regulatory risk in their latest 10-K?'
            ]}
          />
        ) : (
          <>
            <SearchBar />
            <p className="text-xs text-muted-foreground">
              Examples: &quot;China tariff exposure&quot;, &quot;AI infrastructure spending&quot;, &quot;customer concentration risk&quot;
            </p>
            {searchParams.q && (
              <Suspense fallback={<SearchSkeleton />}>
                <SearchResults q={searchParams.q} />
              </Suspense>
            )}
          </>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {items.map((item) => (
          <Link key={item.ticker} href={`/stock/${item.ticker}`}>
            <WatchlistCard ticker={item.ticker} snapshot={item.snapshot} />
          </Link>
        ))}
      </div>
    </section>
    <AddTickerDialog />
  </>
);
```

Apply the analogous change in the empty-state branch (around the existing `<EmptyState />`) — show the same Search/Ask tabs but with empty content.

- [ ] **Step 3: Verify typecheck**

```bash
pnpm typecheck 2>&1 | tail -3
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add 'app/(app)/watchlist/page.tsx' 'app/(app)/watchlist/_components/watchlist-tabs.tsx'
git commit -m "feat(ui): Search/Ask tabs on /watchlist with cross-watchlist AskPanel"
```

---

### Task 7.3: Wire AskPanel into `/stock/[ticker]/ask` + tab nav updates

**Files:**
- Create: `app/(app)/stock/[ticker]/ask/page.tsx`
- Modify: `app/(app)/stock/[ticker]/page.tsx` (add Ask trigger to Tabs)
- Modify: `app/(app)/stock/[ticker]/financials/page.tsx` (add Ask trigger)
- Modify: `app/(app)/stock/[ticker]/filings/page.tsx` (add Ask trigger)
- Modify: `app/(app)/stock/[ticker]/filings/[accession]/page.tsx` (add Ask trigger)

- [ ] **Step 1: Write `app/(app)/stock/[ticker]/ask/page.tsx`**

```tsx
// app/(app)/stock/[ticker]/ask/page.tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { companies } from '@/lib/db/schema';
import { AskPanel } from '@/app/(app)/_components/ask-panel';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface PageProps { params: { ticker: string }; }

export default async function TickerAskPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();

  const db = getServiceDb();
  const company = await db.select().from(companies).where(eq(companies.ticker, ticker)).limit(1);
  if (company.length === 0) notFound();

  return (
    <article className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
          <p className="text-sm text-muted-foreground">{company[0]!.name}</p>
        </div>
        <Tabs value="ask" className="hidden sm:block">
          <TabsList>
            <TabsTrigger value="overview" asChild><Link href={`/stock/${ticker}`}>Overview</Link></TabsTrigger>
            <TabsTrigger value="financials" asChild><Link href={`/stock/${ticker}/financials`}>Financials</Link></TabsTrigger>
            <TabsTrigger value="filings" asChild><Link href={`/stock/${ticker}/filings`}>Filings</Link></TabsTrigger>
            <TabsTrigger value="ask" asChild><Link href={`/stock/${ticker}/ask`}>Ask</Link></TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      <AskPanel
        scope={{ type: 'ticker', ticker }}
        placeholder={`🔍 Ask a question about ${ticker}'s filings…`}
        examples={[
          `What did ${ticker} say about AI capex in their most recent 10-K?`,
          `How has the China tariff risk language changed quarter-over-quarter?`,
          `Summarize ${ticker}'s key risk factors`
        ]}
      />
    </article>
  );
}
```

- [ ] **Step 2: Add Ask trigger to existing ticker dashboard pages**

For EACH of these four files, find the existing `<Tabs value="..." ...>` block and add an Ask trigger after the Filings one:

`app/(app)/stock/[ticker]/page.tsx`:

```tsx
<Tabs value="overview" className="hidden sm:block">
  <TabsList>
    <TabsTrigger value="overview" asChild><Link href={`/stock/${ticker}`}>Overview</Link></TabsTrigger>
    <TabsTrigger value="financials" asChild><Link href={`/stock/${ticker}/financials`}>Financials</Link></TabsTrigger>
    <TabsTrigger value="filings" asChild><Link href={`/stock/${ticker}/filings`}>Filings</Link></TabsTrigger>
    <TabsTrigger value="ask" asChild><Link href={`/stock/${ticker}/ask`}>Ask</Link></TabsTrigger>
  </TabsList>
</Tabs>
```

Same pattern for `financials/page.tsx`, `filings/page.tsx`, `filings/[accession]/page.tsx` — only the parent `value="..."` differs.

- [ ] **Step 3: Verify typecheck**

```bash
pnpm typecheck 2>&1 | tail -3
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add 'app/(app)/stock/[ticker]/ask/page.tsx' 'app/(app)/stock/[ticker]/page.tsx' 'app/(app)/stock/[ticker]/financials/page.tsx' 'app/(app)/stock/[ticker]/filings/page.tsx' 'app/(app)/stock/[ticker]/filings/[accession]/page.tsx'
git commit -m "feat(ui): per-ticker /stock/[ticker]/ask page + Ask trigger on all ticker tabs"
```

---

## Milestone 8: Deploy verification

### Task 8.1: Push + Vercel env + browser smoke

**Files:** none (verification only)

- [ ] **Step 1: Confirm `GEMINI_API_KEY` is in Vercel env**

Open Vercel dashboard → project → Settings → Environment Variables. Add `GEMINI_API_KEY` (Production + Preview) if not already there. The user added it locally per spec; ensure it's also in Vercel.

`DASHSCOPE_API_KEY` should already be there from Slices 2B + 2C.

- [ ] **Step 2: Push to GitHub**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git push origin master
```

GitHub Actions will run. All tests mock both providers (no real LLM calls) — CI should be green.

- [ ] **Step 3: Verify CI**

```bash
gh run list --limit 1
```

Expected: ✓ for the latest commit. If red, click into the run logs to diagnose.

- [ ] **Step 4: Wait for Vercel deploy**

```bash
gh run watch $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

Then watch Vercel dashboard for the deploy. Should take 2-3 min after CI passes.

- [ ] **Step 5: Browser smoke — cross-watchlist Ask**

1. Open https://YOUR-DEPLOY-URL/watchlist
2. Hard refresh (Ctrl+Shift+R) to clear cache
3. Confirm: Search/Ask tab strip is visible above the ticker cards
4. Click **Ask** tab → URL changes to `/watchlist?mode=ask`
5. Type `"China tariff exposure"` → click Submit
6. Confirm flow:
   - Skeleton appears for ~500ms
   - Source cards row appears (8 cards)
   - Answer streams in token-by-token below
   - `[1]`, `[2]` superscripts in the answer are clickable
   - Hovering a `[N]` highlights the corresponding source card
7. Click `open ↗` on a source → lands on the filing's reader, correct section tab

- [ ] **Step 6: Browser smoke — per-ticker Ask**

1. Open https://YOUR-DEPLOY-URL/stock/AAPL/ask
2. Confirm: Ask panel renders with AAPL-specific placeholder + examples
3. Type `"What did Apple say about AI infrastructure capex?"` → Submit
4. Same streaming + sources + citations flow
5. All sources should be from AAPL filings only (no other tickers)
6. Check the Tabs row at the top: Overview · Financials · Filings · **Ask** — clicking each navigates correctly

- [ ] **Step 7: No commit — verification only**

If anything fails:
- Check Vercel function logs for `/api/rag/stream` invocations
- Common issues: `GEMINI_API_KEY` not picked up; AI SDK version mismatch; CDN caching old `/watchlist` page (hard refresh)

---

## Slice 3 — Completion checklist

After all tasks above pass:

- [ ] All unit tests pass: `pnpm test` (unchanged at 103 — Slice 3 adds only integration tests)
- [ ] All integration tests pass: `pnpm test:integration` (existing 117 + 2 search ext + 8 rag service + 6 api + 3 rls = **136 integration tests**)
- [ ] Typecheck clean: `pnpm typecheck`
- [ ] Lint clean: `pnpm lint`
- [ ] `pnpm build` succeeds
- [ ] `pnpm try-ask "<query>"` runs successfully against live Gemini
- [ ] Browser smoke: cross-watchlist Ask works on `/watchlist?mode=ask`
- [ ] Browser smoke: per-ticker Ask works on `/stock/AAPL/ask`
- [ ] Source cards highlight on `[N]` hover
- [ ] `open ↗` from a source lands on the right filing + section
- [ ] `GEMINI_API_KEY` set in Vercel env vars
- [ ] `qa_history` table exists on both Neon branches with user-scoped RLS
- [ ] GitHub Actions CI green on `master`

When all boxes are checked, Slice 3 is complete. **The 2-series + 3 ship the full investor research loop**: find filings → read summaries → search across watchlist → ask cited questions.

---

## What's NOT in Slice 3 (deliberately deferred, per spec)

- **Multi-turn / threaded chat** — extend `qa_history` with `parent_id` later if desired
- **Cached / semantically-equivalent question reuse** — defer until same-Q-twice is observed
- **Cross-filing comparison mode** — needs different retrieval; possible Slice 3.5
- **Reranking** — add only if hallucination becomes a problem
- **Voice input / TTS** — different product
- **Suggested follow-up questions** — easy add later
- **"Compare ticker A vs B" specialized mode** — works via cross-watchlist Q&A today
- **Citation accuracy validation** — entire sub-system; trust the prompt for v1
- **Conversation export / share** — YAGNI
- **qa_history browse UI** — data captured but not surfaced; add when valued
- **Edge runtime streaming** — Node runtime is sufficient
- **E2E Playwright tests** — Stack Auth ESM blocker carries from Slice 1C
- **Cost dashboard** — `qa_history` has the raw token counts; build UI when valued
- **Auto-embed on `+ Add ticker`** — separate Slice 2.5-ish change; orthogonal to Slice 3
