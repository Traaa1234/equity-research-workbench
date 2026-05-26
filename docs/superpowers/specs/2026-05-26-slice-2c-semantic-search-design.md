# Slice 2C — Semantic Search Across Watchlist Filings Design

**Status:** Approved 2026-05-26. Implementation plan to follow.

**Builds on:** Slices 1, 2A (EDGAR ingestion + section parsing), 2B (LLM briefings) — all shipped to production.

## Goal

Add a "search across your watchlist's filings" experience. User types a natural-language query at the top of the `/watchlist` page (e.g. *"China tariff exposure"*, *"AI infrastructure spending"*, *"customer concentration risk"*) and gets a ranked list of paragraph-sized hits from across every filing of every ticker in their watchlist, each with a click-through to the source. Pure vector search — no LLM at query time.

## Non-Goals

- **Hybrid search (vector + BM25)** — pure vector is sufficient for topical queries; defer if exact-phrase needs surface.
- **Reranking** (Cohere Rerank, cross-encoders) — adds latency for marginal precision gain at our scale.
- **Find-similar within a filing** — *option B* from brainstorming. Small UI add; defer to polish.
- **RAG / Q&A** (vector search → LLM synthesis with citations) — *option C* from brainstorming. Slice 3 scope.
- **Search history, autocomplete, query suggestions** — YAGNI until the bare experience reveals a need.
- **Re-embedding non-2A form types (8-K, DEF 14A, S-1)** — Slice 2A only ingests 10-K + 10-Q. Slice 2.5 expands forms; 2C just embeds whatever's already there.
- **Approximate-vs-exact search toggle** — HNSW is the right default at any scale we'll hit.
- **E2E Playwright tests** — Stack Auth ESM blocker carries from Slice 1C.

## Product

A search bar at the top of the `/watchlist` page, above the existing tickers table:

```
┌────────────────────────────────────────────────────────────┐
│  Your watchlist                                            │
│                                                            │
│  ┌──────────────────────────────────────────┐  ┌────────┐  │
│  │ 🔍 Search across your filings…           │  │ Search │  │
│  └──────────────────────────────────────────┘  └────────┘  │
│                                                            │
│  Examples: "China tariff exposure", "AI infrastructure     │
│  spending", "customer concentration risk"                  │
│                                                            │
│  ─────────── 10 results for "China tariffs" ────────────   │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ AAPL · 10-K · 2025-10-31 · Risk Factors              │  │
│  │ "In 2025, the U.S. imposed new tariffs on goods…"    │  │
│  │                              cosine 0.12 · open ↗    │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  …more cards…                                              │
│                                                            │
│  ─────────── Your tickers ───────────                      │
│  (existing watchlist table unchanged)                      │
└────────────────────────────────────────────────────────────┘
```

URL-driven: typing a query navigates to `/watchlist?q=<query>` so the search is shareable, back-button friendly, and rendered server-side (no client fetch waterfall, no flash).

## Architecture

```
At ingest time (Slice 2A + new 2C hook):
─────────────────────────────────────────
  POST /api/tickers/AAPL/filings (existing)
    ↓
  FilingsService.ingest()                  (existing, modified)
    ├─→ parse SEC sections → filing_chunks (existing)
    └─→ EmbeddingsService.embedFiling()    (NEW)
            ↓
        getAllSectionTexts(filingId)
            ↓
        subChunk() — split each section into ~500-token windows
            ↓
        batch into groups of 25 → DashScope /embeddings
            ↓
        INSERT into chunk_embeddings (ON CONFLICT DO NOTHING)


At search time:
─────────────────────────────────────────
  Browser /watchlist?q=China+tariffs
    ↓
  Server component reads searchParams.q
    ↓
  <Suspense fallback={<SearchSkeleton/>}>
    <SearchResults q={q} />
  </Suspense>
       ↓
    SearchService.searchAcrossWatchlist({userId, query, limit, formTypes})
       ↓
    1. EmbeddingsProvider.embed({texts: [query]})   ← single API call
       ↓
    2. SQL: SELECT ... FROM chunk_embeddings
            JOIN filings, companies, filing_chunks
            WHERE filing.ticker IN (user's watchlist)
            ORDER BY embedding <=> $queryVec  ← HNSW index
            LIMIT 10
       ↓
    3. Return SearchResult[]
       ↓
    Render ranked-card list → click-through to /stock/<ticker>/filings/<accession>
```

End-to-end latency: ~500ms cold (embedding API dominates), ~250ms warm.

## Schema

### New table: `chunk_embeddings`

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
    // HNSW index added separately via raw SQL — Drizzle doesn't have first-class HNSW syntax yet
  })
);
```

The `vector` column type comes from a Drizzle custom column (see "Drizzle integration" below).

### pgvector extension + HNSW index

One-time setup, applied via `_apply.ts` script to both Neon branches (NOT `drizzle-kit push --force`):

```sql
create extension if not exists vector;

create index if not exists chunk_embeddings_hnsw
  on chunk_embeddings
  using hnsw (embedding vector_cosine_ops);
```

HNSW with cosine distance is the production-standard combo for text embeddings. Cosine matches how DashScope's model was trained; HNSW gives sub-50ms top-k retrieval at our scale (we have 100× headroom before it matters).

### RLS migration: `9996_rls_chunk_embeddings.sql`

Same pattern as `filing_chunks` and `filing_summaries` — read-only for `authenticated`. The chunk text and vectors are reference data; the user-scoping happens in the application layer via watchlist subquery, not in RLS.

```sql
alter table public.chunk_embeddings enable row level security;

drop policy if exists "auth read chunk_embeddings" on public.chunk_embeddings;
create policy "auth read chunk_embeddings"
  on public.chunk_embeddings for select to authenticated using (true);

grant select on public.chunk_embeddings to authenticated;
```

The `9996` prefix sequences before `9997_rls_filing_summaries.sql`, `9998_rls_filings.sql`, `9999_rls_policies.sql`.

### Drizzle integration: custom `vector` column

Drizzle's `pg-core` doesn't ship a `vector` type. We add a 6-line custom column helper in `lib/db/schema.ts` (or a small `lib/db/vector-column.ts` if we want it isolated):

```ts
import { customType } from 'drizzle-orm/pg-core';

export const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1024})`;
  },
  toDriver(value) {
    return JSON.stringify(value); // pgvector accepts JSON array literal: '[0.1,0.2,...]'
  },
  fromDriver(raw) {
    return JSON.parse(raw) as number[];
  }
});
```

This lets us write `embedding: vector('embedding', { dimensions: 1024 }).notNull()` in the schema like any other column. TypeScript treats it as `number[]` everywhere.

### Footprint check

- 1024 floats × 4 bytes = **4 KB per vector**
- ~100 sub-chunks per filing × 5 filings per ticker × 10 tickers = **5,000 vectors = ~20 MB**
- HNSW index roughly doubles storage = **~40 MB total**

Easily within Neon's free tier (3 GB) with 75× headroom.

## Provider — `lib/providers/embeddings.ts`

```ts
export interface EmbeddingsProvider {
  embed(opts: {
    model: string;
    texts: string[];
  }): Promise<{
    vectors: number[][];   // one per input text, all 1024-dim
    inputTokens: number;
  }>;
}

export class EmbeddingsProviderImpl implements EmbeddingsProvider {
  constructor(opts?: {
    apiKey?: string;       // default: process.env.DASHSCOPE_API_KEY
    baseUrl?: string;      // default: dashscope-intl.aliyuncs.com/compatible-mode/v1
    timeoutMs?: number;    // default: 30_000
    fetch?: typeof fetch;  // injected for tests
  });
}
```

- Uses the existing `openai` npm package (installed in Slice 2B). Calls `client.embeddings.create({ model, input: texts })`.
- Reuses the same `DASHSCOPE_API_KEY` env var as Qwen.
- Single batch method (no per-text mode). DashScope caps at 25 texts per call — exposed batch size is the caller's responsibility (`EmbeddingsService` handles batching).
- Same error mapping as `QwenProvider`: 429 → `RateLimitError`, 5xx → `ProviderError`, 4xx → `ValidationError`, empty response → `UnknownProviderError`.
- `maxRetries: 0` on the OpenAI client (same setting as Qwen — avoids long test runtimes; production retries handled at a higher layer if needed).

## Sub-chunking — `lib/services/chunking.ts`

Pure function, no DB, no network:

```ts
export function subChunk(text: string, opts?: {
  targetTokens?: number;    // default 500
  overlapTokens?: number;   // default 50
}): Array<{
  text: string;
  charOffsetStart: number;
  charOffsetEnd: number;
}>;
```

**Algorithm:**

1. Tokenize input with `@dqbd/tiktoken` (cl100k_base encoding — close enough to DashScope's tokenizer for chunking; absolute counts don't need to be exact).
2. Greedy walk: take `targetTokens` tokens → emit a chunk → step back `overlapTokens` → repeat.
3. Snap chunk boundaries to nearest paragraph break (double newline) if one exists within 50 characters of the chosen boundary — keeps sentences intact.
4. Return text + character offsets back into the original section.

**Properties:**

- Pure function → trivially unit-testable.
- Deterministic → same input always produces same chunks (important for idempotent re-embed).
- ~500 tokens is the empirical sweet spot for SEC filings (prose-heavy, paragraph-structured).

**Defensive truncation:** if any chunk would exceed 7,500 tokens (shouldn't happen at target 500, but defensive against pathological inputs), hard-truncate at the token boundary. Log a `logger.warn`.

## Service — `lib/services/embeddings.ts`

```ts
export const CURRENT_EMBED_MODEL = 'text-embedding-v3';
const BATCH_SIZE = 25;

export class EmbeddingsService {
  constructor(deps: {
    db: ServiceDb;
    provider: EmbeddingsProvider;
    filingsService: FilingsService;
  });

  async embedFiling(filingId: string): Promise<{
    filingId: string;
    count: number;       // total sub-chunks persisted
    durationMs: number;
  }>;
}
```

**`embedFiling(filingId)` logic:**

1. Check `chunk_embeddings` for existing rows where `filing_id = $1` AND `model = CURRENT_EMBED_MODEL`. If `count > 0`, return `{count: 0, durationMs: 0}` immediately (cache hit).
2. Fetch sections via `filingsService.getAllSectionTexts(filingId)`. If empty, return `{count: 0, durationMs: 0}` (nothing to embed, not an error).
3. For each section, call `subChunk(section.text)`. Flatten across sections, tagging each window with `(sectionKey, subChunkIndex)`.
4. Batch the resulting array in groups of `BATCH_SIZE`. For each batch, call `provider.embed({ model: CURRENT_EMBED_MODEL, texts: batch })`.
5. Insert all rows into `chunk_embeddings` via `.onConflictDoNothing()` — idempotent on PK `(filing_id, section_key, sub_chunk_index)`.
6. Write a single `refresh_runs` row (`kind = 'embed:<accession>'`, `sourceUsed = 'dashscope_embed'`, `ok = true` on success / `false` with error message on failure).
7. Return summary.

### Wire into `FilingsService.ingest`

Slice 2A's `FilingsService.ingest` already loops over filings, parses sections, persists chunks, writes `refresh_runs`. We add one call at the end of the per-filing try-block:

```ts
try {
  // existing: fetch, parse, persist chunks, update parsedAt, log refresh_runs ok=true
  await this.deps.embeddingsService.embedFiling(filing.accessionNo);
} catch (err) {
  // existing catch: log refresh_runs ok=false, continue
}
```

If `embedFiling` throws, the per-filing catch already logs the failure and continues to the next filing — embedding failure never blocks ingestion. Filings stay readable; just not searchable until re-embedded.

To avoid circular import (`FilingsService` → `EmbeddingsService` → `FilingsService`), `EmbeddingsService` is constructed lazily and passed in via the existing `Deps` injection pattern.

## Search service — `lib/services/search.ts`

```ts
export const MIN_QUERY_CHARS = 1;
export const MAX_QUERY_CHARS = 500;
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;
export const DISTANCE_THRESHOLD = 0.7;  // results with cosine distance > this filtered out

export class SearchService {
  constructor(deps: {
    db: ServiceDb;
    provider: EmbeddingsProvider;
  });

  async searchAcrossWatchlist(opts: {
    userId: string;
    query: string;
    limit?: number;          // default 10
    formTypes?: string[];    // optional filter
  }): Promise<SearchResult[]>;
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
  snippet: string;          // the matched ~500-token text
  distance: number;         // cosine distance, lower = closer
  charOffsetStart: number | null;
  charOffsetEnd: number | null;
}
```

**`searchAcrossWatchlist` logic:**

1. Validate `query.length` is in `[MIN_QUERY_CHARS, MAX_QUERY_CHARS]`. Throw `ValidationError` otherwise.
2. Validate `limit` is in `[1, MAX_LIMIT]`. Default to `DEFAULT_LIMIT`.
3. Embed the query as one vector: `provider.embed({ model: CURRENT_EMBED_MODEL, texts: [query.trim()] })`.
4. Run the ranking SQL (see below).
5. Filter results by `DISTANCE_THRESHOLD` (drop noisy hits).
6. Map to `SearchResult[]`.

**Ranking SQL** (Drizzle-built; conceptual SQL shown):

```sql
SELECT
  c.ticker,
  comp.name        AS company_name,
  f.accession_no,
  f.form_type,
  f.filing_date,
  ce.section_key,
  fc.section_title,
  ce.sub_chunk_index,
  ce.text          AS snippet,
  ce.char_offset_start,
  ce.char_offset_end,
  (ce.embedding <=> $queryVec) AS distance
FROM chunk_embeddings ce
JOIN filings        f    ON ce.filing_id = f.accession_no
JOIN companies      comp ON f.ticker = comp.ticker
JOIN filing_chunks  fc   ON fc.filing_id = f.accession_no AND fc.section_key = ce.section_key
WHERE f.ticker IN (
  SELECT w.ticker FROM watchlist w WHERE w.user_id = $userId
)
  AND ($formTypes::text[] IS NULL OR f.form_type = ANY($formTypes))
ORDER BY ce.embedding <=> $queryVec
LIMIT $limit;
```

Notes:

- `<=>` is pgvector's cosine-distance operator. Range `[0, 2]`; typical hits land at `0.1–0.4`.
- `ORDER BY ... LIMIT k` is the form that triggers HNSW index usage (planner falls back to exact scan if you change to `WHERE ... < threshold`, so we apply the threshold post-query in application code).
- Watchlist subquery is the **application-layer security boundary**. RLS handles "can authenticated users read at all" at the DB layer (they can — chunk_embeddings is reference data); this WHERE clause enforces "but only filings of YOUR watched tickers."
- `form_type` filter is no-op when `$formTypes` is `NULL`.

**Expected latency:**

| Watchlist size | Vectors searched | Latency (DB only) | End-to-end (with embed API) |
|---|---|---|---|
| 5 tickers | ~2,500 | ~10 ms | ~400 ms |
| 25 tickers | ~12,500 | ~20 ms | ~450 ms |
| 100 tickers | ~50,000 | ~35 ms | ~500 ms |

DashScope's embedding API call (~300 ms) dominates the wall time, not the DB.

## API route — `/api/search`

```ts
// app/api/search/route.ts

GET /api/search?q=<query>&limit=10&form_types=10-K,10-Q
```

- Auth: `requireUserId()` → passes into service.
- Validation: `q` length in `[1, 500]`, `limit` in `[1, 50]`, `form_types` is a comma-separated subset of `['10-K', '10-Q']`.
- Returns:
  ```json
  {
    "results": SearchResult[],
    "elapsedMs": 412,
    "reason": null | "empty_watchlist" | "no_indexed_filings" | "no_relevant_matches"
  }
  ```
- Errors:
  - 400 — invalid params
  - 401 — unauth
  - 502 — provider failure
  - 503 — provider rate-limit (with `Retry-After`)
- `maxDuration = 30` (generous; real responses are sub-second).

**Why GET (not POST):** queries are idempotent, bookmarkable, and the URL holds the state for shareability.

## UI

### New files

- `app/(app)/watchlist/_components/search-bar.tsx` — `'use client'`. Controlled input + submit button. On submit, navigates to `/watchlist?q=<query>`.
- `app/(app)/watchlist/_components/search-results.tsx` — async server component. Reads `q` prop, calls `SearchService` directly server-side, renders ranked cards.
- `app/(app)/watchlist/_components/search-skeleton.tsx` — pure CSS skeleton for Suspense fallback (3 placeholder cards).
- `app/(app)/watchlist/_components/search-result-card.tsx` — single card component. Ticker badge, form/date/section line, 200-char snippet (with "show more" expansion), `open ↗` link to source filing.

### Modified file

- `app/(app)/watchlist/page.tsx` — accept `searchParams: { q?: string; limit?: string; form_types?: string }`. When `q` is present and non-empty, render `<Suspense><SearchResults q={q} .../></Suspense>` above the existing watchlist table.

### Empty / no-results / error states

| Condition | UI |
|---|---|
| No `q` param | Don't render results section at all |
| `q` present, empty watchlist | "Add tickers to your watchlist to search across their filings." |
| `q` present, no embedded chunks for any watchlist filing | "No filings have been indexed yet. Click 'Load filings' on a ticker's page first." |
| Query returns 0 results above threshold | "No matches found for '<q>'. Try different terms or broaden your watchlist." |
| Provider rate-limit (503) | "Search rate-limited. Try again in a moment." + retry button |
| Other provider error | "Search temporarily unavailable." + retry button |

### Click-through

Each result card links to the existing filing reader from Slice 2A:

```
/stock/<ticker>/filings/<accession>#section-<sectionKey>
```

The `#section-<key>` URL fragment is a small enhancement to Slice 2A's `SectionNav` client island (~5-line addition): on mount, read `window.location.hash` and set the active tab if it matches a section key. No requirement to scroll to character offset — section-level navigation is sufficient.

### Snippet rendering

- Default: first 200 characters of the matched chunk + `…`.
- Expand: click reveals full chunk text (in-card accordion; no overlay).
- Highlighting: bold whole-word matches of query terms (cheap regex, cosmetic only — does not affect ranking).

## Error Handling

Three failure surfaces. Behavior summary:

| Surface | Failure | Response | Persisted? |
|---|---|---|---|
| **Ingest-time embed** | `DASHSCOPE_API_KEY` missing | `EmbeddingsService` throws `ProviderError`. Caught per-filing in `FilingsService.ingest`. Logged to `refresh_runs` ok=false. Ingestion continues. | No rows in `chunk_embeddings`. Filing readable but unsearchable until next "Load filings". |
| **Ingest-time embed** | DashScope 429 | Same as above — per-filing failure, logged, continue. | No |
| **Ingest-time embed** | Partial batch failure | Successful batches persist via `ON CONFLICT DO NOTHING`. Re-run fills gaps. | Partial |
| **Search-time embed** | DashScope 429 | API returns 503 with `Retry-After`. UI shows retry. | N/A |
| **Search-time embed** | Timeout | API returns 502. UI shows generic error. | N/A |
| **Search SQL** | pgvector extension missing | Returns 500. Operator misconfiguration. | N/A |
| **Search SQL** | Empty watchlist | Returns 200 + `reason: 'empty_watchlist'`. | N/A |
| **Search SQL** | No embedded filings | Returns 200 + `reason: 'no_indexed_filings'`. | N/A |
| **Search SQL** | All results above threshold | Returns 200 + `reason: 'no_relevant_matches'`. | N/A |

**Critical invariant: no `chunk_embeddings` row is written until DashScope returns a valid vector for it.** Failed calls leave nothing behind. Same "no-row-on-failure" invariant as Slice 2B's summaries.

**`refresh_runs` integration:** every embedding attempt writes a row (`kind = 'embed:<accession>'`, `sourceUsed = 'dashscope_embed'`). Search-time embedding failures are NOT logged (would create write noise; the API response already surfaces the error to the user).

## Testing

| Layer | Test cases | Count |
|---|---|---|
| **EmbeddingsProvider unit** (mock fetch) | constructor missing key · happy path single batch · happy path multi-batch · 429 → RateLimitError · 500 → ProviderError · 401 → ValidationError · empty response → UnknownProviderError | 7 |
| **subChunk() pure-function unit** | empty input · single-paragraph (no split) · multi-paragraph (split at boundary) · oversized single sentence (forced mid-sentence) · overlap math · char offsets accurate · exact-token-count edge | 7 |
| **EmbeddingsService integration** (mock provider, real test DB) | cache hit skips API · cache miss embeds + persists · re-embed on model change · partial-write recovery · no-chunks filing → count 0 · refresh_runs ok=true and ok=false rows | 6 |
| **SearchService integration** | empty watchlist · valid query ranked results · form-type filter · limit respected · threshold filter · ranking order correct | 6 |
| **/api/search route** | unauth → 401 · empty q → 400 · oversized q → 400 · happy path · respects limit + form_types · 502 on provider failure | 6 |
| **RLS smoke** for chunk_embeddings | authenticated SELECT works · authenticated INSERT blocked | 2 |
| **Total new** | | **34** |

Cumulative project-wide after Slice 2C: **102 unit + 115 integration = 217 tests** (existing 88 + 14 new unit; existing 95 + 20 new integration).

**Manual smoke script: `scripts/try-search.ts`**

```
pnpm try-search "China tariff exposure" [--user-id <id>]
```

Picks an arbitrary user from the DB (or accepts `--user-id`), runs the query end-to-end against live DashScope + Postgres, prints top 10 results with ticker + filing date + 200-char snippet + cosine distance. Used to spot-check retrieval quality after first deploy.

**Why mock the provider for everything except the smoke script:** real embedding API calls in CI = flaky + cost money + non-deterministic. The mock returns a fixed vector list; we verify service logic, not model quality (manual spot-checks for that).

**No E2E tests** — Stack Auth ESM blocker carries from Slice 1C.

## Vercel Deploy

- No new env vars (reuses `DASHSCOPE_API_KEY` from Slice 2B).
- `vector` extension must be enabled on both Neon branches before deploy. Done via the `_apply.ts` script pattern in T1.
- HNSW index creation: same pattern, applied separately from the table creation.
- No new cron jobs.
- No new Python serverless functions (provider is pure TypeScript via OpenAI SDK).
- `maxDuration = 30` on the `/api/search` route.
- Cold-start: first search after a fresh deploy may take an extra ~500 ms while the OpenAI SDK initializes — acceptable.

## What's NOT in Slice 2C (recap, with reasons)

- **Hybrid search (vector + BM25)** — pure vector is sufficient for topical queries; add if exact-phrase needs surface.
- **Reranking** (Cohere Rerank or cross-encoder) — boosts precision 10-20% but adds latency + cost; defer until top-K ordering is shown to need help.
- **Find-similar within a filing** — small UI add; defer to polish.
- **RAG / Q&A** — vector search + LLM at query time + citations + streaming. Slice 3 scope.
- **Query suggestions / autocomplete** — YAGNI.
- **Search history** — YAGNI.
- **Cross-quarter diff comparison** — different product. Future slice.
- **Embedding 8-K, DEF 14A, S-1** — Slice 2A only ingests 10-K + 10-Q. Forms expansion comes via Slice 2.5; 2C just embeds whatever's present.
- **Re-embed-on-model-version-bump machinery** — model changes are rare. When they happen, run a one-off backfill script. No in-app machinery needed.
- **Approximate-vs-exact toggle** — HNSW is the right default at any scale we'll hit.
- **Search analytics dashboard** — `refresh_runs` has the raw data. Build a UI when reading SQL becomes painful.
- **E2E Playwright tests** — Stack Auth ESM blocker carries from Slice 1C.

## Implementation Order

The plan that follows will execute in this order, each step committing independently:

1. **Schema + pgvector extension + HNSW index + RLS** — `chunk_embeddings` on both Neon branches.
2. **`EmbeddingsProvider`** — adapter + 7 unit tests.
3. **`subChunk()` pure function** — chunking utility + 7 unit tests.
4. **`EmbeddingsService`** — service + 6 integration tests.
5. **Wire into `FilingsService.ingest`** — auto-embed during ingestion; verify existing tests still pass.
6. **`SearchService`** — service + 6 integration tests.
7. **`/api/search` route** — handler + 6 integration tests + 2 RLS smoke tests.
8. **UI** — search bar, results component, page wiring, hash-anchor enhancement to Slice 2A's `SectionNav`.
9. **Smoke script** — `pnpm try-search` + spot-check retrieval quality.
10. **Push + Vercel deploy + browser smoke** — verify search works end-to-end on production.
