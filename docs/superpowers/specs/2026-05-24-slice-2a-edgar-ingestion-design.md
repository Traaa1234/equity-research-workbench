# Slice 2A — EDGAR Ingestion + Section Parsing Design

**Date:** 2026-05-24
**Status:** Draft — pending implementation plan
**Project root:** `C:\Users\elinw\Projects\equity-research-workbench`

## Context and scope

The Equity Research Workbench's Slice 2 spec (per the Slice 1 design doc) covers EDGAR filing ingestion plus per-filing LLM TLDRs plus eventual semantic search. That bundle hides at least six independent subsystems and is too large for a single design document, just like Slice 1 was.

Slice 2 is decomposed into three sub-phases:

- **Slice 2A (this document)** — EDGAR ingestion + section parsing. Pull 10-K and 10-Q filings from SEC EDGAR for any ticker, parse the major research sections (Business, Risk Factors, MD&A, etc.), persist to Postgres, expose via API + UI. **No LLM, no embeddings, no TLDR.** Ships a usable "read SEC filings in our app" feature.
- **Slice 2B — LLM TLDR + red-flag detection.** Anthropic Claude with prompt caching, per-section summarization, per-filing TLDR, red-flag pattern matching. UI for the summaries. The headline AI feature.
- **Slice 2C — Embeddings + semantic Q&A.** pgvector on Neon, embedding generation, hybrid search, Q&A UI with citations. Likely merges into Slice 3.

Slice 2A delivers a standalone feature (filings library + section reader) without any LLM cost or vector infrastructure. Each sub-phase ships independently.

## Goals (Slice 2A)

1. User can open `/stock/[ticker]/filings`. If filings haven't been ingested yet for this ticker, the page shows an empty state with a "Load filings from SEC" button. No auto-fetching — explicit user click.
2. Clicking the button kicks off ingestion (30-90s) with a progress UI. On completion, the page populates with a list of 10-K and 10-Q filings from the last 5 years.
3. User can click any filing → land on a reader page showing filing metadata + section navigator. Available sections vary by filing type:
   - 10-K: Business, Risk Factors, MD&A, Market Risk, Financial Statements & Notes
   - 10-Q: Financial Statements, MD&A, Risk Factor Updates (when present)
4. Clicking a section loads the cleaned plaintext content for reading.
5. Subsequent visits to the same ticker's filings page are instant (database-cached).
6. Every page enforces RLS — reference data is readable by any authenticated user, never written via user-scoped sessions.

## Non-goals (Slice 2A)

- Any LLM summarization, TLDR generation, or red-flag detection (Slice 2B).
- Any embedding generation or vector search (Slice 2C / Slice 3).
- Filing types beyond 10-K and 10-Q (8-K, DEF 14A, S-1 deferred to Slice 2.5).
- Sections beyond the 4-6 majors per filing type (full Item 10-15 of 10-K not extracted).
- Automatic / background ingestion. Only on explicit user click.
- Filing diff / "what changed vs prior period" (needs structured summaries — Slice 2B).
- CIK pre-population for all existing tickers. CIK is resolved on demand when filings are first ingested for a ticker.
- Persistence of raw filing HTML. We persist parsed sections only; raw HTML can be re-fetched from EDGAR if needed.
- Streaming progress via Server-Sent Events. Polling-based progress is sufficient for Slice 2A.
- Python parser unit tests in CI (deferred to Slice 2.5).
- Filings page Playwright E2E (the Stack Auth fixture is still blocked from Phase 1C M5).

## Architecture

The existing single Next.js 14 app gains one new external integration and one new Python serverless function. Layering and data flow follow the patterns established in Slice 1.

```
UI (RSC + client islands)
   ↓
Service layer
  └─ FilingsService                  — orchestrates ingest + reads
       ↓
Cache layer
  └─ Postgres only                   — filings are large + accessed infrequently; no Redis cache
       ↓
Provider adapters
  └─ SecEdgarProvider                — TS adapter; spawns Python locally, HTTP-calls Python serverless on Vercel
       ↓
External: SEC EDGAR                  — free, no auth, polite throttling required
```

**New external dependency:** SEC EDGAR API. Free, no API key. Requires a `User-Agent` header identifying the requester with a real contact email (e.g. `Equity Research Workbench admin@example.com`). The Fair Access policy allows up to 10 requests per second per IP; the parser self-throttles to ~5/sec as a safety margin.

**New Python serverless function:** `api/fallback/sec.py`. Same shape as `api/fallback/yfinance.py` from Phase 1C M7. Handles three operation kinds via query parameters:

- `?kind=resolve_cik&ticker=AAPL` → `{ cik: "0000320193" }`
- `?kind=index&cik=0000320193&forms=10-K,10-Q&years=5` → `{ filings: [...] }`
- `?kind=filing&accession=0000320193-24-000123` → `{ accession, sections: [...] }`

**TS adapter** uses runtime environment to choose dispatch: `VERCEL=1` → HTTP fetch to the Vercel function; otherwise → `child_process.spawn` of the local Python script. Identical decision logic to the yfinance adapter.

**Reused infrastructure (no changes):**
- `middleware.ts` — `/api/fallback` is already allowlisted from Phase 1C
- `lib/providers/types.ts` error taxonomy (`NotFoundError`, `RateLimitError`, `ProviderError`, `ValidationError`, `UnknownProviderError`)
- `lib/api/errors.ts` `errorResponse` helper
- Drizzle ORM, Neon Postgres, Stack Auth, RLS via `current_user_id()`
- `refresh_runs` observability table (reused to log per-filing parse outcomes)

**Not touched in Slice 2A:**
- Redis — filings are too large and accessed too infrequently to justify the cache layer
- Cron — no scheduled refresh; ingestion is user-initiated only
- LLM / Anthropic SDK / pgvector — all deferred to 2B/2C

## Components and module layout

```
equity-research-workbench/
├── api/
│   └── fallback/
│       └── sec.py                                  # Vercel Python serverless function (NEW)
├── app/
│   ├── (app)/stock/[ticker]/
│   │   ├── filings/
│   │   │   ├── page.tsx                            # filings list page (NEW)
│   │   │   ├── loading.tsx                         # skeleton (NEW)
│   │   │   └── [accession]/
│   │   │       ├── page.tsx                        # single-filing reader (NEW)
│   │   │       └── _components/
│   │   │           └── section-nav.tsx             # client island: section tabs + lazy text load (NEW)
│   │   └── _components/
│   │       └── filings-empty-state.tsx             # client island: "Load filings" button + progress (NEW)
│   └── api/
│       └── tickers/[symbol]/
│           └── filings/
│               ├── route.ts                        # GET list + POST trigger ingest (NEW)
│               └── [accession]/
│                   ├── route.ts                    # GET filing metadata + section list (NEW)
│                   └── sections/[sectionKey]/
│                       └── route.ts                # GET parsed section text (NEW)
├── lib/
│   ├── providers/
│   │   ├── sec-edgar.ts                            # TS adapter (NEW)
│   │   └── types.ts                                # add filing-related types (MODIFIED)
│   ├── services/
│   │   └── filings.ts                              # FilingsService (NEW)
│   └── db/
│       ├── schema.ts                               # add filings + filing_chunks tables (MODIFIED)
│       └── migrations/
│           └── 9998_rls_filings.sql                # RLS for the two new tables (NEW)
├── scripts/
│   └── sec_fetch.py                                # Python script for local dev (NEW)
└── tests/
    ├── providers/
    │   ├── sec-edgar.test.ts                       # fixture-driven unit tests (NEW)
    │   └── __fixtures__/
    │       ├── sec-cik-aapl.json                   # CIK lookup response (NEW)
    │       ├── sec-index-aapl.json                 # filings index response (NEW)
    │       └── sec-filing-aapl-10k-2024.json       # parsed filing response (NEW)
    └── integration/
        ├── filings-service.test.ts                 # service with mocked provider (NEW)
        ├── api-filings.test.ts                     # API route tests (NEW)
        └── filings-schema.test.ts                  # DB schema + RLS checks (NEW)
```

**Module responsibilities:**

| Module | Purpose | Depends on |
| --- | --- | --- |
| `api/fallback/sec.py` | Vercel Python serverless function; same handler interface as `yfinance.py` | yfinance Python function pattern |
| `scripts/sec_fetch.py` | Local-dev Python entrypoint with identical logic to the serverless version | nothing internal |
| `lib/providers/sec-edgar.ts` | TS adapter; runtime decides subprocess vs HTTP based on `VERCEL` env | provider types, env |
| `lib/services/filings.ts` | `FilingsService` — cache-aware orchestration over Postgres only; exposes `getList`, `ingest`, `getFiling`, `getSectionText` | provider, db |
| `app/api/tickers/[symbol]/filings/**` | Thin HTTP shells (auth → service → response) | service |
| `app/(app)/stock/[ticker]/filings/**` | RSC pages with client islands for the "Load" button + section navigator | service (server-side fetch) |

**Hard rule (unchanged from Slice 1):** API route handlers contain no business logic. The four-line shape is auth → parse → call service → return.

The `_components/filings-empty-state.tsx` lives under the ticker shell directory rather than under `filings/_components/` because it is the only filings-specific client island in Slice 2A and folds into the existing `_components/` cluster. If 2B adds more filings-specific client islands, the folder is the obvious place to consolidate.

## Data flow

### Flow A — User opens `/stock/AAPL/filings` for the first time

1. Browser issues `GET /stock/AAPL/filings`.
2. `middleware.ts` refreshes the Stack Auth session cookie.
3. `(app)/layout.tsx` checks for a session; redirects to `/handler/signin` if absent.
4. `stock/[ticker]/filings/page.tsx` (RSC) calls `services.filings.getList('AAPL')`.
5. `FilingsService.getList`:
   1. Selects `filings` rows for the ticker, ordered by filing date descending.
   2. If zero rows → returns `{ filings: [], needsIngest: true }`.
   3. Otherwise → returns `{ filings, needsIngest: false }`.
6. RSC renders:
   - Empty + `needsIngest=true` → `<FilingsEmptyState />` (client island) with the "Load filings from SEC" button.
   - Populated → the filings list (date, form type, period, link to EDGAR original).

Target latency: <300ms when the table is populated. The empty case is essentially instant.

### Flow B — User clicks "Load filings from SEC"

1. Browser issues `POST /api/tickers/AAPL/filings` (no body).
2. Route handler:
   1. Auth check via `requireUserId`.
   2. Validates the symbol against the existing `^[A-Z][A-Z.]{0,5}$` regex.
   3. Calls `services.filings.ingest('AAPL')`.
3. `FilingsService.ingest`:
   1. Reads the `companies` row. If `cik` is null, calls `provider.resolveCik('AAPL')` and persists the resolved CIK back into `companies`.
   2. Calls `provider.listFilings(cik, ['10-K', '10-Q'], yearsBack=5)`, which returns roughly 25 filing metadata records.
   3. Upserts each into `filings` (PK is `accession_no`, so re-running is idempotent).
   4. For each filing that hasn't been parsed (`parsed_at IS NULL`):
      1. Calls `provider.fetchFiling(accession_no)`. Python downloads the HTML and returns parsed sections as JSON.
      2. Upserts the section rows into `filing_chunks` (unique on `(filing_id, section_key)`).
      3. Updates `filings.parsed_at` to `now()`.
   5. Logs each filing's outcome (ok / failed / skipped) into `refresh_runs` with `kind='filing:<accession>'` for poor-man's observability.
4. Route handler returns `200 { count: <filings_loaded>, ms: <duration> }`.
5. Client island receives success → calls `router.refresh()` → page re-renders with the populated list.

**Progress UI:** the client island polls `GET /api/tickers/AAPL/filings` every 2 seconds during the ingest. The route handler returns the in-progress count so the UI can show "Loading filings… (X / 25)". SSE-based push is deferred to Slice 2.5.

**Failure semantics:**

- CIK resolution fails → 404 with body `{ error: "Ticker not found at SEC" }`. User cannot proceed for that ticker; option to retry is provided but unlikely to succeed.
- Index fetch fails after retries → 503 with `Retry-After: 30`. User retries with the same button.
- Per-filing parse failure → logged to `refresh_runs`, ingestion continues with the rest. Partial success surfaces in the UI count.
- If fewer than 50% of expected filings succeed → final response is 503 with `{ error, count, expected }` so the user knows something is broken.

Total target: 30-90 seconds for a fresh ingest of about 25 filings. Parsing dominates wall-clock at ~1-3 seconds per filing.

### Flow C — User clicks into a filing and reads sections

1. Browser issues `GET /stock/AAPL/filings/0000320193-24-000123`.
2. Page RSC calls `services.filings.getFiling('AAPL', '0000320193-24-000123')` which returns the filing metadata plus the list of available `(section_key, section_title, char_count)` triples — **not the section text itself**.
3. RSC renders metadata + the section navigator (a client island showing section tabs).
4. User clicks "MD&A" → client island issues `GET /api/tickers/AAPL/filings/0000320193-24-000123/sections/item_7_mdna`.
5. Route handler calls `services.filings.getSectionText(filing_id, 'item_7_mdna')` → `SELECT text FROM filing_chunks WHERE filing_id=? AND section_key=?`.
6. Returns the text. The island renders it.

Loading section text lazily on click keeps the initial filing page fast (a single 10-K's sections sum to 200-500 KB). If the user reads only one or two sections, we avoid serializing the rest.

### Persistence shape per filing

After ingesting AAPL's 2024 10-K:

- 1 row in `filings`: `(accession_no, ticker='AAPL', cik='0000320193', form_type='10-K', filing_date, period_end, primary_doc_url, fetched_at, parsed_at, source='sec_edgar')`
- About 5 rows in `filing_chunks`, one per parsed section:
  - `(filing_id, 'item_1_business', 'Business', '<text>', char_count, char_offset_start, char_offset_end)`
  - `(filing_id, 'item_1a_risk_factors', 'Risk Factors', ...)`
  - `(filing_id, 'item_7_mdna', 'MD&A', ...)`
  - `(filing_id, 'item_7a_market_risk', 'Quantitative and Qualitative Disclosures About Market Risk', ...)`
  - `(filing_id, 'item_8_financial_statements', 'Financial Statements and Notes', ...)`

A 10-Q produces about 3 rows (Part I Item 1 Financial Statements, Part I Item 2 MD&A, Part II Item 1A Risk Factor updates if present).

AAPL over 5 years: ~25 filings × 3-5 chunks = ~100-150 chunks. Estimated storage: 50-200 MB of text. Well within Neon's free tier.

## Database schema

Drizzle ORM, Postgres on Neon. Two new tables. Both are reference data — readable by any authenticated user, writable only via the `service_role` connection.

```sql
filings (
  accession_no    text primary key,                  -- '0000320193-24-000123' (SEC's globally unique ID)
  ticker          text not null references companies(ticker) on delete cascade,
  cik             text not null,                     -- SEC central index key, 10-digit zero-padded
  form_type       text not null,                     -- '10-K' | '10-Q' (Slice 2A scope)
  filing_date     date not null,                     -- when filed with SEC
  period_end      date,                              -- fiscal period covered; null for amendments
  primary_doc_url text not null,                     -- canonical link to EDGAR HTML
  fetched_at      timestamptz not null default now(),
  parsed_at       timestamptz,                       -- null until sections successfully parsed
  source          text not null default 'sec_edgar'
);
create index on filings (ticker, filing_date desc);
create index on filings (ticker, form_type, filing_date desc);

filing_chunks (
  id                bigserial primary key,
  filing_id         text not null references filings(accession_no) on delete cascade,
  section_key       text not null,                   -- 'item_1_business' | 'item_7_mdna' | ...
  section_title     text not null,                   -- 'Business' | 'Management Discussion and Analysis'
  text              text not null,                   -- cleaned plaintext (no HTML)
  char_count        integer not null,                -- length(text); pre-computed for cheap stats
  char_offset_start integer,                         -- offset in the original raw document (for future citations)
  char_offset_end   integer
);
create unique index on filing_chunks (filing_id, section_key);
create index on filing_chunks (filing_id);
```

RLS — applied via a hand-written migration `lib/db/migrations/9998_rls_filings.sql` (lower number than the Slice 1 `9999_rls_policies.sql` so it runs before any later policies):

```sql
alter table public.filings        enable row level security;
alter table public.filing_chunks  enable row level security;

create policy "auth read filings"        on public.filings        for select to authenticated using (true);
create policy "auth read filing_chunks"  on public.filing_chunks  for select to authenticated using (true);

grant select on public.filings, public.filing_chunks to authenticated;
```

No INSERT / UPDATE / DELETE policies for `authenticated` — writes happen exclusively through the `service_role` connection (BYPASSRLS) used by the ingest flow. Same pattern as `companies`, `snapshots`, etc.

**Schema choices worth flagging:**

- `accession_no` as the primary key on `filings`, not a synthetic ID. SEC's accession numbers are globally unique, immutable, and human-meaningful. Saves a join. `filing_chunks.filing_id` references it directly.
- `filing_chunks.id` is `bigserial`, not the composite `(filing_id, section_key)`. The unique index on that pair guarantees uniqueness; the synthetic PK makes it cheap for Slice 2B's `filing_summaries` to reference individual chunks if needed.
- `text` column stores plaintext, not HTML. Decision rationale: simpler downstream consumers, smaller storage, sufficient for human reading in 2A. If 2B/2C need formatted output (e.g., preserving list structure), we re-derive from raw HTML at that time.
- `char_offset_start/end` are speculative — they enable later citations like "starts at char 18,432 in the original document." Cost is 8 bytes per chunk. YAGNI vote says drop, but the bytes are cheap and the future feature is concrete.
- `parsed_at` is separate from `fetched_at`. Lets ingestion record "we know about this filing (from the index)" separately from "we successfully parsed its sections." Useful for retry semantics when parsing fails mid-batch.
- No `raw_text` or `raw_html` column. We do not persist the full document. EDGAR's URLs are stable; if we ever need the raw bytes we re-fetch.

Both migration files (`9998_rls_filings.sql` and the auto-generated Drizzle migration for the table DDL) must be applied to the **production** Neon branch AND the **test** branch manually — same two-branch dance as the Phase 1A M2 `9999_rls_policies.sql` setup.

## Error handling, rate limits, and parsing specifics

### Error taxonomy

Reuses existing classes from `lib/providers/types.ts`. No new error classes.

| Wire condition | Internal error | HTTP response |
| --- | --- | --- |
| Ticker has no CIK in EDGAR's ticker→CIK index | `NotFoundError` | 404 `{ error: "Ticker not found at SEC" }` |
| EDGAR returns 404 for a specific filing's primary document | `NotFoundError` (logged in `refresh_runs`, continue) | partial success |
| EDGAR returns 429 | `RateLimitError` → token-bucket retries | 503 + `Retry-After` if persistent |
| EDGAR returns 5xx | `ProviderError` → retries | 503 + `Retry-After` |
| Bad ticker format | `ValidationError` | 400 |
| Parser finds zero recognizable section headers in a filing | Falls back to a single `section_key='full_document'` chunk; logs warning. Not a hard failure. | success |
| Python subprocess timeout (>60s for a single filing) | `ProviderError` | 503 |

### SEC EDGAR rate limiting

SEC's Fair Access policy allows up to 10 requests per second per IP, identified via the `User-Agent` header. The parser self-throttles to ~5 requests per second using `time.sleep()` inside the Python script:

```python
MIN_INTERVAL_SECONDS = 0.21  # ~4.76 req/sec, well under SEC's 10/sec ceiling
_last_request = 0.0

def throttled_get(url):
    global _last_request
    elapsed = time.time() - _last_request
    if elapsed < MIN_INTERVAL_SECONDS:
        time.sleep(MIN_INTERVAL_SECONDS - elapsed)
    _last_request = time.time()
    return requests.get(url, headers={'User-Agent': USER_AGENT})
```

The throttle lives in Python rather than the TS adapter because the adapter spawns a single subprocess that makes all the EDGAR calls in sequence — a cross-language Redis token bucket would be over-engineered for "don't hammer one upstream."

### User-Agent requirement

SEC blocks requests without an identifying `User-Agent`. Required format from their docs: `Company Name AdminContact@example.com`. Configured via env var:

```
SEC_USER_AGENT=Equity Research Workbench admin@example.com
```

Added to `.env.local`, `.env.example`, the GitHub Actions secrets list, and Vercel environment variables. The Python script reads it from `os.environ['SEC_USER_AGENT']`.

### Parsing strategy specifics

SEC filings are notoriously inconsistent. Section header variations include:

- `Item 1A. Risk Factors`, `ITEM 1A. RISK FACTORS`, `Item 1A — Risk Factors`, `Item 1A:`
- Some sections embedded inside table-of-contents `<table>` elements (must be excluded from section detection)
- Roman vs Arabic numerals (e.g. Part II Item 7 written as `Part II, Item 7`)
- Optional sections like Item 1B (Unresolved Staff Comments) that smaller filers omit
- Idiosyncratic structures (Apple combines Business + Properties in some years)

Approach — a small lookup table of regex patterns per section, applied in order. The boundary of a section is "from this header up to the next recognized header in document order."

```python
SECTION_PATTERNS_10K = [
    ('item_1_business',             re.compile(r'^(?:item\s+|part\s+i,?\s*item\s+)?1\.?\s+(?:business|the\s+business)\b', re.I | re.M)),
    ('item_1a_risk_factors',        re.compile(r'^(?:item\s+)?1a\.?\s+risk\s+factors', re.I | re.M)),
    ('item_7_mdna',                 re.compile(r'^(?:item\s+|part\s+ii,?\s*item\s+)?7\.?\s+management.?s\s+discussion', re.I | re.M)),
    ('item_7a_market_risk',         re.compile(r'^(?:item\s+)?7a\.?\s+quantitative\s+and\s+qualitative', re.I | re.M)),
    ('item_8_financial_statements', re.compile(r'^(?:item\s+)?8\.?\s+financial\s+statements', re.I | re.M)),
]

SECTION_PATTERNS_10Q = [
    ('part1_item1_financial_statements', re.compile(r'^part\s+i\W+item\s+1\.?\s+financial\s+statements', re.I | re.M)),
    ('part1_item2_mdna',                 re.compile(r'^part\s+i\W+item\s+2\.?\s+management.?s\s+discussion', re.I | re.M)),
    ('part2_item1a_risk_factor_updates', re.compile(r'^part\s+ii\W+item\s+1a\.?\s+risk\s+factors', re.I | re.M)),
]
```

**Fallback:** if zero sections matched (filing is exotic / malformed), insert a single `section_key='full_document'` chunk containing the entire cleaned plaintext. Degraded experience beats a hard failure.

### Cleanup pipeline

```
HTML
  → BeautifulSoup parse
  → strip <script>, <style>, <head>, navigation tables (anything with class like "table-of-contents")
  → extract text from the remaining DOM
  → collapse whitespace (multiple \n → \n\n; multiple spaces → space)
  → identify section boundaries via the pattern lookup
  → for each (section_key, section_title, cleaned_text, char_offset_start, char_offset_end), store a chunk row
  → sections that come out empty (filer omitted Item 1A, for example) are not stored
```

### Cron and observability

No new cron schedule. Filings only ingest on user click.

`refresh_runs` table from Phase 1A is reused to track per-filing parse outcomes. Each ingested filing writes a row:

```
ticker     | kind                                | started_at | completed_at | ok    | source_used | error
-----------|-------------------------------------|------------|--------------|-------|-------------|--------
AAPL       | filing:0000320193-24-000123         | t0         | t1           | true  | sec_edgar   | null
AAPL       | filing:0000320193-23-000456         | t2         | t3           | false | sec_edgar   | "parse error..."
```

Queries against this table give us a poor-man's dashboard: which filings have we ingested for ticker X, when, did they parse, what errors. Admin UI is Slice 4.

### Security note on the public `/api/fallback/sec` endpoint

The Vercel Python function is exposed at `/api/fallback/sec` and is allowlisted in middleware (already done for `/api/fallback` at Phase 1C M7 to support yfinance). That means anyone on the internet could call it. Same risk profile as the yfinance fallback: the function only reads public SEC data, the cost per call is small (Vercel function execution), and rate-limiting is bounded by Vercel's platform limits. If abuse becomes a real concern, we add a Bearer token check matching the `CRON_SECRET` pattern — but for a single-user research tool this is over-engineering.

## Testing strategy

Three layers, weighted toward unit + integration.

### Unit — TS provider adapter (fixture-driven)

`tests/providers/sec-edgar.test.ts` — same pattern as `financial-datasets.test.ts`. Recorded SEC responses in `tests/providers/__fixtures__/`:

- `sec-cik-aapl.json` — CIK resolution response shape
- `sec-index-aapl.json` — filings submissions index for AAPL
- `sec-filing-aapl-10k-2024.json` — parsed sections for one filing

Test cases:

- `resolveCik('AAPL')` → `'0000320193'`
- `resolveCik('ZZZZZZ')` → throws `NotFoundError`
- `listFilings(cik, ['10-K'], 5)` → returns array of 5 filings sorted desc by date
- `fetchFiling(accession)` → returns `{ accession, sections: [...] }`
- HTTP 429 from mocked fetch → throws `RateLimitError`
- Subprocess mode tests use `fakeSpawn` from the yfinance test pattern
- HTTP mode tests use mocked `fetch`

### Unit — Python parser (deferred to Slice 2.5)

A separate Python `pytest` suite under `scripts/tests/` validates section extraction against real EDGAR filings. We don't wire this into CI for Slice 2A because installing yfinance + the SEC parsing deps adds ~1 minute to every CI run. The parser is validated for Slice 2A via the live smoke test (next).

### Smoke test (last task before shipping 2A)

`scripts/try-filings.ts <ticker>`:

1. Resolves CIK
2. Lists 10-K + 10-Q filings for the last 5 years
3. Fetches and parses each
4. Prints per-filing section counts and the first 100 characters of the MD&A section

Same shape as `pnpm try AAPL` from Slice 1. Validates the entire pipeline end-to-end against live SEC.

### Integration — service + DB

Runs against the Neon test branch via the existing `pnpm test:integration` setup.

- **`tests/integration/filings-service.test.ts`** — `FilingsService` with mocked provider:
  - `getList('AAPL')` empty → returns `{ filings: [], needsIngest: true }`
  - `getList('AAPL')` populated → returns sorted list, `needsIngest: false`
  - `ingest('AAPL')` happy path → persists filings + chunks, returns count
  - `ingest('AAPL')` with provider partial-failure → still returns count of successes, logs failures in `refresh_runs`
  - `getSectionText(filing_id, section_key)` returns text; missing section → null
- **`tests/integration/api-filings.test.ts`** — route handlers calling through the service:
  - `GET /api/tickers/AAPL/filings` empty → 200 with `{ filings: [], needsIngest: true }`
  - `POST /api/tickers/AAPL/filings` → triggers ingest, returns count
  - `GET /api/tickers/AAPL/filings/[accession]` → returns metadata + section list
  - `GET /api/tickers/AAPL/filings/[accession]/sections/[sectionKey]` → returns text
  - Invalid ticker format → 400
  - Invalid accession format → 400
  - Unauthenticated request → 401
- **`tests/integration/filings-schema.test.ts`** — RLS smoke test for `filings` and `filing_chunks`:
  - Authenticated user can SELECT
  - Authenticated user cannot INSERT, UPDATE, or DELETE
  - service_role bypasses RLS for ingest writes

### End-to-end — defer

No Playwright tests in Slice 2A. The Stack Auth fixture is still blocked from Phase 1C M5 (the `@stackframe/stack` ESM packaging issue); building filings E2E on top of a broken fixture is not productive. The smoke test covers end-to-end correctness from the script side. Browser-level E2E for filings UI is Slice 2.5 polish (likely paired with the Strategy B browser-driven signup fixture).

### CI

The existing `.github/workflows/ci.yml` workflow picks up new tests automatically via `pnpm test` and `pnpm test:integration`. Python parser tests are deferred to Slice 2.5.

### Explicitly not tested in Slice 2A

- Visual regression on the filings UI (functional-first; no visual contract committed yet)
- Long-tail filing edge cases (S-1 with weird structure, foreign filer amendments, etc.) — handle when encountered
- Concurrent ingest collision — handled at the database layer via `INSERT … ON CONFLICT DO UPDATE`; no test needed
- Stress test for many-filings ingestion — single-user app; not relevant

## Success criteria

Slice 2A is complete when:

1. A new user can navigate to `/stock/AAPL/filings`, see the empty state, click "Load filings from SEC", and within 30-90 seconds see at least 5 filings populated (1× 10-K, 4× 10-Q for the last 12 months minimum).
2. Clicking a filing renders metadata + section navigator. Clicking each section loads its plaintext content.
3. The same flow works for any user-added ticker (Tesla, NVIDIA, JD, etc.) — CIK resolution happens automatically.
4. All Slice 2A integration tests pass green on the Neon test branch.
5. The smoke test `pnpm try-filings AAPL` succeeds end-to-end against live SEC.
6. CI is green on `main` with the new tests.
7. RLS prevents user A from writing to `filings` or `filing_chunks` (verified via integration test).
8. Vercel deploy is live, the new Python function is registered, and the live URL `/api/fallback/sec?kind=resolve_cik&ticker=AAPL` returns `{"cik": "0000320193"}`.

## Open questions deferred to implementation

- Exact retry count + backoff for SEC 5xx errors (lean toward 3 attempts, exponential 250ms → 1s → 4s, same as FD)
- Whether `char_offset_start/end` should be on the raw HTML or the cleaned plaintext (lean toward cleaned plaintext for citation simplicity in 2B/2C)
- How to handle a 10-K with no Item 1A (smaller reporting companies often skip it) — current spec says "skip the chunk row," but UI should display "Risk Factors not present in this filing" rather than just hiding the tab
- Whether to persist the `cik` to the existing `companies.cik` column or carry it only on `filings` (persist to `companies.cik` so other future features can use it without re-resolving)

These are implementation-time decisions, not design-time decisions.

## Out of scope for Slice 2A (recap)

LLM summarization, embeddings, semantic search, filing TLDR, red-flag detection, 8-K/DEF 14A/S-1 ingestion, full Item 10-15 of 10-K, background ingestion, SSE progress, custom-domain links to specific sections from external apps, browser E2E for filings UI, Python parser unit tests in CI, admin dashboard.

Each is queued for the slice indicated above.
