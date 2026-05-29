# Earnings Call Transcripts — Design Spec

**Date:** 2026-05-29
**Status:** Approved by user; ready for implementation plan.

## Goal

Ingest earnings call transcripts (latest 4 quarters per ticker) on first visit
to a new `/stock/[TICKER]/transcripts` tab, store them chunk-by-chunk in the
existing `chunk_embeddings` vector store, and let the existing Ask feature
search transcripts alongside 10-K/10-Q filings.

## Non-goals

- Real-time transcript delivery (Motley Fool typically posts within 24h; that's good enough).
- Cron-based bulk ingest across the universe (on-demand only for v1).
- Audio playback or speaker diarization beyond what Motley Fool already labels.
- Transcript summaries (the existing per-filing briefing pattern could extend later).
- Multi-source aggregation (Motley Fool only for v1; QuartR/YouTube deferred).
- Historical backfill beyond the latest 4 quarters.

## Architecture

```
User visits /stock/AAPL/transcripts
        │
        ▼
TranscriptsService.list(ticker, k=4)
        │
   ┌────┴───────────────────────────────────────┐
   ▼                                            ▼
1. readLocal()                            2. ensureFresh()
   transcripts WHERE ticker = $1            if (lastCheckedAt > 7d) OR (rows < k):
   ORDER BY call_date DESC LIMIT k            scrape Motley Fool list page
   (fast, ~50ms)                              → for each new URL not in DB:
                                                fetch HTML → chunk + embed →
                                                insert into transcripts +
                                                chunk_embeddings
        │                                            │
        └──────────────────┬─────────────────────────┘
                           ▼
              TranscriptListItem[] (latest K)
```

**Ask integration:**

```
POST /api/rag/stream { question, sourceScope = 'all' }
        │
        ▼
SearchService.search({ q, ticker?, sourceScope })
        │
        ├──► query 1: filings corpus
        │    SELECT 'filing' AS source, filing_id AS source_id, text, ...
        │    FROM chunk_embeddings WHERE [ticker filter]
        │    ORDER BY embedding <=> $1::vector LIMIT N
        │
        ├──► query 2: transcripts corpus
        │    SELECT 'transcript' AS source, transcript_id AS source_id, text, ...
        │    FROM transcript_chunks JOIN transcripts ON ...
        │    WHERE [ticker filter]
        │    ORDER BY embedding <=> $1::vector LIMIT N
        │
        └──► merge: combine, re-rank by distance, take top-N overall
                    (skip a corpus entirely when sourceScope scopes it out)
        ▼
RagService streams Gemini response with mixed citations
```

**Key insight:** transcripts get their own table with the same vector schema
and HNSW index. SearchService unions the two corpora at query time. No
changes to filing-chunk plumbing, no risky migration on the existing table.
Each corpus query stays under 100ms (HNSW); merging top-K from each is
in-memory and cheap.

## Source

**Motley Fool** earnings call transcripts. Reasons:

- Free, no API key, posted reliably within 24h of the actual call.
- Well-formatted: speaker labels (`Tim Cook -- Chief Executive Officer`), clear
  Prepared Remarks vs Q&A segmentation, predictable URL pattern.
- ~3,500+ tickers covered (every major US listing + most large ADRs).

**Risks (and mitigations):**

- ToS gray area. Mitigation: 2s rate-limit between requests, `User-Agent:
  EquityResearchWorkbench/1.0 (research)`, respect robots.txt.
- HTML structure can change. Mitigation: parser validates known-good selectors
  return non-empty; throws `TranscriptScrapeError` with diagnostic if they
  don't, surfacing in logs.
- Coverage gaps for small caps / new IPOs. Mitigation: `transcript_freshness`
  table records when we last checked; we don't retry within 7 days for tickers
  with no transcripts found.

Deferred sources (QuartR paid API, YouTube auto-captions) noted in
non-goals — they can layer in later behind the same `TranscriptsProvider`
interface if needed.

## Trigger

**On-demand per ticker, on first visit.** Mirrors how Filings work today.
`TranscriptsService.list(ticker)` checks `transcript_freshness.lastCheckedAt`:

- < 7 days ago → return DB rows as-is, no scrape
- ≥ 7 days ago OR no `transcript_freshness` row → scrape, ingest any new URLs,
  update `lastCheckedAt = now`

No cron job. No bulk ingest. If a user never visits a ticker's Transcripts tab,
we never scrape that ticker.

## History depth

**Latest 4 quarters** (~1 year of calls) per ticker. Smallest scope that gives
Ask useful context for "what did management say last year about X." Older
transcripts (>4 quarters back) are rarely cited in practice and inflate
ingest cost.

The scraper requests `k = 4` from Motley Fool's list page. If fewer than 4
are available (newly-public company, ADR with limited coverage), we ingest
what we have.

## Schema

### New table: `transcripts`

```ts
export const transcripts = pgTable('transcripts', {
  id: text('id').primaryKey(),                   // synth: "<ticker>-<yyyy>-Q<q>" e.g. "AAPL-2024-Q3"
  ticker: text('ticker').notNull().references(() => companies.ticker, { onDelete: 'cascade' }),
  fiscalYear: integer('fiscal_year').notNull(),
  fiscalQuarter: integer('fiscal_quarter').notNull(),  // 1..4
  callDate: date('call_date').notNull(),
  sourceUrl: text('source_url').notNull(),       // Motley Fool article URL
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  parsedAt: timestamp('parsed_at', { withTimezone: true })
}, (t) => ({
  tickerDateIdx: index('transcripts_ticker_date_idx').on(t.ticker, t.callDate)
}));
```

### New table: `transcript_freshness`

```ts
export const transcriptFreshness = pgTable('transcript_freshness', {
  ticker: text('ticker').primaryKey().references(() => companies.ticker, { onDelete: 'cascade' }),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull().defaultNow(),
  lastUrlSeen: text('last_url_seen')             // most-recent transcript URL we've seen for this ticker
});
```

**Why two tables not one?** `transcripts` has clean per-call metadata.
`transcript_freshness` tracks "have we recently checked Motley Fool for this
ticker" — different lifecycle (we check freshness for tickers that don't
have transcripts yet, too).

### New table: `transcript_chunks`

The existing `chunk_embeddings` table is hard-keyed to filings
(`PK (filing_id, section_key, sub_chunk_index)`, `filing_id NOT NULL
REFERENCES filings.accession_no`). Retrofitting `source` / `source_id`
columns there would require dropping `NOT NULL`, adding a CHECK
constraint, and migrating the PK — invasive and risky.

Instead, mirror the filing-chunk schema in a parallel table for transcripts:

```ts
export const transcriptChunks = pgTable('transcript_chunks', {
  transcriptId: text('transcript_id')
    .notNull()
    .references(() => transcripts.id, { onDelete: 'cascade' }),
  sectionIndex: integer('section_index').notNull(),       // sequential 0..N across turns
  sectionKind: text('section_kind').notNull(),            // 'prepared' | 'qa'
  speaker: text('speaker').notNull(),
  role: text('role'),                                     // nullable for analysts without titles
  text: text('text').notNull(),
  embedding: vector('embedding', { dimensions: 1024 }).notNull(),
  embeddedAt: timestamp('embedded_at', { withTimezone: true }).notNull().defaultNow(),
  model: text('model').notNull()
}, (t) => ({
  pk: primaryKey({ columns: [t.transcriptId, t.sectionIndex] }),
  transcriptIdx: index('transcript_chunks_transcript_idx').on(t.transcriptId),
  embeddingIdx: index('transcript_chunks_embedding_hnsw_idx')
    .using('hnsw', t.embedding.op('vector_cosine_ops'))
}));
```

Existing filing-chunk queries continue unchanged. `SearchService` is
modified to UNION the two corpora with a combined ordering (see Service
section). Each table has its own HNSW index so per-table queries are
~50ms; the merge happens in-memory on the small candidate set.

**Why this is fine for performance:** pgvector cosine search via HNSW is
sub-linear and runs in <100ms on tables up to ~1M rows. We'll never have
more than a few hundred thousand transcript chunks (4 quarters × ~3,500
tickers × ~50 turns ≈ 700K), well within the index's comfort zone.

### RLS

Same policy as `filings`: public SELECT for authenticated users, service-role
only INSERT/UPDATE. All three new tables (`transcripts`, `transcript_chunks`,
`transcript_freshness`) get identical policies.

## Scraper

### Python script: `scripts/motley_fool_fetch.py`

Two kinds, mirroring `scripts/yfinance_fetch.py` pattern:

```python
# kind=list — get N most-recent transcript URLs for a ticker
python motley_fool_fetch.py AAPL list 4
# stdout JSON: [
#   { "url": "https://...", "callDate": "2024-10-31",
#     "fiscalYear": 2024, "fiscalQuarter": 4 },
#   ...
# ]

# kind=fetch — get one transcript's structured content
python motley_fool_fetch.py <url> fetch
# stdout JSON: {
#   "sections": [
#     { "kind": "prepared", "speaker": "Tim Cook", "role": "CEO", "text": "..." },
#     { "kind": "qa",       "speaker": "John Smith", "role": "Analyst, Bernstein", "text": "..." },
#     ...
#   ]
# }
```

### Robustness

- **Rate limiting:** 2s sleep between any two Motley Fool requests
- **User-Agent:** `EquityResearchWorkbench/1.0 (research)`
- **Retry:** one retry on 429 / 5xx with 5s backoff, then fail with structured error
- **HTML structure validation:** parser asserts that known-good CSS selectors
  return non-empty results; if not, throws with the diagnostic URL so we can
  fix the selector quickly when Motley Fool changes layout
- **404 handling:** transcript not posted yet → empty list result; caller
  records `lastCheckedAt = now` to avoid re-trying for 7 days

### Vercel serverless parity

`api/fallback/motley-fool.py` — same Python script wrapped in a Vercel handler,
matching the dual-script pattern of yfinance and EDGAR. Local dev and prod
both work.

### TS wrapper: `lib/providers/transcripts.ts`

```ts
export interface TranscriptListItem {
  id: string;                          // "AAPL-2024-Q3"
  ticker: string;
  fiscalYear: number;
  fiscalQuarter: number;
  callDate: string;                    // YYYY-MM-DD
  sourceUrl: string;
}

export interface TranscriptSection {
  kind: 'prepared' | 'qa';
  speaker: string;
  role: string | null;
  text: string;
}

export interface TranscriptDocument extends TranscriptListItem {
  sections: TranscriptSection[];
}

export class TranscriptsProvider {
  constructor(opts?: { pythonBin?: string; scriptPath?: string; spawn?: typeof spawn });
  async list(ticker: string, k: number): Promise<TranscriptListItem[]>;
  async fetch(url: string): Promise<TranscriptDocument>;
}
```

Same subprocess-spawn pattern as `YFinanceProvider` (testable via the `spawn`
injection).

### Chunking

Each transcript section (speaker turn) becomes one chunk. Reasons:

- Speaker turns are natural semantic units. A single analyst question + the
  CFO's answer are coherent units. Splitting mid-answer breaks meaning.
- Average ~150 words per turn → comfortably under the 1024-d embedding window.
- Speaker + role + section kind become `chunk_metadata` (JSONB) so Ask citations
  can show `"Tim Cook (CEO) on the Q3 2024 call"` rather than just position.

Chunks land in the new `transcript_chunks` table with:
- `transcript_id` → FK back to `transcripts.id`
- `section_index` → 0..N sequential, preserving call order
- `section_kind` → `'prepared'` or `'qa'`
- `speaker` + `role` → for the citation chip
- `text` → the speaker turn
- `embedding` → Qwen text-embedding-v4 (1024-d)
- `model` → matches the existing pattern in `chunk_embeddings`

## Service + API

### `TranscriptsService` (`lib/services/transcripts.ts`)

```ts
const FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

export class TranscriptsService {
  constructor(private deps: {
    db: ServiceDb;
    provider: TranscriptsProvider;
    embeddings: EmbeddingsProvider;
  }) {}

  async list(ticker: string, k = 4): Promise<TranscriptListItem[]> {
    // 1. ensureFresh(ticker, k) — scrape if stale or insufficient rows
    // 2. SELECT FROM transcripts WHERE ticker = $1 ORDER BY call_date DESC LIMIT $2
  }

  async get(transcriptId: string): Promise<TranscriptDocument | null> {
    // 1. JOIN transcripts + chunk_embeddings WHERE source='transcript' AND source_id=$1
    // 2. reconstruct sections ordered by insert position
  }

  private async ensureFresh(ticker: string, k: number): Promise<void> {
    // 1. SELECT last_checked_at FROM transcript_freshness WHERE ticker = $1
    // 2. If row < FRESHNESS_MS old AND existing transcripts count >= k, return.
    // 3. Otherwise: provider.list(ticker, k); for each URL not in DB, ingest()
    // 4. UPSERT transcript_freshness SET last_checked_at = now, last_url_seen = <first url>
  }

  async ingest(ticker: string, item: TranscriptListItem): Promise<void> {
    // 1. provider.fetch(item.sourceUrl) → TranscriptDocument
    // 2. INSERT INTO transcripts (...) ON CONFLICT (id) DO NOTHING
    // 3. Batch-embed all section texts (Qwen, batches of 10)
    // 4. INSERT INTO transcript_chunks (transcript_id, section_index,
    //    section_kind, speaker, role, text, embedding, model)
    //    ON CONFLICT (transcript_id, section_index) DO NOTHING
    // 5. UPDATE transcripts SET parsed_at = now WHERE id = $1
  }
}
```

### API routes

- **`GET /api/tickers/[symbol]/transcripts?k=4`** — list (k default 4, max 12).
  Returns `TranscriptListItem[]`. Cache: `private, max-age=300`.
- **`GET /api/tickers/[symbol]/transcripts/[id]`** — one transcript document
  with full section content. Returns `TranscriptDocument | { error: 'not_found' }`.
  Cache: `private, max-age=3600` (transcripts don't change after ingest).

### Modify existing `SearchService`

Add `sourceScope?: 'all' | 'filings' | 'transcripts'` (default `'all'`).
Implementation:
- `sourceScope='filings'` → existing query unchanged (only `chunk_embeddings`)
- `sourceScope='transcripts'` → new query on `transcript_chunks` only
- `sourceScope='all'` → both queries run, results merged and re-ranked by
  cosine distance, top-N kept

The merge is straightforward: each subquery returns its own top-N candidates;
combine the two lists and sort by `distance ASC`. The TS return shape gains
a discriminated `source: 'filing' | 'transcript'` field with `source_id` so
downstream RAG citation rendering can pick the right chip format.

### Modify existing `/api/rag/stream`

Accept `sourceScope` body param. Plumb to `SearchService.search()`. No
response-format changes.

## UI

### Route: `app/(app)/stock/[ticker]/transcripts/page.tsx`

List view. One card per quarter, newest first:

```
Q3 2024 · Oct 31, 2024  →  [Read]
Q2 2024 · Jul 25, 2024  →  [Read]
Q1 2024 · Apr 30, 2024  →  [Read]
Q4 2023 · Feb 1, 2024   →  [Read]
```

Cold-cache: page is server-rendered; if no transcripts exist for the ticker
yet, `TranscriptsService.list()` triggers ingest. Suspense boundary shows a
skeleton list while ingest runs (~5-15s for 4 fresh transcripts; subsequent
visits ~50ms).

### Route: `app/(app)/stock/[ticker]/transcripts/[id]/page.tsx`

Single-transcript reader:

- **Header:** company name, ticker, "Q3 2024 earnings call · Oct 31, 2024",
  link to Motley Fool source
- **Section navigator** (sticky on the left): "Prepared Remarks" / "Q&A"
  with anchor links to the first turn in each section
- **Body:** chronological list of speaker turns. Left gutter holds speaker
  name + role (e.g., "Tim Cook · CEO"); right side holds the text. Q&A
  rows shaded subtly to distinguish from prepared remarks.

### Tab nav

Add `'transcripts'` to `DashboardTab` union and `TABS` array in
`app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx`. Position: between
`'filings'` and `'quality'` — filings + transcripts are both "what the
company said about itself" and belong adjacent.

### Ask integration

Modify `AskPanel`:
- Add a `Sources` dropdown above the text input: `All sources` (default) ·
  `Filings only` · `Transcripts only`
- On submit, send `sourceScope` in the request body

Modify the citation chip renderer:
- Filings cite as: `📄 10-K Item 7 (AAPL FY2024)`
- Transcripts cite as: `🎙 Q3 2024 call · Tim Cook (CEO)`

The chip metadata is derived from the existing `chunk_metadata` JSONB field
the citation system already reads — no new RAG response shape.

### Components

1. `transcripts-list.tsx` (server) — paginated card list
2. `transcript-card.tsx` (server) — one card with date + Read link
3. `transcripts-empty.tsx` (server) — empty/error states
4. `transcript-reader.tsx` (server) — single-transcript shell
5. `transcript-section-nav.tsx` (client) — sticky nav with scroll anchors
6. `transcript-turn.tsx` (server) — pure: speaker + role + text rendering
7. `source-scope-toggle.tsx` (client) — Ask panel dropdown

## Testing

### Unit tests (pure, vitest)

1. **`parseMotleyFoolList` (Python — assertion-based or fixture-based):** 6 cases
   - Standard layout with 8+ quarter listings → returns latest N
   - Single-quarter layout (newly IPO'd ticker)
   - 404 (no transcripts) → empty list
   - Malformed date → skip that entry, continue with rest
   - URL extraction from anchor tag
   - Quarter inference from page title

2. **`parseMotleyFoolTranscript`:** 8 cases
   - Prepared remarks segment extraction
   - Q&A segment extraction
   - Speaker name + role parsing
   - Multiple speakers in one turn (skip — usually a transcription artifact)
   - Operator turns (filter out — boilerplate)
   - Mid-call speaker change tracking
   - Truncated transcripts (Q&A cut off)
   - Selector validation throws on empty result

### Integration tests (test Neon branch)

3. **`TranscriptsService.list`:** 6 cases
   - Happy path: empty DB → scrape → 4 transcripts ingested → returned
   - Freshness: `lastCheckedAt < 7d` → no scraper call (mock verifies)
   - Idempotency: re-ingest same URL → no duplicate transcripts row, no duplicate transcript_chunks (ON CONFLICT (transcript_id, section_index) DO NOTHING)
   - Embedding integration: chunks land in `transcript_chunks` with correct `speaker`, `role`, `section_kind`
   - Empty result from Motley Fool: `lastCheckedAt` still updated, empty list returned
   - Scrape error: existing rows still returned, freshness not updated

4. **`SearchService.search` with `sourceScope`:** 3 cases
   - `sourceScope='all'` returns mixed `source: 'filing'` + `source: 'transcript'` rows, ordered by combined distance
   - `sourceScope='transcripts'` returns only `source: 'transcript'` rows (no query against `chunk_embeddings`)
   - `sourceScope='filings'` returns only `source: 'filing'` rows (no query against `transcript_chunks`)

### API route tests

5. **`GET /api/tickers/[symbol]/transcripts`:** 7 cases
   - 200 valid ticker
   - 400 invalid ticker format
   - 400 k > 12
   - 400 k < 1
   - 401 unauthenticated
   - Cache-Control header present
   - JSON shape matches `TranscriptListItem[]`

6. **`POST /api/rag/stream` (modified):** 2 new cases
   - `sourceScope='transcripts'` honored end-to-end
   - Invalid `sourceScope` → 400

### E2E (Playwright)

7. Authenticated user navigates to a watchlist ticker → clicks Transcripts tab →
   sees skeleton briefly → 4 transcript cards render → clicks one → reads
   section nav + speaker turns → returns to list.

## Error handling

- **Motley Fool 404 (transcript not posted yet):** log info, return what we have
  from DB, update `lastCheckedAt = now` so we don't re-try for 7 days.
- **Motley Fool 429 / 5xx:** one retry with 5s backoff, then `TranscriptScrapeError`
  with status code. Existing DB rows still returned to the caller. `lastCheckedAt`
  NOT updated so a near-future retry can recover.
- **HTML structure changed (selectors empty for known-good page):** throw
  `TranscriptScrapeError` with the source URL. Surface in logs / Sentry. Hot
  fix path: update the parser selectors and redeploy.
- **Partial transcript (Q&A truncated):** persist what we got; `transcripts.parsed_at`
  stays NULL so a later backfill script can retry the same URL.
- **Ingest fails for one transcript in a batch:** other transcripts still ingest
  (Promise.allSettled pattern). Failed transcript shows in `transcripts` table
  without chunks; UI renders "transcript content unavailable" for that quarter
  with a `[Retry]` button.
- **Concurrent ingest of same ticker:** `transcripts.id` PRIMARY KEY +
  `ON CONFLICT (id) DO NOTHING` makes the parent row idempotent.
  `transcript_chunks` PK `(transcript_id, section_index)` plus
  `ON CONFLICT (transcript_id, section_index) DO NOTHING` makes the chunk
  rows idempotent. Worst case: both runs hit the embedding API twice and
  one set of writes is dropped — wasted tokens, no data corruption.

## Out of scope for v1 (explicit)

- Real-time / cron ingest (on-demand only)
- Historical backfill beyond latest 4 quarters
- QuartR / YouTube / paid source integration
- Audio playback
- Speaker diarization beyond what Motley Fool labels
- Transcript-level LLM summaries (could mirror the filing-briefing pattern later)
- Cross-ticker transcript Ask scoping (already covered by `tickerScope` from Slice 3)
- Multilingual transcripts (Motley Fool is English-only)
