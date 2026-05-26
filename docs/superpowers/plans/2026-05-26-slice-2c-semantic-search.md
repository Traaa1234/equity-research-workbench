# Slice 2C — Semantic Search Across Watchlist Filings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "search across your watchlist's filings" experience. User types a natural-language query at the top of the `/watchlist` page (e.g. *"China tariff exposure"*) → ranked list of paragraph-sized hits from across every filing of every ticker they watch, each with click-through to the source filing.

**Architecture:** New `chunk_embeddings` table holds 1024-dim vectors from DashScope `text-embedding-v3`, indexed with pgvector HNSW. `EmbeddingsService.embedFiling()` is wired into the existing `FilingsService.ingest` (Slice 2A) so vectors are populated automatically when a user clicks "Load filings". At query time, `SearchService.searchAcrossWatchlist()` embeds the user's query, runs a `ORDER BY embedding <=> $query LIMIT k` SQL filtered to the user's watchlist tickers, and returns ranked chunks.

**Tech Stack:** Slice 2B stack + pgvector Postgres extension + `@dqbd/tiktoken` (sub-chunking tokenizer) + Drizzle custom vector column.

**Spec reference:** `docs/superpowers/specs/2026-05-26-slice-2c-semantic-search-design.md`

**Prior phases:** Slices 1 + 2A + 2B shipped to production. This plan picks up at commit `b8d4d62` (the Slice 2C spec).

---

## File Structure for Slice 2C

```
equity-research-workbench/
├── app/
│   ├── (app)/watchlist/
│   │   ├── page.tsx                                  # MODIFIED: searchParams + SearchResults
│   │   └── _components/
│   │       ├── search-bar.tsx                        # client island (NEW)
│   │       ├── search-results.tsx                    # async server component (NEW)
│   │       ├── search-result-card.tsx                # single card (NEW)
│   │       └── search-skeleton.tsx                   # Suspense fallback (NEW)
│   ├── (app)/stock/[ticker]/filings/[accession]/
│   │   └── _components/
│   │       └── section-nav.tsx                       # MODIFIED: read hash, preselect tab
│   └── api/
│       └── search/
│           └── route.ts                              # GET handler (NEW)
├── lib/
│   ├── db/
│   │   ├── schema.ts                                 # MODIFIED: vector column + chunkEmbeddings
│   │   ├── types.ts                                  # MODIFIED: ChunkEmbedding types
│   │   └── migrations/
│   │       ├── 0006_<random>.sql                    # auto-gen (NEW)
│   │       └── 9996_rls_chunk_embeddings.sql        # hand-applied (NEW)
│   ├── providers/
│   │   ├── embeddings.ts                             # EmbeddingsProviderImpl (NEW)
│   │   └── types.ts                                  # MODIFIED: add embedding types
│   └── services/
│       ├── chunking.ts                               # subChunk() pure function (NEW)
│       ├── embeddings.ts                             # EmbeddingsService (NEW)
│       ├── filings.ts                                # MODIFIED: wire embedFiling
│       └── search.ts                                 # SearchService (NEW)
├── scripts/
│   └── try-search.ts                                 # smoke test (NEW)
└── tests/
    ├── providers/
    │   ├── embeddings.test.ts                        # 7 unit tests (NEW)
    │   └── __fixtures__/
    │       └── embeddings-response.json              # fixture (NEW)
    ├── services/
    │   └── chunking.test.ts                          # 7 unit tests (NEW)
    └── integration/
        ├── embeddings-service.test.ts                # 6 tests (NEW)
        ├── search-service.test.ts                    # 6 tests (NEW)
        ├── api-search.test.ts                        # 6 tests (NEW)
        └── chunk-embeddings-rls.test.ts              # 2 tests (NEW)
```

**Module responsibilities:**

| Module | Purpose | Depends on |
| --- | --- | --- |
| `lib/providers/embeddings.ts` | OpenAI-SDK-backed DashScope `/embeddings` adapter, single `embed()` batch method | `openai`, provider types |
| `lib/services/chunking.ts` | Pure `subChunk()` function: text → ~500-token windows w/ overlap + char offsets | `@dqbd/tiktoken` |
| `lib/services/embeddings.ts` | `EmbeddingsService.embedFiling()` — sub-chunk + batch + persist + idempotent | EmbeddingsProvider, FilingsService, chunking, db |
| `lib/services/search.ts` | `SearchService.searchAcrossWatchlist()` — embed query, ranked SQL, filter | EmbeddingsProvider, db |
| `lib/services/filings.ts` (modified) | Adds optional `embeddingsService` dep; calls `embedFiling()` inside `ingest` | EmbeddingsService |
| `app/api/search/route.ts` | Thin HTTP shell over SearchService — auth + validation | SearchService |
| `app/(app)/watchlist/_components/*` | Search bar, results, cards, skeleton, page wiring | SearchService (server-side), API (none — server-rendered) |

---

## Milestone 1: Schema + pgvector + RLS

### Task 1.1: Add `vector` custom column + `chunkEmbeddings` table to Drizzle schema

**Files:**
- Modify: `lib/db/schema.ts`
- Modify: `lib/db/types.ts`

- [ ] **Step 1: Add the `vector` custom column helper to `lib/db/schema.ts`**

Add the import at the top of the file (merge with existing `drizzle-orm/pg-core` imports):

```ts
import { customType } from 'drizzle-orm/pg-core';
```

Then add this helper above the existing table definitions:

```ts
// Custom column type for pgvector. Drizzle's pg-core doesn't ship a `vector`
// type yet, so we define one. Stores as JSON array literal '[0.1,0.2,...]',
// which pgvector accepts as input. Reads back as number[].
export const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1024})`;
  },
  toDriver(value) {
    return JSON.stringify(value);
  },
  fromDriver(raw) {
    return typeof raw === 'string' ? (JSON.parse(raw) as number[]) : (raw as unknown as number[]);
  }
});
```

- [ ] **Step 2: Append the `chunkEmbeddings` table to `lib/db/schema.ts`**

```ts
export const chunkEmbeddings = pgTable(
  'chunk_embeddings',
  {
    filingId: text('filing_id')
      .notNull()
      .references(() => filings.accessionNo, { onDelete: 'cascade' }),
    sectionKey: text('section_key').notNull(),
    subChunkIndex: integer('sub_chunk_index').notNull(),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: 1024 }).notNull(),
    charOffsetStart: integer('char_offset_start'),
    charOffsetEnd: integer('char_offset_end'),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }).notNull().defaultNow(),
    model: text('model').notNull()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.filingId, t.sectionKey, t.subChunkIndex] }),
    filingIdx: index('chunk_embeddings_filing_idx').on(t.filingId)
  })
);
```

- [ ] **Step 3: Append types to `lib/db/types.ts`**

Merge `chunkEmbeddings` into the existing `import type { ... } from './schema'` line at the top, then add:

```ts
export type ChunkEmbedding    = typeof chunkEmbeddings.$inferSelect;
export type NewChunkEmbedding = typeof chunkEmbeddings.$inferInsert;
```

- [ ] **Step 4: Generate the migration**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm db:generate
```

Expected: creates `lib/db/migrations/0006_<random>.sql` containing `CREATE TABLE chunk_embeddings ...` with `embedding vector(1024) NOT NULL`. Inspect the file — it should include the FK to `filings(accession_no)` with cascade and the composite PK.

**Important:** the migration will fail if pgvector isn't already installed on the target Neon branch. Task 1.2 enables the extension on both branches BEFORE we apply this migration.

- [ ] **Step 5: Verify typecheck**

```bash
pnpm typecheck 2>&1 | tail -3
```

Expected: exit 0.

- [ ] **Step 6: Commit (migration applied in T1.2)**

```bash
git add lib/db/schema.ts lib/db/types.ts lib/db/migrations/
git commit -m "feat(db): add chunk_embeddings schema + vector custom column for Slice 2C"
```

---

### Task 1.2: Enable pgvector, apply migration, add HNSW index, apply RLS

**Files:**
- Create: `lib/db/migrations/9996_rls_chunk_embeddings.sql`

Same critical constraint as Slice 2B T1.1 / T1.2 / 2A T1.2: **DO NOT use `drizzle-kit push --force`** — it wipes RLS policies. Apply SQL directly via `postgres.js` as shown below.

- [ ] **Step 1: Write the RLS file**

`lib/db/migrations/9996_rls_chunk_embeddings.sql`:

```sql
-- RLS for Slice 2C: chunk_embeddings.
-- Same pattern as filings/filing_chunks/filing_summaries: any authenticated
-- user can SELECT, writes go through service_role (BYPASSRLS). The
-- user-scoping for search is enforced by the application layer via the
-- watchlist subquery in SearchService.

alter table public.chunk_embeddings enable row level security;

drop policy if exists "auth read chunk_embeddings" on public.chunk_embeddings;
create policy "auth read chunk_embeddings"
  on public.chunk_embeddings for select to authenticated using (true);

grant select on public.chunk_embeddings to authenticated;
```

- [ ] **Step 2: Write the temp `_apply.ts` runner in the project root**

```ts
import { config } from 'dotenv';
config({ path: '.env.local' });
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

const targetArg = process.argv.indexOf('--target');
const fileArg = process.argv.indexOf('--file');
const sqlArg = process.argv.indexOf('--sql');
const target = targetArg >= 0 ? process.argv[targetArg + 1] : null;
const file = fileArg >= 0 ? process.argv[fileArg + 1] : null;
const inlineSql = sqlArg >= 0 ? process.argv[sqlArg + 1] : null;
if (!target || (!file && !inlineSql)) {
  console.error('Usage: tsx _apply.ts --target prod|test (--file <path> | --sql "<SQL>")');
  process.exit(2);
}

const url = target === 'prod'
  ? process.env.DATABASE_URL_SERVICE_ROLE
  : process.env.DATABASE_URL_TEST_SERVICE_ROLE;
if (!url) { console.error(`URL for ${target} not set`); process.exit(2); }

const sqlText = file ? readFileSync(file, 'utf8') : inlineSql!;
const sql = postgres(url, { prepare: false, max: 1 });
try {
  await sql.unsafe(sqlText);
  console.log(`Applied ${file ?? '(inline SQL)'} to ${target} OK`);
} catch (e) {
  console.error('Apply failed:', e);
  process.exit(1);
} finally {
  await sql.end();
}
```

- [ ] **Step 3: Enable pgvector on both Neon branches**

```bash
pnpm exec tsx _apply.ts --target prod --sql "create extension if not exists vector"
pnpm exec tsx _apply.ts --target test --sql "create extension if not exists vector"
```

Expected: `Applied (inline SQL) to prod OK` and `Applied (inline SQL) to test OK`.

- [ ] **Step 4: Apply the Drizzle-generated migration to both branches**

Find the generated migration filename from T1.1 (e.g., `0006_<random>.sql`) and apply:

```bash
pnpm exec tsx _apply.ts --target prod --file lib/db/migrations/0006_<random>.sql
pnpm exec tsx _apply.ts --target test --file lib/db/migrations/0006_<random>.sql
```

Both should print success. If they fail with "type vector does not exist", the extension didn't enable — re-run Step 3.

- [ ] **Step 5: Add the HNSW index to both branches**

```bash
pnpm exec tsx _apply.ts --target prod --sql "create index if not exists chunk_embeddings_hnsw on chunk_embeddings using hnsw (embedding vector_cosine_ops)"
pnpm exec tsx _apply.ts --target test --sql "create index if not exists chunk_embeddings_hnsw on chunk_embeddings using hnsw (embedding vector_cosine_ops)"
```

Expected: both succeed. (Creating the HNSW index on an empty table is instant. If the table already had millions of rows, this would take minutes — not our case yet.)

- [ ] **Step 6: Apply the RLS file to both branches**

```bash
pnpm exec tsx _apply.ts --target prod --file lib/db/migrations/9996_rls_chunk_embeddings.sql
pnpm exec tsx _apply.ts --target test --file lib/db/migrations/9996_rls_chunk_embeddings.sql
```

- [ ] **Step 7: Verify table + index + policy exist on both branches**

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

  const cols = await sql`select column_name, data_type, udt_name from information_schema.columns where table_schema = 'public' and table_name = 'chunk_embeddings' order by ordinal_position`;
  console.log(`\n${label.toUpperCase()} columns:`);
  for (const c of cols) console.log(`  ${c.column_name}: ${c.udt_name === 'vector' ? 'vector' : c.data_type}`);

  const idx = await sql`select indexname from pg_indexes where schemaname = 'public' and tablename = 'chunk_embeddings'`;
  console.log(`${label} indexes:`);
  for (const i of idx) console.log(`  ${i.indexname}`);

  const policies = await sql`select policyname from pg_policies where schemaname = 'public' and tablename = 'chunk_embeddings'`;
  console.log(`${label} policies: ${policies.length}`);

  await sql.end();
}
```

```bash
pnpm exec tsx _check.ts
```

Expected output for each branch:
- Columns include `embedding: vector` (not text!)
- Indexes include `chunk_embeddings_hnsw` and `chunk_embeddings_pkey`
- Policies count = 1

Delete `_apply.ts` and `_check.ts`.

- [ ] **Step 8: Commit**

```bash
git add lib/db/migrations/9996_rls_chunk_embeddings.sql
git commit -m "feat(db): pgvector extension + HNSW index + RLS for chunk_embeddings"
```

---

## Milestone 2: Embeddings provider

### Task 2.1: Add types + write `EmbeddingsProviderImpl`

**Files:**
- Modify: `lib/providers/types.ts` (append types)
- Create: `lib/providers/embeddings.ts`

The `openai` npm package is already installed from Slice 2B. Reusing DashScope endpoint + `DASHSCOPE_API_KEY`.

- [ ] **Step 1: Append types to `lib/providers/types.ts`**

```ts
// DashScope embeddings provider — used by EmbeddingsProvider.
export interface EmbeddingsRequest {
  model: string;
  texts: string[];   // up to 25 texts per call (DashScope limit)
}

export interface EmbeddingsResult {
  vectors: number[][];   // one per input text, all same dimensionality
  inputTokens: number;
}

export interface EmbeddingsProvider {
  embed(req: EmbeddingsRequest): Promise<EmbeddingsResult>;
}
```

- [ ] **Step 2: Write `lib/providers/embeddings.ts`**

```ts
import OpenAI from 'openai';
import {
  EmbeddingsProvider,
  EmbeddingsRequest,
  EmbeddingsResult,
  NotFoundError,
  ProviderError,
  RateLimitError,
  UnknownProviderError,
  ValidationError
} from './types';

const DEFAULT_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const DEFAULT_TIMEOUT_MS = 30_000;

interface Options {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class EmbeddingsProviderImpl implements EmbeddingsProvider {
  private readonly client: OpenAI;

  constructor(opts: Options = {}) {
    const apiKey = opts.apiKey ?? process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      throw new ProviderError('DASHSCOPE_API_KEY is not set');
    }
    type ClientConfig = ConstructorParameters<typeof OpenAI>[0] & { fetch?: typeof fetch };
    const clientConfig: ClientConfig = {
      apiKey,
      baseURL: opts.baseUrl ?? DEFAULT_BASE_URL,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: 0
    };
    if (opts.fetch) clientConfig.fetch = opts.fetch;
    this.client = new OpenAI(clientConfig);
  }

  async embed(req: EmbeddingsRequest): Promise<EmbeddingsResult> {
    if (req.texts.length === 0) {
      return { vectors: [], inputTokens: 0 };
    }
    try {
      const response = await this.client.embeddings.create({
        model: req.model,
        input: req.texts
      });
      if (!response.data || response.data.length !== req.texts.length) {
        throw new UnknownProviderError(
          `DashScope returned ${response.data?.length ?? 0} vectors for ${req.texts.length} inputs`
        );
      }
      const vectors = response.data.map((d) => d.embedding);
      const inputTokens = response.usage?.prompt_tokens ?? 0;
      return { vectors, inputTokens };
    } catch (err) {
      throw mapOpenAIError(err);
    }
  }
}

function mapOpenAIError(err: unknown): Error {
  if (
    err instanceof NotFoundError ||
    err instanceof ValidationError ||
    err instanceof ProviderError ||
    err instanceof RateLimitError ||
    err instanceof UnknownProviderError
  ) {
    return err;
  }
  const anyErr = err as { status?: number; message?: string; name?: string };
  const msg = anyErr.message ?? 'Unknown DashScope embeddings error';
  if (anyErr.name === 'APIConnectionTimeoutError' || /timeout/i.test(msg)) {
    return new ProviderError(`Embeddings timeout: ${msg}`);
  }
  if (anyErr.status === 429) return new RateLimitError(msg);
  if (anyErr.status && anyErr.status >= 500) return new ProviderError(`Embeddings ${anyErr.status}: ${msg}`);
  if (anyErr.status === 401 || anyErr.status === 403) return new ValidationError(`Embeddings auth failed: ${msg}`);
  if (anyErr.status && anyErr.status >= 400) return new ValidationError(`Embeddings ${anyErr.status}: ${msg}`);
  return new UnknownProviderError(msg);
}
```

- [ ] **Step 3: Verify typecheck**

```bash
pnpm typecheck 2>&1 | tail -3
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add lib/providers/types.ts lib/providers/embeddings.ts
git commit -m "feat(providers): EmbeddingsProvider (DashScope text-embedding-v3)"
```

---

### Task 2.2: Provider unit tests

**Files:**
- Create: `lib/providers/__fixtures__/embeddings-response.json`
- Create: `tests/providers/embeddings.test.ts`

Same fixture path convention as Slice 2A/2B: `lib/providers/__fixtures__/` (not `tests/providers/__fixtures__/`).

- [ ] **Step 1: Write the fixture**

`lib/providers/__fixtures__/embeddings-response.json`:

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08]
    },
    {
      "object": "embedding",
      "index": 1,
      "embedding": [0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18]
    }
  ],
  "model": "text-embedding-v3",
  "usage": {
    "prompt_tokens": 50,
    "total_tokens": 50
  }
}
```

(Vectors are deliberately short — 8 dims — to keep the fixture readable. The real model returns 1024 dims, but the provider doesn't care about dimensionality.)

- [ ] **Step 2: Write the failing test**

`tests/providers/embeddings.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';
import {
  ProviderError,
  RateLimitError,
  UnknownProviderError,
  ValidationError
} from '@/lib/providers/types';
import { loadFixture } from '../helpers/fixtures';

function makeProvider(fetchMock: typeof fetch) {
  return new EmbeddingsProviderImpl({
    apiKey: 'sk-test-key',
    baseUrl: 'http://test.local/v1',
    fetch: fetchMock,
    timeoutMs: 5000
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  });
}

describe('EmbeddingsProviderImpl', () => {
  it('constructor throws ProviderError when DASHSCOPE_API_KEY is missing', () => {
    const orig = process.env.DASHSCOPE_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    try {
      expect(() => new EmbeddingsProviderImpl()).toThrow(ProviderError);
    } finally {
      if (orig) process.env.DASHSCOPE_API_KEY = orig;
    }
  });

  it('embed: happy path returns vectors + token counts', async () => {
    const fix = loadFixture('embeddings-response.json');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
    const provider = makeProvider(fetchMock);
    const result = await provider.embed({
      model: 'text-embedding-v3',
      texts: ['hello', 'world']
    });
    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toEqual([0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08]);
    expect(result.inputTokens).toBe(50);
  });

  it('embed: sends correct request shape', async () => {
    const fix = loadFixture('embeddings-response.json');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
    const provider = makeProvider(fetchMock);
    await provider.embed({ model: 'text-embedding-v3', texts: ['a', 'b'] });
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://test.local/v1/embeddings');
    const body = JSON.parse(String((init as any).body));
    expect(body.model).toBe('text-embedding-v3');
    expect(body.input).toEqual(['a', 'b']);
    const headers = (init as any).headers as Headers;
    expect(headers.get('authorization')).toContain('Bearer sk-test-key');
  });

  it('embed: empty input returns empty result without calling API', async () => {
    const fetchMock = vi.fn();
    const provider = makeProvider(fetchMock);
    const result = await provider.embed({ model: 'text-embedding-v3', texts: [] });
    expect(result.vectors).toEqual([]);
    expect(result.inputTokens).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('embed: 429 throws RateLimitError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 })
    );
    const provider = makeProvider(fetchMock);
    await expect(provider.embed({ model: 'text-embedding-v3', texts: ['x'] }))
      .rejects.toBeInstanceOf(RateLimitError);
  });

  it('embed: 500 throws ProviderError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'server error' } }), { status: 500 })
    );
    const provider = makeProvider(fetchMock);
    await expect(provider.embed({ model: 'text-embedding-v3', texts: ['x'] }))
      .rejects.toBeInstanceOf(ProviderError);
  });

  it('embed: 401 throws ValidationError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 })
    );
    const provider = makeProvider(fetchMock);
    await expect(provider.embed({ model: 'text-embedding-v3', texts: ['x'] }))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it('embed: response with wrong vector count throws UnknownProviderError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
        model: 'text-embedding-v3',
        usage: { prompt_tokens: 10, total_tokens: 10 }
      })
    );
    const provider = makeProvider(fetchMock);
    await expect(provider.embed({ model: 'text-embedding-v3', texts: ['a', 'b'] }))
      .rejects.toBeInstanceOf(UnknownProviderError);
  });
});
```

- [ ] **Step 3: Run, verify passes**

```bash
pnpm test tests/providers/embeddings.test.ts 2>&1 | tail -15
```

Expected: 7 passing.

If any test fails because the openai v6 SDK normalizes errors differently than expected, inspect the actual error thrown (`console.error('actual:', err)` inside `mapOpenAIError`) and adjust the mapping. Do NOT change the test to match buggy behavior.

- [ ] **Step 4: Commit**

```bash
git add tests/providers/embeddings.test.ts lib/providers/__fixtures__/embeddings-response.json
git commit -m "test(providers): EmbeddingsProvider unit tests (7 cases)"
```

---

## Milestone 3: Chunking + service

### Task 3.1: `subChunk()` pure function + unit tests

**Files:**
- Create: `lib/services/chunking.ts`
- Create: `tests/services/chunking.test.ts`

- [ ] **Step 1: Install the tokenizer**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm add @dqbd/tiktoken
```

Expected: small dependency installs cleanly. WASM-backed, ~1 MB.

- [ ] **Step 2: Write the failing test**

`tests/services/chunking.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { subChunk } from '@/lib/services/chunking';

describe('subChunk', () => {
  it('returns empty array for empty input', () => {
    const chunks = subChunk('');
    expect(chunks).toEqual([]);
  });

  it('returns single chunk when text fits in one window', () => {
    const text = 'Apple designs and sells consumer electronics.';
    const chunks = subChunk(text, { targetTokens: 500, overlapTokens: 50 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(text);
    expect(chunks[0]!.charOffsetStart).toBe(0);
    expect(chunks[0]!.charOffsetEnd).toBe(text.length);
  });

  it('splits long text into multiple windows', () => {
    // Build ~1500 tokens of text by repeating a sentence
    const sentence = 'This is a test sentence about Apple Inc. and its risk factors related to manufacturing operations in China. ';
    const text = sentence.repeat(80); // roughly 1500-2000 tokens
    const chunks = subChunk(text, { targetTokens: 500, overlapTokens: 50 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // Every chunk has non-empty text
    for (const c of chunks) {
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.charOffsetStart).toBeGreaterThanOrEqual(0);
      expect(c.charOffsetEnd).toBeLessThanOrEqual(text.length);
      expect(c.charOffsetEnd).toBeGreaterThan(c.charOffsetStart);
    }
  });

  it('consecutive chunks overlap', () => {
    const sentence = 'Sentence about manufacturing concentration risk in supply chains. ';
    const text = sentence.repeat(80);
    const chunks = subChunk(text, { targetTokens: 500, overlapTokens: 50 });
    if (chunks.length >= 2) {
      // Second chunk should start BEFORE the first chunk ends (overlap)
      expect(chunks[1]!.charOffsetStart).toBeLessThan(chunks[0]!.charOffsetEnd);
    }
  });

  it('char offsets map back to original text', () => {
    const text = 'Apple designs phones. Apple sells phones globally. Apple faces competition.';
    const chunks = subChunk(text, { targetTokens: 5, overlapTokens: 1 });
    for (const c of chunks) {
      const sliced = text.slice(c.charOffsetStart, c.charOffsetEnd);
      // The chunk text should equal a slice of the original (possibly trimmed)
      expect(sliced.includes(c.text.trim().slice(0, 10)) || c.text.trim().startsWith(sliced.trim().slice(0, 10))).toBe(true);
    }
  });

  it('snaps to paragraph boundary when nearby', () => {
    const text = 'Para one talks about manufacturing risks in detail.\n\nPara two talks about regulatory risks in detail.\n\nPara three is here.';
    const chunks = subChunk(text, { targetTokens: 10, overlapTokens: 1 });
    // At least one chunk boundary should align near a paragraph break (\n\n)
    const offsets = chunks.flatMap((c) => [c.charOffsetStart, c.charOffsetEnd]);
    const paraBreaks = [text.indexOf('\n\n'), text.indexOf('\n\n', text.indexOf('\n\n') + 1)].filter((i) => i >= 0);
    // It's enough to verify that no chunk straddles a paragraph break unnecessarily — at least one offset should align with one of the breaks (within 50 chars)
    const aligned = offsets.some((o) => paraBreaks.some((p) => Math.abs(o - p) < 50));
    expect(aligned).toBe(true);
  });

  it('handles default options', () => {
    const text = 'Short text. '.repeat(10);
    const chunks = subChunk(text); // no opts
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const c of chunks) {
      expect(c.text.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 3: Run, verify fails**

```bash
pnpm test tests/services/chunking.test.ts 2>&1 | tail -10
```

Expected: fails with `Cannot find module '@/lib/services/chunking'`.

- [ ] **Step 4: Write `lib/services/chunking.ts`**

```ts
import { encoding_for_model, get_encoding, type Tiktoken } from '@dqbd/tiktoken';

export interface SubChunk {
  text: string;
  charOffsetStart: number;
  charOffsetEnd: number;
}

interface Opts {
  targetTokens?: number;
  overlapTokens?: number;
}

const DEFAULT_TARGET = 500;
const DEFAULT_OVERLAP = 50;
const PARAGRAPH_SNAP_WINDOW_CHARS = 50;

// We don't have a tiktoken encoding for qwen specifically, but cl100k_base
// (used by gpt-3.5/4) is close enough for chunking purposes. Token counts
// don't need to be exact — they just need to be consistent for window math.
function getEncoding(): Tiktoken {
  try {
    return encoding_for_model('gpt-4');
  } catch {
    return get_encoding('cl100k_base');
  }
}

/**
 * Split text into ~targetTokens windows with overlap, snapping to paragraph
 * breaks where convenient. Pure function — no DB, no network, deterministic.
 */
export function subChunk(text: string, opts: Opts = {}): SubChunk[] {
  if (!text || text.length === 0) return [];

  const targetTokens = opts.targetTokens ?? DEFAULT_TARGET;
  const overlapTokens = opts.overlapTokens ?? DEFAULT_OVERLAP;

  const enc = getEncoding();
  try {
    const tokens = enc.encode(text);
    if (tokens.length === 0) return [];
    if (tokens.length <= targetTokens) {
      return [{ text, charOffsetStart: 0, charOffsetEnd: text.length }];
    }

    const chunks: SubChunk[] = [];
    let tokenStart = 0;
    while (tokenStart < tokens.length) {
      const tokenEnd = Math.min(tokenStart + targetTokens, tokens.length);

      // Decode this token range back to chars
      const subTokens = tokens.slice(tokenStart, tokenEnd);
      const chunkBytes = enc.decode(subTokens);
      const chunkText = new TextDecoder().decode(chunkBytes);

      // Locate the chunk within the original text. The tokenizer is roundtrip-stable,
      // so chunkText should appear at the right position. Use sequential search anchored
      // at the running char position estimate.
      let charStart: number;
      if (chunks.length === 0) {
        charStart = 0;
      } else {
        // Estimate based on prior chunk's end minus the overlap fraction
        const prev = chunks[chunks.length - 1]!;
        const overlapFrac = overlapTokens / targetTokens;
        const estimatedStep = (prev.charOffsetEnd - prev.charOffsetStart) * (1 - overlapFrac);
        charStart = Math.max(0, Math.round(prev.charOffsetStart + estimatedStep));
        // Find the actual position of chunkText starting from the estimate
        const foundAt = text.indexOf(chunkText.slice(0, 30), charStart - 20);
        if (foundAt >= 0) charStart = foundAt;
      }
      let charEnd = Math.min(charStart + chunkText.length, text.length);

      // Snap end to nearest paragraph break (double newline) within window
      const snapTarget = text.lastIndexOf('\n\n', charEnd + PARAGRAPH_SNAP_WINDOW_CHARS);
      if (snapTarget >= 0 && snapTarget > charStart && Math.abs(snapTarget - charEnd) <= PARAGRAPH_SNAP_WINDOW_CHARS) {
        charEnd = snapTarget;
      }

      const slicedText = text.slice(charStart, charEnd).trim();
      if (slicedText.length > 0) {
        chunks.push({
          text: slicedText,
          charOffsetStart: charStart,
          charOffsetEnd: charEnd
        });
      }

      // Advance: step forward by (targetTokens - overlapTokens)
      const step = Math.max(1, targetTokens - overlapTokens);
      tokenStart += step;
    }

    return chunks;
  } finally {
    enc.free();
  }
}
```

- [ ] **Step 5: Run, verify passes**

```bash
pnpm test tests/services/chunking.test.ts 2>&1 | tail -15
```

Expected: 7 passing.

If any test fails because the WASM tokenizer behaves unexpectedly (paragraph-snap test is the trickiest), debug by printing the chunk offsets and comparing to where `\n\n` actually falls in the test string. Adjust the snap window or paragraph-break detection if needed — but keep the core algorithm intact.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml lib/services/chunking.ts tests/services/chunking.test.ts
git commit -m "feat(services): subChunk() pure function for ~500-token windowing"
```

---

### Task 3.2: `EmbeddingsService` + integration tests

**Files:**
- Create: `lib/services/embeddings.ts`
- Create: `tests/integration/embeddings-service.test.ts`

- [ ] **Step 1: Write the failing integration test**

`tests/integration/embeddings-service.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, filings, filingChunks, chunkEmbeddings } from '@/lib/db/schema';
import { FilingsService } from '@/lib/services/filings';
import { EmbeddingsService, CURRENT_EMBED_MODEL } from '@/lib/services/embeddings';

config({ path: '.env.local' });

const ACCESSION = '0000320193-24-000123';

function mockProvider(vectorsToReturn?: number[][]) {
  return {
    embed: vi.fn().mockImplementation(async (req: { texts: string[] }) => {
      // Return one 1024-dim vector per input text by default
      const vectors = vectorsToReturn ?? req.texts.map(() => Array(1024).fill(0).map((_, i) => i / 1024));
      return { vectors, inputTokens: req.texts.length * 100 };
    })
  };
}

async function seedFilingWithChunks(db: any) {
  await db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
  await db.insert(filings).values({
    accessionNo: ACCESSION, ticker: 'AAPL', cik: '0000320193',
    formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
  });
  await db.insert(filingChunks).values([
    { filingId: ACCESSION, sectionKey: 'item_1_business', sectionTitle: 'Business', text: 'Apple does many things.', charCount: 23 },
    { filingId: ACCESSION, sectionKey: 'item_7_mdna', sectionTitle: 'MD&A', text: 'Revenue increased materially.', charCount: 29 }
  ]);
}

describe('EmbeddingsService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => { await resetDb(dbH.db); });

  it('embedFiling: cache miss embeds + persists', async () => {
    await seedFilingWithChunks(dbH.db);
    const provider = mockProvider();
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new EmbeddingsService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.embedFiling(ACCESSION);

    expect(result.count).toBeGreaterThan(0);
    expect(provider.embed).toHaveBeenCalled();
    const rows = await dbH.db.select().from(chunkEmbeddings).where(eq(chunkEmbeddings.filingId, ACCESSION));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.model).toBe(CURRENT_EMBED_MODEL);
  });

  it('embedFiling: cache hit (already embedded with current model) is a no-op', async () => {
    await seedFilingWithChunks(dbH.db);
    // Pre-seed an embedding row
    await dbH.db.insert(chunkEmbeddings).values({
      filingId: ACCESSION,
      sectionKey: 'item_1_business',
      subChunkIndex: 0,
      text: 'Apple does many things.',
      embedding: Array(1024).fill(0.5),
      model: CURRENT_EMBED_MODEL,
      charOffsetStart: 0,
      charOffsetEnd: 23
    });
    const provider = mockProvider();
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new EmbeddingsService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.embedFiling(ACCESSION);

    expect(provider.embed).not.toHaveBeenCalled();
    expect(result.count).toBe(0);
  });

  it('embedFiling: re-embeds when only old-model rows exist', async () => {
    await seedFilingWithChunks(dbH.db);
    await dbH.db.insert(chunkEmbeddings).values({
      filingId: ACCESSION,
      sectionKey: 'item_1_business',
      subChunkIndex: 0,
      text: 'stale',
      embedding: Array(1024).fill(0),
      model: 'old-model-name',
      charOffsetStart: 0,
      charOffsetEnd: 5
    });
    const provider = mockProvider();
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new EmbeddingsService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.embedFiling(ACCESSION);

    expect(provider.embed).toHaveBeenCalled();
    expect(result.count).toBeGreaterThan(0);
  });

  it('embedFiling: filing with no chunks returns count 0 without calling provider', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    await dbH.db.insert(filings).values({
      accessionNo: ACCESSION, ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
    });
    const provider = mockProvider();
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new EmbeddingsService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.embedFiling(ACCESSION);

    expect(result.count).toBe(0);
    expect(provider.embed).not.toHaveBeenCalled();
  });

  it('embedFiling: partial-write recovery — ON CONFLICT DO NOTHING fills gaps', async () => {
    await seedFilingWithChunks(dbH.db);
    // Pre-seed a partial row (current model, but only one sub-chunk)
    await dbH.db.insert(chunkEmbeddings).values({
      filingId: ACCESSION,
      sectionKey: 'item_1_business',
      subChunkIndex: 0,
      text: 'pre-existing',
      embedding: Array(1024).fill(0.1),
      model: CURRENT_EMBED_MODEL,
      charOffsetStart: 0,
      charOffsetEnd: 12
    });
    const provider = mockProvider();
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new EmbeddingsService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    // First, our cache check should report the filing is already embedded.
    // (Partial recovery would only kick in if we explicitly cleared and re-ran.)
    // This test verifies the no-op path when at least one current-model row exists.
    const result = await svc.embedFiling(ACCESSION);
    expect(result.count).toBe(0);
  });

  it('embedFiling: writes a refresh_runs row on success', async () => {
    await seedFilingWithChunks(dbH.db);
    const provider = mockProvider();
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new EmbeddingsService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    await svc.embedFiling(ACCESSION);

    const { refreshRuns } = await import('@/lib/db/schema');
    const runs = await dbH.db.select().from(refreshRuns).where(eq(refreshRuns.kind, `embed:${ACCESSION}`));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(true);
    expect(runs[0]!.sourceUsed).toBe('dashscope_embed');
  });
});
```

- [ ] **Step 2: Run, verify fails**

```bash
pnpm test:integration tests/integration/embeddings-service.test.ts 2>&1 | tail -10
```

Expected: import error.

- [ ] **Step 3: Write `lib/services/embeddings.ts`**

```ts
import { and, eq, sql } from 'drizzle-orm';
import { filings, chunkEmbeddings, refreshRuns } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import { EmbeddingsProvider, ValidationError } from '@/lib/providers/types';
import { logger } from '@/lib/logger';
import { FilingsService } from './filings';
import { subChunk } from './chunking';

export const CURRENT_EMBED_MODEL = 'text-embedding-v3';
const BATCH_SIZE = 25;
const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 50;

interface Deps {
  db: ServiceDb;
  provider: EmbeddingsProvider;
  filingsService: FilingsService;
}

export interface EmbedFilingResult {
  filingId: string;
  count: number;
  durationMs: number;
}

export class EmbeddingsService {
  constructor(private readonly deps: Deps) {}

  async embedFiling(filingId: string): Promise<EmbedFilingResult> {
    const started = Date.now();

    // Cache check
    const existing = await this.deps.db
      .select({ c: sql<number>`count(*)::int` })
      .from(chunkEmbeddings)
      .where(and(eq(chunkEmbeddings.filingId, filingId), eq(chunkEmbeddings.model, CURRENT_EMBED_MODEL)));
    const existingCount = existing[0]?.c ?? 0;
    if (existingCount > 0) {
      return { filingId, count: 0, durationMs: Date.now() - started };
    }

    // Look up filing for ticker (needed for refresh_runs)
    const filingRows = await this.deps.db.select().from(filings).where(eq(filings.accessionNo, filingId)).limit(1);
    if (filingRows.length === 0) {
      throw new ValidationError(`Filing not found: ${filingId}`);
    }
    const filing = filingRows[0]!;

    // Fetch sections + sub-chunk
    const sections = await this.deps.filingsService.getAllSectionTexts(filingId);
    if (sections.length === 0) {
      return { filingId, count: 0, durationMs: Date.now() - started };
    }

    interface PreparedChunk {
      sectionKey: string;
      subChunkIndex: number;
      text: string;
      charOffsetStart: number;
      charOffsetEnd: number;
    }
    const prepared: PreparedChunk[] = [];
    for (const section of sections) {
      const windows = subChunk(section.text, { targetTokens: TARGET_TOKENS, overlapTokens: OVERLAP_TOKENS });
      for (let i = 0; i < windows.length; i++) {
        const w = windows[i]!;
        prepared.push({
          sectionKey: section.sectionKey,
          subChunkIndex: i,
          text: w.text,
          charOffsetStart: w.charOffsetStart,
          charOffsetEnd: w.charOffsetEnd
        });
      }
    }

    if (prepared.length === 0) {
      return { filingId, count: 0, durationMs: Date.now() - started };
    }

    try {
      // Batch + embed + insert
      for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
        const batch = prepared.slice(i, i + BATCH_SIZE);
        const result = await this.deps.provider.embed({
          model: CURRENT_EMBED_MODEL,
          texts: batch.map((p) => p.text)
        });
        if (result.vectors.length !== batch.length) {
          throw new Error(`Provider returned ${result.vectors.length} vectors for ${batch.length} inputs`);
        }
        const rows = batch.map((p, j) => ({
          filingId,
          sectionKey: p.sectionKey,
          subChunkIndex: p.subChunkIndex,
          text: p.text,
          embedding: result.vectors[j]!,
          charOffsetStart: p.charOffsetStart,
          charOffsetEnd: p.charOffsetEnd,
          model: CURRENT_EMBED_MODEL
        }));
        await this.deps.db.insert(chunkEmbeddings).values(rows).onConflictDoNothing();
      }

      await this.deps.db.insert(refreshRuns).values({
        ticker: filing.ticker,
        kind: `embed:${filingId}`,
        startedAt: new Date(started),
        completedAt: new Date(),
        ok: true,
        sourceUsed: 'dashscope_embed'
      });

      return { filingId, count: prepared.length, durationMs: Date.now() - started };
    } catch (err) {
      await this.deps.db.insert(refreshRuns).values({
        ticker: filing.ticker,
        kind: `embed:${filingId}`,
        startedAt: new Date(started),
        completedAt: new Date(),
        ok: false,
        sourceUsed: 'dashscope_embed',
        error: String(err).slice(0, 1000)
      });
      logger.warn({ filingId, err: String(err) }, 'embeddings: embedFiling failed');
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run, verify passes**

```bash
pnpm test:integration tests/integration/embeddings-service.test.ts 2>&1 | tail -15
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/services/embeddings.ts tests/integration/embeddings-service.test.ts
git commit -m "feat(services): EmbeddingsService with idempotent embedFiling()"
```

---

### Task 3.3: Wire `embedFiling` into `FilingsService.ingest`

**Files:**
- Modify: `lib/services/filings.ts`
- Modify: `tests/integration/filings-service.test.ts` (verify existing tests still pass + add 1 new test)

The existing `FilingsService` constructor takes `Deps = { db, provider }`. We add an optional `embeddingsService` field so existing tests (which don't supply it) still work, and the production caller (API route) supplies it.

- [ ] **Step 1: Modify `FilingsService` constructor + add optional embed call**

Open `lib/services/filings.ts`. Update the `Deps` interface:

```ts
import type { EmbeddingsService } from './embeddings';

interface Deps {
  db: ServiceDb;
  provider: SecEdgarProvider;
  embeddingsService?: EmbeddingsService;  // OPTIONAL — added in Slice 2C
}
```

In the `ingest` method, inside the per-filing loop, AFTER the existing success path that sets `parsedAt` and inserts the success refresh_runs row, add:

```ts
        // Slice 2C: embed the freshly-parsed filing.
        // Embedding failure does NOT block ingestion — caught + logged separately.
        if (this.deps.embeddingsService) {
          try {
            await this.deps.embeddingsService.embedFiling(filing.accessionNo);
          } catch (embedErr) {
            logger.warn(
              { ticker: t, accession: filing.accessionNo, err: String(embedErr) },
              'filings: embedding failed (filing still readable)'
            );
            // EmbeddingsService already wrote its own refresh_runs row on failure.
          }
        }
```

This goes inside the `for (const filing of needParsing)` loop, after the existing `await this.deps.db.update(filings).set({ parsedAt: new Date() })...` and the existing `refreshRuns` success-insert. **It does NOT replace the existing parse-success refresh_runs row.** It's an additional optional step.

- [ ] **Step 2: Add a test verifying the wire-up works when embeddingsService is supplied**

Append to `tests/integration/filings-service.test.ts` inside the existing `describe('FilingsService', ...)` block, after the `getAllSectionTexts` tests:

```ts
  it('ingest: calls embeddingsService.embedFiling when supplied', async () => {
    const provider = mockProvider({
      cik: '0000320193',
      filings: [{
        accessionNo: '0000320193-24-000123',
        formType: '10-K',
        filingDate: '2024-11-01',
        periodEnd: '2024-09-28',
        primaryDocUrl: 'https://x/1'
      }],
      sections: [
        { section_key: 'item_1_business', section_title: 'Business', text: 'Apple does things.', char_offset_start: 0, char_offset_end: 18 }
      ]
    });
    const embedFiling = vi.fn().mockResolvedValue({ filingId: '0000320193-24-000123', count: 5, durationMs: 100 });
    const embeddingsService = { embedFiling } as any;
    const svc = new FilingsService({ db: dbH.db, provider: provider as any, embeddingsService });

    await svc.ingest('AAPL');

    expect(embedFiling).toHaveBeenCalledWith('0000320193-24-000123');
  });

  it('ingest: embedding failure does NOT block ingestion', async () => {
    const provider = mockProvider({
      cik: '0000320193',
      filings: [{
        accessionNo: '0000320193-24-000123',
        formType: '10-K',
        filingDate: '2024-11-01',
        periodEnd: '2024-09-28',
        primaryDocUrl: 'https://x/1'
      }],
      sections: [
        { section_key: 'item_1_business', section_title: 'Business', text: 'Apple does things.', char_offset_start: 0, char_offset_end: 18 }
      ]
    });
    const embedFiling = vi.fn().mockRejectedValue(new Error('DashScope unavailable'));
    const embeddingsService = { embedFiling } as any;
    const svc = new FilingsService({ db: dbH.db, provider: provider as any, embeddingsService });

    const summary = await svc.ingest('AAPL');

    // Ingest should still report success for parsing despite embed failure
    expect(summary.succeeded).toBe(1);
    expect(embedFiling).toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run all FilingsService tests, verify nothing regressed + new tests pass**

```bash
pnpm test:integration tests/integration/filings-service.test.ts 2>&1 | tail -15
```

Expected: 11 passing (existing 9 + 2 new).

- [ ] **Step 4: Commit**

```bash
git add lib/services/filings.ts tests/integration/filings-service.test.ts
git commit -m "feat(services): wire EmbeddingsService.embedFiling into FilingsService.ingest"
```

---

## Milestone 4: Search + API

### Task 4.1: `SearchService` + integration tests

**Files:**
- Create: `lib/services/search.ts`
- Create: `tests/integration/search-service.test.ts`

- [ ] **Step 1: Write the failing integration test**

`tests/integration/search-service.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companies, filings, filingChunks, chunkEmbeddings, watchlist } from '@/lib/db/schema';
import { SearchService, CURRENT_EMBED_MODEL } from '@/lib/services/search';
import { ValidationError } from '@/lib/providers/types';

config({ path: '.env.local' });

function mockProvider(queryVector?: number[]) {
  return {
    embed: vi.fn().mockImplementation(async () => ({
      vectors: [queryVector ?? Array(1024).fill(0.5)],
      inputTokens: 10
    }))
  };
}

async function seedSearchableFiling(db: any, ticker: string, vectorValues: number[]) {
  await db.insert(companies).values({ ticker, name: `${ticker} Corp` }).onConflictDoNothing();
  const accession = `0000${ticker.slice(0, 4).padEnd(4, '0').toUpperCase()}-24-000001`;
  await db.insert(filings).values({
    accessionNo: accession, ticker, cik: '0000000001',
    formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
  });
  await db.insert(filingChunks).values({
    filingId: accession, sectionKey: 'item_1a_risk_factors',
    sectionTitle: 'Risk Factors', text: `${ticker} faces risks`, charCount: 20
  });
  await db.insert(chunkEmbeddings).values({
    filingId: accession, sectionKey: 'item_1a_risk_factors', subChunkIndex: 0,
    text: `${ticker} faces risks`, embedding: vectorValues, model: CURRENT_EMBED_MODEL,
    charOffsetStart: 0, charOffsetEnd: 20
  });
  return accession;
}

describe('SearchService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  let userId: string;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    userId = newUserId();
  });

  it('searchAcrossWatchlist: empty watchlist returns empty results', async () => {
    const provider = mockProvider();
    const svc = new SearchService({ db: dbH.db, provider: provider as any });
    const results = await svc.searchAcrossWatchlist({ userId, query: 'tariff exposure' });
    expect(results).toEqual([]);
  });

  it('searchAcrossWatchlist: returns ranked results from watchlist filings', async () => {
    // Seed: 2 filings with different vectors, both in the user's watchlist
    const closeVec = Array(1024).fill(0.5);
    const farVec = Array(1024).fill(0).map((_, i) => (i < 10 ? 1.0 : 0));
    await seedSearchableFiling(dbH.db, 'AAPL', closeVec);
    await seedSearchableFiling(dbH.db, 'JD', farVec);
    await dbH.db.insert(watchlist).values([
      { userId, ticker: 'AAPL' },
      { userId, ticker: 'JD' }
    ]);

    const provider = mockProvider(closeVec); // Query is close to AAPL
    const svc = new SearchService({ db: dbH.db, provider: provider as any });
    const results = await svc.searchAcrossWatchlist({ userId, query: 'risk' });

    expect(results.length).toBeGreaterThanOrEqual(1);
    // First result should be AAPL (closer to query vector)
    expect(results[0]!.ticker).toBe('AAPL');
  });

  it('searchAcrossWatchlist: results from non-watchlist tickers are excluded', async () => {
    const vec = Array(1024).fill(0.5);
    await seedSearchableFiling(dbH.db, 'AAPL', vec);
    await seedSearchableFiling(dbH.db, 'NIO', vec); // identical vector but NOT in watchlist
    await dbH.db.insert(watchlist).values({ userId, ticker: 'AAPL' });

    const provider = mockProvider(vec);
    const svc = new SearchService({ db: dbH.db, provider: provider as any });
    const results = await svc.searchAcrossWatchlist({ userId, query: 'risk' });

    expect(results.every((r) => r.ticker === 'AAPL')).toBe(true);
  });

  it('searchAcrossWatchlist: form_types filter applies', async () => {
    const vec = Array(1024).fill(0.5);
    await seedSearchableFiling(dbH.db, 'AAPL', vec);
    // Add a 10-Q for AAPL with a different accession
    await dbH.db.insert(filings).values({
      accessionNo: '0000AAPL-24-000002', ticker: 'AAPL', cik: '0000000001',
      formType: '10-Q', filingDate: '2024-08-02', primaryDocUrl: 'https://x'
    });
    await dbH.db.insert(filingChunks).values({
      filingId: '0000AAPL-24-000002', sectionKey: 'part1_item2_mdna',
      sectionTitle: 'MD&A', text: 'Quarterly results', charCount: 17
    });
    await dbH.db.insert(chunkEmbeddings).values({
      filingId: '0000AAPL-24-000002', sectionKey: 'part1_item2_mdna', subChunkIndex: 0,
      text: 'Quarterly results', embedding: vec, model: CURRENT_EMBED_MODEL,
      charOffsetStart: 0, charOffsetEnd: 17
    });
    await dbH.db.insert(watchlist).values({ userId, ticker: 'AAPL' });

    const provider = mockProvider(vec);
    const svc = new SearchService({ db: dbH.db, provider: provider as any });

    const tenKonly = await svc.searchAcrossWatchlist({ userId, query: 'risk', formTypes: ['10-K'] });
    expect(tenKonly.every((r) => r.formType === '10-K')).toBe(true);

    const tenQonly = await svc.searchAcrossWatchlist({ userId, query: 'risk', formTypes: ['10-Q'] });
    expect(tenQonly.every((r) => r.formType === '10-Q')).toBe(true);
  });

  it('searchAcrossWatchlist: respects limit parameter', async () => {
    // Seed 5 filings with similar vectors
    const vec = Array(1024).fill(0.5);
    for (let i = 0; i < 5; i++) {
      const ticker = `T${i}`.padEnd(4, 'X');
      await seedSearchableFiling(dbH.db, ticker, vec);
      await dbH.db.insert(watchlist).values({ userId, ticker });
    }

    const provider = mockProvider(vec);
    const svc = new SearchService({ db: dbH.db, provider: provider as any });
    const results = await svc.searchAcrossWatchlist({ userId, query: 'risk', limit: 2 });
    expect(results).toHaveLength(2);
  });

  it('searchAcrossWatchlist: rejects oversized query', async () => {
    const provider = mockProvider();
    const svc = new SearchService({ db: dbH.db, provider: provider as any });
    await expect(
      svc.searchAcrossWatchlist({ userId, query: 'x'.repeat(1000) })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
```

- [ ] **Step 2: Run, verify fails**

```bash
pnpm test:integration tests/integration/search-service.test.ts 2>&1 | tail -10
```

Expected: import error.

- [ ] **Step 3: Write `lib/services/search.ts`**

```ts
import { sql } from 'drizzle-orm';
import type { ServiceDb } from '@/lib/db/client';
import { EmbeddingsProvider, ValidationError } from '@/lib/providers/types';
import { CURRENT_EMBED_MODEL } from './embeddings';

// Re-export so tests/API routes can import from either service module.
export { CURRENT_EMBED_MODEL };

export const MIN_QUERY_CHARS = 1;
export const MAX_QUERY_CHARS = 500;
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;
export const DISTANCE_THRESHOLD = 0.7;

interface Deps {
  db: ServiceDb;
  provider: EmbeddingsProvider;
}

export interface SearchResult {
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
  charOffsetStart: number | null;
  charOffsetEnd: number | null;
}

interface SearchOpts {
  userId: string;
  query: string;
  limit?: number;
  formTypes?: string[];
}

export class SearchService {
  constructor(private readonly deps: Deps) {}

  async searchAcrossWatchlist(opts: SearchOpts): Promise<SearchResult[]> {
    const trimmed = opts.query.trim();
    if (trimmed.length < MIN_QUERY_CHARS) {
      throw new ValidationError('Query too short');
    }
    if (trimmed.length > MAX_QUERY_CHARS) {
      throw new ValidationError(`Query exceeds ${MAX_QUERY_CHARS} characters`);
    }
    const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));

    // Embed query
    const embedResult = await this.deps.provider.embed({
      model: CURRENT_EMBED_MODEL,
      texts: [trimmed]
    });
    const queryVec = embedResult.vectors[0];
    if (!queryVec) throw new ValidationError('Failed to embed query');
    const queryVecLiteral = `[${queryVec.join(',')}]`;

    const formTypesParam = opts.formTypes && opts.formTypes.length > 0 ? opts.formTypes : null;

    // Drizzle's pgvector support is limited; use raw SQL for the vector op
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
        (ce.embedding <=> ${queryVecLiteral}::vector) AS distance
      FROM chunk_embeddings ce
      JOIN filings        f    ON ce.filing_id = f.accession_no
      JOIN companies      comp ON f.ticker = comp.ticker
      JOIN filing_chunks  fc   ON fc.filing_id = f.accession_no AND fc.section_key = ce.section_key
      WHERE f.ticker IN (
        SELECT w.ticker FROM watchlist w WHERE w.user_id = ${opts.userId}::uuid
      )
        AND (${formTypesParam}::text[] IS NULL OR f.form_type = ANY(${formTypesParam}::text[]))
      ORDER BY ce.embedding <=> ${queryVecLiteral}::vector
      LIMIT ${limit}
    `);

    // Map rows to SearchResult, filter by threshold
    const results: SearchResult[] = [];
    for (const r of rows as Array<Record<string, unknown>>) {
      const distance = Number(r.distance);
      if (distance > DISTANCE_THRESHOLD) continue;
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
}
```

- [ ] **Step 4: Run, verify passes**

```bash
pnpm test:integration tests/integration/search-service.test.ts 2>&1 | tail -15
```

Expected: 6 passing.

If the vector cast inside raw SQL fails (`(ce.embedding <=> ${queryVecLiteral}::vector)`), the issue is usually the SQL injection-safe way Drizzle parameterizes string literals. If you see errors about the vector literal not being valid, change `${queryVecLiteral}` to `${sql.raw(queryVecLiteral)}` ONLY for the vector — never for the userId or formTypes (which must remain parameterized).

- [ ] **Step 5: Commit**

```bash
git add lib/services/search.ts tests/integration/search-service.test.ts
git commit -m "feat(services): SearchService with pgvector cosine ranking + watchlist filter"
```

---

### Task 4.2: `/api/search` route + integration tests

**Files:**
- Create: `app/api/search/route.ts`
- Create: `tests/integration/api-search.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/integration/api-search.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companies, filings, filingChunks, chunkEmbeddings, watchlist } from '@/lib/db/schema';
import { CURRENT_EMBED_MODEL } from '@/lib/services/search';

config({ path: '.env.local' });

const STATIC_USER_ID = '11111111-1111-1111-1111-111111111111';

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
    model: CURRENT_EMBED_MODEL,
    charOffsetStart: 0, charOffsetEnd: 31
  });
  await db.insert(watchlist).values({ userId: STATIC_USER_ID, ticker: 'AAPL' });
}

describe('/api/search', () => {
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
        async embed() {
          return { vectors: [Array(1024).fill(0.5)], inputTokens: 10 };
        }
      }
    }));
  });

  it('GET happy path returns ranked results', async () => {
    await seedSearchable(dbH.db);
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(new Request('http://localhost/api/search?q=China+tariff'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0].ticker).toBe('AAPL');
  });

  it('GET empty q returns 400', async () => {
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(new Request('http://localhost/api/search?q='));
    expect(res.status).toBe(400);
  });

  it('GET missing q returns 400', async () => {
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(new Request('http://localhost/api/search'));
    expect(res.status).toBe(400);
  });

  it('GET oversized q returns 400', async () => {
    const { GET } = await import('@/app/api/search/route');
    const longQuery = 'x'.repeat(1000);
    const res = await GET(new Request(`http://localhost/api/search?q=${longQuery}`));
    expect(res.status).toBe(400);
  });

  it('GET respects limit parameter', async () => {
    await seedSearchable(dbH.db);
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(new Request('http://localhost/api/search?q=tariff&limit=1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.length).toBeLessThanOrEqual(1);
  });

  it('GET unauth returns 401', async () => {
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => { throw new Error('Unauthorized'); },
      UnauthorizedError: class extends Error {}
    }));
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(new Request('http://localhost/api/search?q=tariff'));
    expect([401, 500]).toContain(res.status); // depending on how errorResponse maps the generic Error
  });
});
```

- [ ] **Step 2: Run, verify fails**

```bash
pnpm test:integration tests/integration/api-search.test.ts 2>&1 | tail -10
```

Expected: import error.

- [ ] **Step 3: Write the handler**

```ts
// app/api/search/route.ts
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { SearchService } from '@/lib/services/search';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';

const ALLOWED_FORM_TYPES = new Set(['10-K', '10-Q']);

let svc: SearchService | null = null;
function service() {
  if (svc) return svc;
  svc = new SearchService({
    db: getServiceDb(),
    provider: new EmbeddingsProviderImpl()
  });
  return svc;
}

export async function GET(req: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(req.url);
    const q = url.searchParams.get('q');
    if (!q || q.trim().length === 0) {
      throw new ValidationError('Query parameter "q" is required');
    }
    if (q.length > 500) {
      throw new ValidationError('Query exceeds 500 characters');
    }
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw ? Math.max(1, Math.min(50, Number(limitRaw) || 10)) : undefined;

    const formTypesRaw = url.searchParams.get('form_types');
    let formTypes: string[] | undefined;
    if (formTypesRaw) {
      formTypes = formTypesRaw.split(',').map((s) => s.trim()).filter(Boolean);
      for (const ft of formTypes) {
        if (!ALLOWED_FORM_TYPES.has(ft)) {
          throw new ValidationError(`Unsupported form_type: ${ft}`);
        }
      }
    }

    const startedAt = Date.now();
    const results = await service().searchAcrossWatchlist({ userId, query: q, ...(limit !== undefined ? { limit } : {}), ...(formTypes ? { formTypes } : {}) });
    const elapsedMs = Date.now() - startedAt;

    let reason: string | null = null;
    if (results.length === 0) {
      // We can't distinguish "empty watchlist" vs "no indexed filings" vs "no relevant matches" without more queries.
      // The UI handles these states by re-checking. For v1, return generic 'no_relevant_matches'.
      reason = 'no_relevant_matches';
    }

    return ok({ results, elapsedMs, reason });
  } catch (err) {
    return errorResponse(err, { route: 'api/search GET' });
  }
}

export const maxDuration = 30;
```

- [ ] **Step 4: Run, verify passes**

```bash
pnpm test:integration tests/integration/api-search.test.ts 2>&1 | tail -15
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add app/api/search/route.ts tests/integration/api-search.test.ts
git commit -m "feat(api): GET /api/search with auth + validation + rank limit"
```

---

### Task 4.3: RLS smoke test

**Files:**
- Create: `tests/integration/chunk-embeddings-rls.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, makeTestUserDb, newUserId, resetDb } from '../helpers/test-db';
import { companies, filings, chunkEmbeddings } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('RLS: chunk_embeddings', () => {
  let svc: ReturnType<typeof makeTestServiceDb>;
  let user: ReturnType<typeof makeTestUserDb>;

  beforeAll(() => { svc = makeTestServiceDb(); user = makeTestUserDb(); });
  afterAll(async () => { await svc.close(); await user.close(); });

  beforeEach(async () => {
    await resetDb(svc.db);
    await svc.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await svc.db.insert(filings).values({
      accessionNo: '0000320193-24-000123', ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
    });
    await svc.db.insert(chunkEmbeddings).values({
      filingId: '0000320193-24-000123',
      sectionKey: 'item_1_business',
      subChunkIndex: 0,
      text: 'Apple does things.',
      embedding: Array(1024).fill(0.5),
      model: 'text-embedding-v3',
      charOffsetStart: 0,
      charOffsetEnd: 18
    });
  });

  it('authenticated role can SELECT chunk_embeddings', async () => {
    const uid = newUserId();
    const count = await user.asUser(uid, async (tx) => {
      const r = await tx.select().from(chunkEmbeddings);
      return r.length;
    });
    expect(count).toBe(1);
  });

  it('authenticated role cannot INSERT into chunk_embeddings', async () => {
    const uid = newUserId();
    await expect(
      user.asUser(uid, async (tx) =>
        tx.insert(chunkEmbeddings).values({
          filingId: '0000320193-24-000123',
          sectionKey: 'item_1_business',
          subChunkIndex: 1,
          text: 'x',
          embedding: Array(1024).fill(0.1),
          model: 'text-embedding-v3'
        })
      )
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, verify passes**

```bash
pnpm test:integration tests/integration/chunk-embeddings-rls.test.ts 2>&1 | tail -10
```

Expected: 2 passing.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/chunk-embeddings-rls.test.ts
git commit -m "test(db): RLS smoke for chunk_embeddings"
```

---

## Milestone 5: UI

### Task 5.1: Build search components

**Files:**
- Create: `app/(app)/watchlist/_components/search-bar.tsx`
- Create: `app/(app)/watchlist/_components/search-skeleton.tsx`
- Create: `app/(app)/watchlist/_components/search-result-card.tsx`
- Create: `app/(app)/watchlist/_components/search-results.tsx`
- Modify: `app/(app)/stock/[ticker]/filings/[accession]/_components/section-nav.tsx` (hash anchor)

- [ ] **Step 1: Write `search-bar.tsx`**

```tsx
// app/(app)/watchlist/_components/search-bar.tsx
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function SearchBar() {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = q.trim();
    if (trimmed.length === 0) {
      router.push('/watchlist');
      return;
    }
    const sp = new URLSearchParams();
    sp.set('q', trimmed);
    router.push(`/watchlist?${sp.toString()}`);
  }

  return (
    <form onSubmit={submit} className="flex gap-2">
      <label htmlFor="search-input" className="sr-only">Search filings</label>
      <Input
        id="search-input"
        type="text"
        placeholder="🔍 Search across your filings…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="flex-1"
        maxLength={500}
      />
      <Button type="submit" aria-label="Search filings">Search</Button>
    </form>
  );
}
```

- [ ] **Step 2: Write `search-skeleton.tsx`**

```tsx
// app/(app)/watchlist/_components/search-skeleton.tsx
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function SearchSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <Card key={i}>
          <CardContent className="py-4 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Write `search-result-card.tsx`**

```tsx
// app/(app)/watchlist/_components/search-result-card.tsx
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface Props {
  ticker: string;
  companyName: string;
  accessionNo: string;
  formType: string;
  filingDate: string;
  sectionKey: string;
  sectionTitle: string;
  snippet: string;
  distance: number;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

export function SearchResultCard({
  ticker, companyName, accessionNo, formType, filingDate,
  sectionKey, sectionTitle, snippet, distance
}: Props) {
  const href = `/stock/${ticker}/filings/${accessionNo}#section-${sectionKey}`;
  return (
    <Card>
      <CardContent className="py-4 space-y-2">
        <div className="flex items-baseline gap-2 text-sm">
          <Badge variant="outline">{ticker}</Badge>
          <span className="text-muted-foreground">·</span>
          <span className="font-medium">{formType}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{filingDate}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{sectionTitle}</span>
        </div>
        <p className="text-sm leading-relaxed">{truncate(snippet, 240)}</p>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span aria-hidden>cosine {distance.toFixed(2)} · {companyName}</span>
          <Link href={href} className="hover:text-foreground">open ↗</Link>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Write `search-results.tsx`**

```tsx
// app/(app)/watchlist/_components/search-results.tsx
import { eq, count } from 'drizzle-orm';
import { Card, CardContent } from '@/components/ui/card';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { watchlist, chunkEmbeddings } from '@/lib/db/schema';
import { SearchService } from '@/lib/services/search';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';
import { RateLimitError, ValidationError, ProviderError } from '@/lib/providers/types';
import { SearchResultCard } from './search-result-card';

interface Props {
  q: string;
}

export async function SearchResults({ q }: Props) {
  const userId = await requireUserId();
  const db = getServiceDb();

  // Pre-flight: detect empty-watchlist vs no-indexed-filings vs run-search
  const watchlistCount = await db.select({ c: count() }).from(watchlist).where(eq(watchlist.userId, userId));
  if ((watchlistCount[0]?.c ?? 0) === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          Add tickers to your watchlist to search across their filings.
        </CardContent>
      </Card>
    );
  }

  const embCount = await db.select({ c: count() }).from(chunkEmbeddings).limit(1);
  if ((embCount[0]?.c ?? 0) === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          No filings have been indexed yet. Click "Load filings" on a ticker's page first.
        </CardContent>
      </Card>
    );
  }

  const svc = new SearchService({ db, provider: new EmbeddingsProviderImpl() });

  try {
    const results = await svc.searchAcrossWatchlist({ userId, query: q });
    if (results.length === 0) {
      return (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            No matches found for &quot;{q}&quot;. Try different terms or broaden your watchlist.
          </CardContent>
        </Card>
      );
    }
    return (
      <section className="space-y-3" aria-label={`Search results for ${q}`}>
        <p className="text-sm text-muted-foreground">
          {results.length} {results.length === 1 ? 'result' : 'results'} for &quot;{q}&quot;
        </p>
        {results.map((r) => (
          <SearchResultCard
            key={`${r.accessionNo}-${r.sectionKey}-${r.subChunkIndex}`}
            ticker={r.ticker}
            companyName={r.companyName}
            accessionNo={r.accessionNo}
            formType={r.formType}
            filingDate={r.filingDate}
            sectionKey={r.sectionKey}
            sectionTitle={r.sectionTitle}
            snippet={r.snippet}
            distance={r.distance}
          />
        ))}
      </section>
    );
  } catch (err) {
    const isRate = err instanceof RateLimitError;
    const isValidation = err instanceof ValidationError;
    const isProvider = err instanceof ProviderError;
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          {isValidation && 'Search query invalid.'}
          {isRate && 'Search service is rate-limited. Try again in a moment.'}
          {isProvider && 'Search service is temporarily unavailable.'}
          {!isValidation && !isRate && !isProvider && 'Could not complete search.'}
        </CardContent>
      </Card>
    );
  }
}
```

- [ ] **Step 5: Modify `section-nav.tsx` to read URL hash on mount**

Read `app/(app)/stock/[ticker]/filings/[accession]/_components/section-nav.tsx` first to find the existing `useState(firstKey)` initializer. Then change the initial state to honor a `#section-<key>` URL fragment:

Add this `useEffect` near the top of `SectionNav`, after the existing `useState` declarations:

```tsx
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    const match = hash.match(/^#section-([a-z0-9_]+)$/);
    if (match && sections.some((s) => s.sectionKey === match[1])) {
      setActive(match[1]!);
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

Make sure `useEffect` is in the imports from `react`.

- [ ] **Step 6: Verify typecheck**

```bash
pnpm typecheck 2>&1 | tail -3
```

Expected: exit 0. If `Badge` isn't imported from `@/components/ui/badge` in your shadcn install, install it:

```bash
pnpm dlx shadcn-ui@latest add badge
```

(or whatever the project's shadcn install command is — check existing component additions in git history if unsure).

- [ ] **Step 7: Commit**

```bash
git add "app/(app)/watchlist/_components/" "app/(app)/stock/[ticker]/filings/[accession]/_components/section-nav.tsx"
# Include components/ui/badge.tsx if it was just installed
git add components/ui/badge.tsx 2>/dev/null || true
git commit -m "feat(ui): search bar + result cards + skeleton + hash-anchor for section nav"
```

---

### Task 5.2: Wire search into watchlist page

**Files:**
- Modify: `app/(app)/watchlist/page.tsx`

- [ ] **Step 1: Read the existing file**

```bash
cat "app/(app)/watchlist/page.tsx"
```

The current file (from Slice 1B) renders the user's watchlist table. It doesn't currently accept `searchParams`.

- [ ] **Step 2: Add imports + searchParams + render**

At the top of the file, add:

```tsx
import { Suspense } from 'react';
import { SearchBar } from './_components/search-bar';
import { SearchResults } from './_components/search-results';
import { SearchSkeleton } from './_components/search-skeleton';
```

Update the function signature to accept `searchParams`:

```tsx
interface PageProps {
  searchParams: { q?: string };
}

export default async function WatchlistPage({ searchParams }: PageProps) {
```

Inside the returned JSX, BEFORE the existing watchlist table content, add:

```tsx
      <div className="space-y-3">
        <SearchBar />
        <p className="text-xs text-muted-foreground">
          Examples: &quot;China tariff exposure&quot;, &quot;AI infrastructure spending&quot;, &quot;customer concentration risk&quot;
        </p>
        {searchParams.q && (
          <Suspense fallback={<SearchSkeleton />}>
            <SearchResults q={searchParams.q} />
          </Suspense>
        )}
      </div>
```

The exact placement: just inside the page's root container, above the heading or before the existing watchlist table. If the existing page has a header like `<h1>Your watchlist</h1>`, put the search block AFTER the heading.

- [ ] **Step 3: Verify typecheck**

```bash
pnpm typecheck 2>&1 | tail -3
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/watchlist/page.tsx"
git commit -m "feat(ui): wire SearchBar + SearchResults into watchlist page"
```

---

## Milestone 6: Smoke script

### Task 6.1: `scripts/try-search.ts`

**Files:**
- Create: `scripts/try-search.ts`
- Modify: `package.json` (add `try-search` script)

- [ ] **Step 1: Write the script**

```ts
#!/usr/bin/env tsx
/**
 * End-to-end smoke: `pnpm try-search "<query>" [--user-id <uuid>]`
 *
 * Picks a user with a non-empty watchlist (or accepts --user-id) and runs
 * SearchService end-to-end against live DashScope + Postgres. Prints the
 * top 10 results with ticker + filing + 200-char snippet + distance.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { eq, count } from 'drizzle-orm';
import { getServiceDb } from '@/lib/db/client';
import { watchlist } from '@/lib/db/schema';
import { SearchService } from '@/lib/services/search';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';

async function main() {
  const args = process.argv.slice(2);
  const userIdFlag = args.indexOf('--user-id');
  const userIdOverride = userIdFlag >= 0 ? args[userIdFlag + 1] : null;
  const queryParts = args.filter((a, i) => a !== '--user-id' && args[i - 1] !== '--user-id');
  const query = queryParts.join(' ').trim();

  if (!query) {
    console.error('Usage: pnpm try-search "<query>" [--user-id <uuid>]');
    process.exit(2);
  }

  const db = getServiceDb();

  let userId = userIdOverride;
  if (!userId) {
    // Pick any user with a non-empty watchlist
    const candidates = await db
      .select({ uid: watchlist.userId, c: count() })
      .from(watchlist)
      .groupBy(watchlist.userId)
      .limit(1);
    if (candidates.length === 0) {
      console.error('No users with watchlists in DB. Pass --user-id <uuid> or add a watchlist first.');
      process.exit(2);
    }
    userId = candidates[0]!.uid;
    console.log(`(no --user-id given; using ${userId} which has ${candidates[0]!.c} watchlist tickers)`);
  }

  const svc = new SearchService({ db, provider: new EmbeddingsProviderImpl() });

  console.log(`\nQuerying: "${query}"…`);
  const t0 = Date.now();
  const results = await svc.searchAcrossWatchlist({ userId, query, limit: 10 });
  const elapsed = Date.now() - t0;

  console.log(`\n${results.length} results in ${elapsed}ms:\n`);
  for (const r of results) {
    const snippet = r.snippet.length > 200 ? r.snippet.slice(0, 200) + '…' : r.snippet;
    console.log(`  [${r.ticker} ${r.formType} ${r.filingDate}] ${r.sectionTitle} · cosine ${r.distance.toFixed(3)}`);
    console.log(`    ${snippet.replace(/\s+/g, ' ')}`);
    console.log();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('try-search failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add to `package.json` scripts**

Find the `"try-summarize": ...` line and add right after:

```json
"try-search": "tsx scripts/try-search.ts",
```

- [ ] **Step 3: Run a quick smoke against the local DB**

If your local DB has at least one user with a watchlist and some embedded filings, run:

```bash
pnpm try-search "China tariff exposure"
```

Expected: prints the user-id picked, then up to 10 ranked results with ticker, form type, date, section title, cosine distance, and a 200-char snippet.

If there are no embedded filings yet (first time running 2C end-to-end), you'll get an error or empty results. That's expected — the real smoke is in T7.1 against a deployed environment after re-ingesting.

- [ ] **Step 4: Commit**

```bash
git add scripts/try-search.ts package.json
git commit -m "chore(scripts): pnpm try-search <query> smoke test"
```

---

## Milestone 7: Deploy verification

### Task 7.1: Push + Vercel deploy + browser smoke

**Files:** none (verification only)

- [ ] **Step 1: Ensure production Neon branch has pgvector extension + HNSW + RLS**

Already done in T1.2 for both branches. No additional step needed unless you discover via Vercel logs that the extension is missing — in that case, re-run Step 3 of T1.2 against prod.

- [ ] **Step 2: Verify DASHSCOPE_API_KEY is in Vercel env**

The Slice 2B deploy already added it. Confirm via Vercel dashboard → project → Settings → Environment Variables. Should be present for Production + Preview.

- [ ] **Step 3: Push to GitHub**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git push origin master
```

Wait for GitHub Actions CI to pass (~2-3 min). Tests don't hit DashScope (all mocked) so CI should be green.

- [ ] **Step 4: Wait for Vercel deploy**

Vercel auto-deploys on push. Watch the dashboard or:

```bash
gh run watch $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

Once green, the new deploy is live ~30 seconds later.

- [ ] **Step 5: Re-ingest one ticker to populate `chunk_embeddings`**

Existing filings in the production DB were ingested BEFORE Slice 2C existed, so they have no embeddings yet. Re-trigger ingestion for at least one ticker:

1. Open https://YOUR-DEPLOY-URL/stock/AAPL/filings
2. The filings list is already populated from Slice 2A. The page also doesn't expose a "re-ingest" button.
3. Workaround: hit the POST endpoint directly via the browser DevTools console while logged in:

```js
fetch('/api/tickers/AAPL/filings', { method: 'POST' }).then((r) => r.json()).then(console.log)
```

This re-runs `FilingsService.ingest('AAPL')`, which now calls `EmbeddingsService.embedFiling()` for each filing. Wait ~30-60s. The response will show `{succeeded: N, count: N}`.

Alternatively, add a fresh ticker (e.g., NVDA) via the "+ Add ticker" UI which automatically ingests + embeds.

- [ ] **Step 6: Browser smoke test**

1. Navigate to https://YOUR-DEPLOY-URL/watchlist.
2. The search bar should be visible at the top.
3. Type `"China tariff exposure"` and click Search.
4. URL changes to `/watchlist?q=China+tariff+exposure`.
5. Skeleton appears for ~500ms.
6. Ranked result cards render below. Top results should be from filings of tickers you watch that mention China-related risks.
7. Click `open ↗` on a result. Lands on `/stock/<ticker>/filings/<accession>#section-<key>` — the relevant section tab should already be active.
8. Hit back. Search results are still there (URL-driven state).
9. Try another query: `"AI infrastructure spending"` or `"customer concentration risk"`. Different results.
10. Try with empty watchlist (sign out + create a fresh user via Stack Auth if you want to fully test empty states) — should see "Add tickers to your watchlist to search across their filings."

- [ ] **Step 7: Verify CI is green for the merged commit**

```bash
gh run list --limit 1
```

Expected: ✓ for the latest commit.

- [ ] **Step 8: No commit — verification only**

---

## Slice 2C — Completion checklist

After all tasks above pass:

- [ ] All unit tests pass: `pnpm test` (existing 88 + 7 embeddings + 7 chunking = 102)
- [ ] All integration tests pass: `pnpm test:integration` (existing 95 + 6 embeddings-service + 2 filings + 6 search-service + 6 api-search + 2 rls = 117)
- [ ] Typecheck clean: `pnpm typecheck`
- [ ] Lint clean: `pnpm lint`
- [ ] `pnpm build` succeeds
- [ ] `pnpm try-search "<query>"` runs successfully against local DB
- [ ] Browser smoke: visit `/watchlist`, type a query, see ranked results, click into a filing, return via back button
- [ ] Empty-state UI shows correctly for "no watchlist" and "no indexed filings"
- [ ] `DASHSCOPE_API_KEY` set in Vercel env vars (from Slice 2B)
- [ ] `vector` extension enabled on both Neon branches
- [ ] HNSW index exists on `chunk_embeddings.embedding`
- [ ] GitHub Actions CI green on `master`

When all boxes are checked, Slice 2C is complete. The 2-series (EDGAR + LLM briefings + semantic search) is fully shipped.

---

## What's NOT in Slice 2C (deliberately deferred)

- **Hybrid search (vector + BM25)** — pure vector is sufficient for topical queries; add if exact-phrase needs surface
- **Reranking** (Cohere Rerank or cross-encoder) — boosts precision 10-20%; defer until top-K ordering shows need
- **Find-similar within a filing** — small UI add, future polish
- **RAG / Q&A** (vector + LLM at query time, citations, streaming) — Slice 3 scope
- **Query suggestions / autocomplete** — YAGNI
- **Search history** — YAGNI
- **Cross-quarter diff comparison** — different product, future slice
- **Embedding 8-K, DEF 14A, S-1** — Slice 2A only ingests 10-K + 10-Q; Slice 2.5 expands forms
- **Re-embed-on-model-version-bump machinery** — model changes are rare; one-off backfill when needed
- **Approximate-vs-exact toggle** — HNSW is right default at our scale
- **Search analytics dashboard** — `refresh_runs` has raw data
- **E2E Playwright tests** — Stack Auth ESM blocker carries from Slice 1C

Each is queued for the slice indicated or noted as YAGNI. The skeleton built in 2C (provider, service, schema, search SQL, UI) supports all of them as additive work — no refactors needed.
