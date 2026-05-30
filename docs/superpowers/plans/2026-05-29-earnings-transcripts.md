# Earnings Transcripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/stock/[TICKER]/transcripts` tab that ingests the latest 4 quarters of Motley Fool earnings call transcripts on first visit, stores them in a parallel `transcript_chunks` vector table, and lets the existing Ask feature search transcripts alongside filings via a `sourceScope` toggle.

**Architecture:** Python subprocess scraper (mirrors yfinance_fetch.py) → TranscriptsProvider TS wrapper → TranscriptsService orchestrates list/get/ingest with 7-day freshness check → chunks land in new `transcript_chunks` table (same vector schema + HNSW index as filing chunks) → SearchService unions filing + transcript corpora when `sourceScope='all'`.

**Tech Stack:** Next.js 14 App Router + TypeScript strict, Drizzle ORM + Neon Postgres + pgvector HNSW, BeautifulSoup4 + Python requests for scraping, Stack Auth, vitest, Playwright.

**Spec source:** `docs/superpowers/specs/2026-05-29-earnings-transcripts-design.md`

**Deviations from spec:** None planned. The parallel-table approach (vs. extending `chunk_embeddings`) is in the spec.

---

## File Structure

**Create (28 files):**

Schema + migrations:
- `lib/db/migrations/00XX_transcripts.sql` (drizzle-kit generated)
- `lib/db/migrations/9989_rls_transcripts.sql`

Python:
- `scripts/motley_fool_fetch.py`
- `api/fallback/motley_fool.py` (Vercel wrapper)
- `tests/scripts/motley_fool_fetch_test.py` (pytest, parser fixtures)

TS provider:
- `lib/providers/transcripts.ts`
- `tests/providers/transcripts.test.ts`

Service:
- `lib/services/transcripts.ts`
- `tests/integration/transcripts-service.test.ts`

API routes:
- `app/api/tickers/[symbol]/transcripts/route.ts`
- `app/api/tickers/[symbol]/transcripts/[id]/route.ts`
- `tests/integration/api-tickers-transcripts.test.ts`

UI:
- `app/(app)/stock/[ticker]/transcripts/page.tsx`
- `app/(app)/stock/[ticker]/transcripts/[id]/page.tsx`
- `app/(app)/stock/[ticker]/transcripts/_components/transcripts-list.tsx`
- `app/(app)/stock/[ticker]/transcripts/_components/transcript-card.tsx`
- `app/(app)/stock/[ticker]/transcripts/_components/transcripts-empty.tsx`
- `app/(app)/stock/[ticker]/transcripts/_components/transcripts-skeleton.tsx`
- `app/(app)/stock/[ticker]/transcripts/_components/transcript-reader.tsx`
- `app/(app)/stock/[ticker]/transcripts/_components/transcript-section-nav.tsx`
- `app/(app)/stock/[ticker]/transcripts/_components/transcript-turn.tsx`

E2E + smoke:
- `tests/e2e/transcripts.spec.ts`
- `scripts/try-transcripts.ts`

Test fixtures:
- `tests/fixtures/motley-fool-list-aapl.html`
- `tests/fixtures/motley-fool-transcript-aapl-2024-q3.html`

**Modify (6 files):**
- `lib/db/schema.ts` — add `transcripts`, `transcriptChunks`, `transcriptFreshness` tables
- `lib/providers/types.ts` — add `TranscriptListItem`, `TranscriptSection`, `TranscriptDocument` interfaces
- `lib/services/search.ts` — add `sourceScope` param + union path
- `tests/integration/search-service.test.ts` — 3 new sourceScope test cases
- `app/api/rag/stream/route.ts` — pass through `sourceScope` from body
- `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx` — add `'transcripts'` to union and TABS array
- `app/(app)/_components/ask-panel.tsx` (or wherever the AskPanel source-scope dropdown belongs)

---

## Task 1: Schema + types + drizzle migration

**Files:**
- Modify: `lib/db/schema.ts`
- Modify: `lib/providers/types.ts`
- Create: `lib/db/migrations/00XX_transcripts.sql` (via drizzle-kit)
- Test: `tests/integration/transcripts-schema.test.ts`

- [ ] **Step 1: Add Drizzle schemas to `lib/db/schema.ts`**

Append at the bottom of the file (after the existing `companiesUniverse` export):

```ts
export const transcripts = pgTable(
  'transcripts',
  {
    id: text('id').primaryKey(),                          // synth: "<TICKER>-<YYYY>-Q<Q>", e.g. "AAPL-2024-Q3"
    ticker: text('ticker').notNull().references(() => companies.ticker, { onDelete: 'cascade' }),
    fiscalYear: integer('fiscal_year').notNull(),
    fiscalQuarter: integer('fiscal_quarter').notNull(),   // 1..4
    callDate: date('call_date').notNull(),
    sourceUrl: text('source_url').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    parsedAt: timestamp('parsed_at', { withTimezone: true })
  },
  (t) => ({
    tickerDateIdx: index('transcripts_ticker_date_idx').on(t.ticker, t.callDate)
  })
);

export const transcriptChunks = pgTable(
  'transcript_chunks',
  {
    transcriptId: text('transcript_id')
      .notNull()
      .references(() => transcripts.id, { onDelete: 'cascade' }),
    sectionIndex: integer('section_index').notNull(),     // 0..N sequential
    sectionKind: text('section_kind').notNull(),          // 'prepared' | 'qa'
    speaker: text('speaker').notNull(),
    role: text('role'),                                   // nullable
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: 1024 }).notNull(),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }).notNull().defaultNow(),
    model: text('model').notNull()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.transcriptId, t.sectionIndex] }),
    transcriptIdx: index('transcript_chunks_transcript_idx').on(t.transcriptId),
    embeddingIdx: index('transcript_chunks_embedding_hnsw_idx')
      .using('hnsw', t.embedding.op('vector_cosine_ops'))
  })
);

export const transcriptFreshness = pgTable('transcript_freshness', {
  ticker: text('ticker').primaryKey().references(() => companies.ticker, { onDelete: 'cascade' }),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull().defaultNow(),
  lastUrlSeen: text('last_url_seen')
});
```

- [ ] **Step 2: Add types to `lib/providers/types.ts`**

Append at the end of the file:

```ts
// ---- Earnings transcripts ----

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
```

- [ ] **Step 3: Generate the migration**

Run:

```bash
pnpm db:generate
```

Expected: a new `lib/db/migrations/00XX_<random_name>.sql` file appears. Inspect it to confirm:
- `CREATE TABLE transcripts ...`
- `CREATE TABLE transcript_chunks ...`
- `CREATE TABLE transcript_freshness ...`
- `CREATE INDEX transcripts_ticker_date_idx ...`
- `CREATE INDEX transcript_chunks_transcript_idx ...`
- `CREATE INDEX transcript_chunks_embedding_hnsw_idx USING hnsw ...`

If the HNSW index is missing or malformed, edit the SQL file by hand to ensure:

```sql
CREATE INDEX transcript_chunks_embedding_hnsw_idx
  ON transcript_chunks
  USING hnsw (embedding vector_cosine_ops);
```

- [ ] **Step 4: Apply the migration to the test branch**

```bash
DATABASE_URL=$DATABASE_URL_TEST_SERVICE_ROLE pnpm db:migrate
```

Expected: migration runs cleanly. Verify by inspecting the test branch:

```bash
psql $DATABASE_URL_TEST_SERVICE_ROLE -c "\d transcripts"
psql $DATABASE_URL_TEST_SERVICE_ROLE -c "\d transcript_chunks"
psql $DATABASE_URL_TEST_SERVICE_ROLE -c "\d transcript_freshness"
```

Each `\d` should list the columns + indexes as defined.

- [ ] **Step 5: Apply to production branch**

```bash
DATABASE_URL=$DATABASE_URL_SERVICE_ROLE pnpm db:migrate
```

Same verification.

- [ ] **Step 6: Write a schema smoke test**

Create `tests/integration/transcripts-schema.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { transcripts, transcriptChunks, transcriptFreshness, companies } from '@/lib/db/schema';

config({ path: '.env.local' });

function vec(): number[] {
  const v = new Array(1024).fill(0);
  v[0] = 1;
  return v;
}

describe('transcripts schema', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await dbH.db.execute(sql`TRUNCATE TABLE transcripts, transcript_chunks, transcript_freshness, companies RESTART IDENTITY CASCADE`);
  });

  it('inserts a transcript + chunks and reads them back', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    await dbH.db.insert(transcripts).values({
      id: 'AAPL-2024-Q3',
      ticker: 'AAPL',
      fiscalYear: 2024,
      fiscalQuarter: 3,
      callDate: '2024-10-31',
      sourceUrl: 'https://example.com/aapl-q3-2024'
    });
    await dbH.db.insert(transcriptChunks).values({
      transcriptId: 'AAPL-2024-Q3',
      sectionIndex: 0,
      sectionKind: 'prepared',
      speaker: 'Tim Cook',
      role: 'CEO',
      text: 'Thanks for joining us today.',
      embedding: vec(),
      model: 'text-embedding-v4'
    });
    const rows = await dbH.db.select().from(transcripts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('AAPL-2024-Q3');
    const chunks = await dbH.db.select().from(transcriptChunks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.speaker).toBe('Tim Cook');
  });

  it('cascade-deletes chunks when transcript is dropped', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    await dbH.db.insert(transcripts).values({
      id: 'AAPL-2024-Q3', ticker: 'AAPL', fiscalYear: 2024, fiscalQuarter: 3,
      callDate: '2024-10-31', sourceUrl: 'https://example.com/x'
    });
    await dbH.db.insert(transcriptChunks).values({
      transcriptId: 'AAPL-2024-Q3', sectionIndex: 0, sectionKind: 'prepared',
      speaker: 'X', role: null, text: 'x', embedding: vec(), model: 'text-embedding-v4'
    });
    await dbH.db.delete(transcripts).where(sql`id = 'AAPL-2024-Q3'`);
    const chunks = await dbH.db.select().from(transcriptChunks);
    expect(chunks).toHaveLength(0);
  });

  it('upserts freshness rows', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    await dbH.db.insert(transcriptFreshness).values({ ticker: 'AAPL', lastUrlSeen: 'https://x' });
    const rows = await dbH.db.select().from(transcriptFreshness);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastUrlSeen).toBe('https://x');
  });
});
```

- [ ] **Step 7: Run the schema test**

```bash
pnpm test:integration tests/integration/transcripts-schema.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 8: Commit**

```bash
git add lib/db/schema.ts lib/db/migrations/00*_transcripts.sql lib/providers/types.ts tests/integration/transcripts-schema.test.ts
git commit -m "$(cat <<'EOF'
feat(transcripts): schema for transcripts + transcript_chunks + transcript_freshness

Three new tables for the earnings call transcripts slice. transcripts
holds per-call metadata. transcript_chunks mirrors the filing-chunk
schema with the same 1024-d vector + HNSW index, kept separate from
chunk_embeddings to avoid an invasive PK migration on the filings
side. transcript_freshness tracks the 7-day re-check window per
ticker.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: RLS migration

**Files:**
- Create: `lib/db/migrations/9989_rls_transcripts.sql`
- Test: `tests/integration/transcripts-rls.test.ts`

- [ ] **Step 1: Write the RLS migration**

Create `lib/db/migrations/9989_rls_transcripts.sql`:

```sql
-- RLS for transcripts slice. Same pattern as filings/chunk_embeddings: any
-- authenticated user can SELECT, writes go through service_role (BYPASSRLS).

alter table public.transcripts enable row level security;
alter table public.transcript_chunks enable row level security;
alter table public.transcript_freshness enable row level security;

drop policy if exists "auth read transcripts" on public.transcripts;
create policy "auth read transcripts"
  on public.transcripts for select to authenticated using (true);

drop policy if exists "auth read transcript_chunks" on public.transcript_chunks;
create policy "auth read transcript_chunks"
  on public.transcript_chunks for select to authenticated using (true);

drop policy if exists "auth read transcript_freshness" on public.transcript_freshness;
create policy "auth read transcript_freshness"
  on public.transcript_freshness for select to authenticated using (true);

grant select on public.transcripts to authenticated;
grant select on public.transcript_chunks to authenticated;
grant select on public.transcript_freshness to authenticated;
```

- [ ] **Step 2: Apply to test + prod branches**

```bash
psql $DATABASE_URL_TEST_SERVICE_ROLE -f lib/db/migrations/9989_rls_transcripts.sql
psql $DATABASE_URL_SERVICE_ROLE      -f lib/db/migrations/9989_rls_transcripts.sql
```

Expected: no errors.

- [ ] **Step 3: Write RLS smoke test**

Create `tests/integration/transcripts-rls.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb, makeTestUserDb, newUserId } from '../helpers/test-db';
import { transcripts, transcriptChunks, transcriptFreshness, companies } from '@/lib/db/schema';

config({ path: '.env.local' });

function vec(): number[] {
  const v = new Array(1024).fill(0);
  v[0] = 1;
  return v;
}

describe('transcripts RLS', () => {
  let svcH: ReturnType<typeof makeTestServiceDb>;
  let userH: ReturnType<typeof makeTestUserDb>;
  beforeAll(() => { svcH = makeTestServiceDb(); userH = makeTestUserDb(); });
  afterAll(async () => { await svcH.close(); await userH.close(); });
  beforeEach(async () => {
    await svcH.db.execute(sql`TRUNCATE TABLE transcripts, transcript_chunks, transcript_freshness, companies RESTART IDENTITY CASCADE`);
    await svcH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    await svcH.db.insert(transcripts).values({
      id: 'AAPL-2024-Q3', ticker: 'AAPL', fiscalYear: 2024, fiscalQuarter: 3,
      callDate: '2024-10-31', sourceUrl: 'https://x'
    });
    await svcH.db.insert(transcriptChunks).values({
      transcriptId: 'AAPL-2024-Q3', sectionIndex: 0, sectionKind: 'prepared',
      speaker: 'X', role: null, text: 'x', embedding: vec(), model: 'text-embedding-v4'
    });
  });

  it('authenticated user can SELECT transcripts', async () => {
    const userId = newUserId();
    const rows = await userH.asUser(userId, async (tx) => tx.select().from(transcripts));
    expect(rows).toHaveLength(1);
  });

  it('authenticated user can SELECT transcript_chunks', async () => {
    const userId = newUserId();
    const rows = await userH.asUser(userId, async (tx) => tx.select().from(transcriptChunks));
    expect(rows).toHaveLength(1);
  });

  it('authenticated user cannot INSERT transcripts', async () => {
    const userId = newUserId();
    await expect(
      userH.asUser(userId, async (tx) =>
        tx.insert(transcripts).values({
          id: 'AAPL-2024-Q2', ticker: 'AAPL', fiscalYear: 2024, fiscalQuarter: 2,
          callDate: '2024-07-25', sourceUrl: 'https://y'
        })
      )
    ).rejects.toThrow(/permission denied|policy/i);
  });
});
```

- [ ] **Step 4: Run the RLS test**

```bash
pnpm test:integration tests/integration/transcripts-rls.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/db/migrations/9989_rls_transcripts.sql tests/integration/transcripts-rls.test.ts
git commit -m "$(cat <<'EOF'
feat(transcripts): RLS policies + smoke test

SELECT to authenticated; service_role has BYPASSRLS and handles all
writes via TranscriptsService. Pattern mirrors filings/chunk_embeddings.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Python scraper (motley_fool_fetch.py + Vercel wrapper)

**Files:**
- Create: `scripts/motley_fool_fetch.py`
- Create: `api/fallback/motley_fool.py`
- Create: `tests/fixtures/motley-fool-list-aapl.html`
- Create: `tests/fixtures/motley-fool-transcript-aapl-2024-q3.html`

This task ships the scraper. Unit testing is done via the TS adapter in Task 4 (spawn-mock pattern, mirrors how yfinance is tested). Python integration is verified via the try-transcripts smoke script in Task 10.

- [ ] **Step 1: Capture two HTML fixtures**

Hit Motley Fool manually once to grab known-good HTML samples (don't commit URLs that change). Save:

- `tests/fixtures/motley-fool-list-aapl.html` — the AAPL transcripts list page (current snapshot at the time of writing)
- `tests/fixtures/motley-fool-transcript-aapl-2024-q3.html` — one full Q3 2024 AAPL call page

Use `curl -A "EquityResearchWorkbench/1.0" -o <fixture-path> <url>` to capture them.

- [ ] **Step 2: Write the Python scraper**

Create `scripts/motley_fool_fetch.py`:

```python
#!/usr/bin/env python3
"""
Motley Fool earnings transcript scraper. Invoked by lib/providers/transcripts.ts.

Usage:
  python motley_fool_fetch.py <ticker> list <k>        # list latest k transcripts
  python motley_fool_fetch.py <url> fetch                # fetch one transcript

Output: single JSON object on stdout.
  list  → { "items": [ { url, callDate, fiscalYear, fiscalQuarter }, ... ] }
  fetch → { "sections": [ { kind, speaker, role, text }, ... ] }
Exit 0 on success, 1 on failure with { "error": "...", "kind": "..." }.
"""
import json
import re
import sys
import time
from typing import Optional

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError as e:
    print(json.dumps({"error": f"deps missing: {e}", "kind": "Provider"}))
    sys.exit(1)


UA = "EquityResearchWorkbench/1.0 (research)"
RATE_LIMIT_SLEEP_S = 2.0
TIMEOUT_S = 15
LIST_URL_TEMPLATE = "https://www.fool.com/quote/nasdaq/{ticker}/#quote-earnings-transcripts"


def fail(msg: str, kind: str = "Unknown"):
    print(json.dumps({"error": msg, "kind": kind}))
    sys.exit(1)


def http_get(url: str) -> str:
    time.sleep(RATE_LIMIT_SLEEP_S)
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=TIMEOUT_S)
    except requests.RequestException as e:
        fail(f"network error fetching {url}: {e}", "Provider")
    if r.status_code == 404:
        return ""
    if r.status_code == 429 or r.status_code >= 500:
        # one retry with backoff
        time.sleep(5)
        r = requests.get(url, headers={"User-Agent": UA}, timeout=TIMEOUT_S)
    if r.status_code != 200:
        fail(f"http {r.status_code} from {url}", "Provider")
    return r.text


def parse_list(html: str, ticker: str) -> list[dict]:
    """Extract list of transcript URLs from a Motley Fool ticker page."""
    soup = BeautifulSoup(html, "html.parser")
    items: list[dict] = []

    # The Motley Fool transcripts list links live in anchors whose href contains
    # "earnings-call-transcript". We extract title, date, and quarter from each.
    anchors = soup.select('a[href*="earnings-call-transcript"]')
    if not anchors:
        # Empty result is valid (no transcripts yet); just return empty list.
        return []

    seen_urls: set[str] = set()
    for a in anchors:
        href = a.get("href", "")
        if not href.startswith("http"):
            href = "https://www.fool.com" + href
        if href in seen_urls:
            continue
        seen_urls.add(href)

        title = (a.get_text(strip=True) or "").strip()
        # Title example: "Apple (AAPL) Q3 2024 Earnings Call Transcript"
        m = re.search(r"Q(\d)\s*(\d{4})", title, re.IGNORECASE)
        if not m:
            continue
        fiscal_quarter = int(m.group(1))
        fiscal_year = int(m.group(2))

        # Date often lives in a sibling time element. Best-effort.
        call_date = None
        time_el = a.find_next("time")
        if time_el and time_el.get("datetime"):
            call_date = time_el["datetime"][:10]  # YYYY-MM-DD
        if not call_date:
            # Fall back to a date parsed from the URL slug e.g. /2024/11/01/
            m2 = re.search(r"/(\d{4})/(\d{2})/(\d{2})/", href)
            if m2:
                call_date = f"{m2.group(1)}-{m2.group(2)}-{m2.group(3)}"
        if not call_date:
            continue

        items.append({
            "url": href,
            "callDate": call_date,
            "fiscalYear": fiscal_year,
            "fiscalQuarter": fiscal_quarter,
        })

    return items


def parse_transcript(html: str) -> list[dict]:
    """Extract speaker-turn sections from a transcript article."""
    soup = BeautifulSoup(html, "html.parser")
    article = soup.select_one("article") or soup.select_one("div.article-body")
    if not article:
        return []

    # Motley Fool typically labels prepared remarks and Q&A as <h2> headings.
    sections: list[dict] = []
    current_kind = "prepared"
    current_speaker = None
    current_role = None
    current_text_parts: list[str] = []

    def flush():
        if current_speaker and current_text_parts:
            sections.append({
                "kind": current_kind,
                "speaker": current_speaker,
                "role": current_role,
                "text": " ".join(s.strip() for s in current_text_parts if s.strip())
            })

    for el in article.find_all(["h2", "h3", "p", "strong"]):
        text = el.get_text(strip=True)
        if not text:
            continue

        # Section heading transition
        if el.name == "h2":
            t = text.lower()
            if "question" in t and "answer" in t:
                flush()
                current_kind = "qa"
                current_speaker, current_role, current_text_parts = None, None, []
            continue

        # Speaker line typical pattern: "Tim Cook -- Chief Executive Officer"
        if " -- " in text and len(text) < 200:
            flush()
            parts = text.split(" -- ", 1)
            current_speaker = parts[0].strip()
            current_role = parts[1].strip() if len(parts) > 1 else None
            current_text_parts = []
            continue

        if current_speaker:
            current_text_parts.append(text)

    flush()
    # Filter operator-only turns (boilerplate); keep everything else
    return [s for s in sections if s["speaker"].lower() != "operator"]


def main():
    if len(sys.argv) < 3:
        fail("usage: motley_fool_fetch.py <ticker_or_url> <list|fetch> [k]", "Validation")

    arg = sys.argv[1]
    kind = sys.argv[2]

    if kind == "list":
        k = int(sys.argv[3]) if len(sys.argv) >= 4 else 4
        url = LIST_URL_TEMPLATE.format(ticker=arg.lower())
        html = http_get(url)
        if not html:
            print(json.dumps({"items": []}))
            return
        items = parse_list(html, arg.upper())[:k]
        print(json.dumps({"items": items}))
        return

    if kind == "fetch":
        html = http_get(arg)
        if not html:
            print(json.dumps({"sections": []}))
            return
        sections = parse_transcript(html)
        print(json.dumps({"sections": sections}))
        return

    fail(f"unknown kind: {kind}", "Validation")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Write the Vercel serverless wrapper**

Create `api/fallback/motley_fool.py`:

```python
"""Vercel serverless wrapper for motley_fool_fetch.py."""
from http.server import BaseHTTPRequestHandler
import json
import sys
import os
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/..")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../../scripts")

from motley_fool_fetch import parse_list, parse_transcript, http_get, LIST_URL_TEMPLATE


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        qs = parse_qs(urlparse(self.path).query)
        kind = qs.get("kind", [None])[0]
        try:
            if kind == "list":
                ticker = qs.get("ticker", [""])[0]
                k = int(qs.get("k", ["4"])[0])
                if not ticker:
                    self._send(400, {"error": "ticker required", "kind": "Validation"})
                    return
                html = http_get(LIST_URL_TEMPLATE.format(ticker=ticker.lower()))
                items = parse_list(html, ticker.upper())[:k] if html else []
                self._send(200, {"items": items})
                return

            if kind == "fetch":
                url = qs.get("url", [""])[0]
                if not url:
                    self._send(400, {"error": "url required", "kind": "Validation"})
                    return
                html = http_get(url)
                sections = parse_transcript(html) if html else []
                self._send(200, {"sections": sections})
                return

            self._send(400, {"error": "kind must be list|fetch", "kind": "Validation"})
        except SystemExit:
            # parse_list / parse_transcript don't sys.exit; http_get does on failure
            self._send(500, {"error": "scraper failed", "kind": "Provider"})

    def _send(self, code: int, body: dict):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
```

- [ ] **Step 4: Smoke-run the scraper locally**

```bash
python scripts/motley_fool_fetch.py AAPL list 4
```

Expected: JSON object with `items` array of up to 4 entries, each with url + callDate + fiscalYear + fiscalQuarter.

```bash
python scripts/motley_fool_fetch.py "<first url from above>" fetch
```

Expected: JSON object with `sections` array of speaker turns.

If output looks wrong, debug parser against the fixtures captured in Step 1.

- [ ] **Step 5: Commit**

```bash
git add scripts/motley_fool_fetch.py api/fallback/motley_fool.py tests/fixtures/motley-fool-list-aapl.html tests/fixtures/motley-fool-transcript-aapl-2024-q3.html
git commit -m "$(cat <<'EOF'
feat(transcripts): Motley Fool scraper (Python) + Vercel serverless wrapper

Two kinds:
  list  — latest k transcript URLs for a ticker
  fetch — one transcript's speaker-turn sections

2s rate limit between requests, single retry on 429/5xx, BeautifulSoup
HTML parsing. Vercel wrapper provides prod parity with local subprocess
mode.

Fixtures captured for reproducible parser testing in T4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: TS provider (`TranscriptsProvider`) + unit tests

**Files:**
- Create: `lib/providers/transcripts.ts`
- Test: `tests/providers/transcripts.test.ts`

- [ ] **Step 1: Write the provider**

Create `lib/providers/transcripts.ts`:

```ts
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import type { TranscriptListItem, TranscriptDocument, TranscriptSection } from './types';
import { ProviderError, ValidationError, NotFoundError } from './types';

interface Opts {
  pythonBin?: string;
  scriptPath?: string;
  spawn?: typeof nodeSpawn;
}

interface ScriptError { error: string; kind: 'NotFound' | 'Provider' | 'Validation' | 'Unknown'; }

export class TranscriptsProvider {
  private pythonBin: string;
  private scriptPath: string;
  private spawn: typeof nodeSpawn;

  constructor(opts: Opts = {}) {
    this.pythonBin = opts.pythonBin ?? 'python';
    this.scriptPath = opts.scriptPath ?? path.join(process.cwd(), 'scripts', 'motley_fool_fetch.py');
    this.spawn = opts.spawn ?? nodeSpawn;
  }

  async list(ticker: string, k: number): Promise<TranscriptListItem[]> {
    const raw = await this.run([ticker, 'list', String(k)]);
    const parsed = JSON.parse(raw) as { items: Array<{ url: string; callDate: string; fiscalYear: number; fiscalQuarter: number }> };
    const t = ticker.toUpperCase();
    return parsed.items.map((it) => ({
      id: `${t}-${it.fiscalYear}-Q${it.fiscalQuarter}`,
      ticker: t,
      fiscalYear: it.fiscalYear,
      fiscalQuarter: it.fiscalQuarter,
      callDate: it.callDate,
      sourceUrl: it.url
    }));
  }

  async fetch(url: string): Promise<TranscriptDocument> {
    const raw = await this.run([url, 'fetch']);
    const parsed = JSON.parse(raw) as { sections: TranscriptSection[] };
    // The caller is responsible for joining with the list metadata; we return
    // the document shape with empty stubs for ticker/quarter/year/date which
    // the service overwrites before persisting.
    return {
      id: '', ticker: '', fiscalYear: 0, fiscalQuarter: 0,
      callDate: '', sourceUrl: url,
      sections: parsed.sections
    };
  }

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = this.spawn(this.pythonBin, [this.scriptPath, ...args]);
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => reject(new ProviderError(`spawn failed: ${err.message}`)));
      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        // Try to parse error JSON
        try {
          const err = JSON.parse(stdout) as ScriptError;
          if (err.kind === 'NotFound') reject(new NotFoundError(err.error));
          else if (err.kind === 'Validation') reject(new ValidationError(err.error));
          else reject(new ProviderError(err.error));
        } catch {
          reject(new ProviderError(`script exit ${code}: ${stderr || stdout || 'unknown'}`));
        }
      });
    });
  }
}
```

- [ ] **Step 2: Write provider unit tests**

Create `tests/providers/transcripts.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { TranscriptsProvider } from '@/lib/providers/transcripts';
import { NotFoundError, ProviderError, ValidationError } from '@/lib/providers/types';

function makeProvider(spawnImpl: any) {
  return new TranscriptsProvider({
    pythonBin: 'python',
    scriptPath: '/fake/motley_fool_fetch.py',
    spawn: spawnImpl
  });
}

function fakeSpawn(stdout: string, exitCode: number) {
  return () => {
    const listeners: Record<string, ((arg?: any) => void)[]> = { close: [], error: [] };
    const proc = {
      stdout: { on: (ev: string, cb: (data: Buffer) => void) => { if (ev === 'data') cb(Buffer.from(stdout)); } },
      stderr: { on: () => {} },
      on: (ev: string, cb: (arg?: any) => void) => {
        if (!listeners[ev]) listeners[ev] = [];
        listeners[ev]!.push(cb);
      }
    };
    setTimeout(() => listeners.close?.forEach((cb) => cb(exitCode)), 0);
    return proc;
  };
}

describe('TranscriptsProvider.list', () => {
  it('parses items and synthesizes the id', async () => {
    const stdout = JSON.stringify({
      items: [
        { url: 'https://www.fool.com/x', callDate: '2024-10-31', fiscalYear: 2024, fiscalQuarter: 3 },
        { url: 'https://www.fool.com/y', callDate: '2024-07-25', fiscalYear: 2024, fiscalQuarter: 2 }
      ]
    });
    const p = makeProvider(fakeSpawn(stdout, 0));
    const result = await p.list('AAPL', 4);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'AAPL-2024-Q3',
      ticker: 'AAPL',
      fiscalYear: 2024,
      fiscalQuarter: 3,
      callDate: '2024-10-31',
      sourceUrl: 'https://www.fool.com/x'
    });
  });

  it('returns empty array when scraper finds no transcripts', async () => {
    const p = makeProvider(fakeSpawn(JSON.stringify({ items: [] }), 0));
    const result = await p.list('XXXX', 4);
    expect(result).toEqual([]);
  });

  it('throws NotFoundError when scraper exits with kind=NotFound', async () => {
    const stdout = JSON.stringify({ error: 'not found', kind: 'NotFound' });
    const p = makeProvider(fakeSpawn(stdout, 1));
    await expect(p.list('AAPL', 4)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ProviderError on Provider kind', async () => {
    const stdout = JSON.stringify({ error: 'network', kind: 'Provider' });
    const p = makeProvider(fakeSpawn(stdout, 1));
    await expect(p.list('AAPL', 4)).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws ValidationError on Validation kind', async () => {
    const stdout = JSON.stringify({ error: 'bad input', kind: 'Validation' });
    const p = makeProvider(fakeSpawn(stdout, 1));
    await expect(p.list('AAPL', 4)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('TranscriptsProvider.fetch', () => {
  it('parses sections from stdout', async () => {
    const stdout = JSON.stringify({
      sections: [
        { kind: 'prepared', speaker: 'Tim Cook', role: 'CEO', text: 'Thanks for joining us.' },
        { kind: 'qa', speaker: 'John Smith', role: 'Analyst, Bernstein', text: 'Question about margins.' }
      ]
    });
    const p = makeProvider(fakeSpawn(stdout, 0));
    const doc = await p.fetch('https://www.fool.com/x');
    expect(doc.sections).toHaveLength(2);
    expect(doc.sections[0]!.speaker).toBe('Tim Cook');
    expect(doc.sections[0]!.role).toBe('CEO');
  });

  it('returns empty sections array when transcript missing', async () => {
    const p = makeProvider(fakeSpawn(JSON.stringify({ sections: [] }), 0));
    const doc = await p.fetch('https://www.fool.com/missing');
    expect(doc.sections).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the provider tests**

```bash
pnpm test tests/providers/transcripts.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/providers/transcripts.ts tests/providers/transcripts.test.ts
git commit -m "$(cat <<'EOF'
feat(transcripts): TranscriptsProvider TS adapter + 7 unit tests

Wraps the Python motley_fool_fetch.py subprocess with the same
spawn-injection pattern as YFinanceProvider so tests don't run real
Python. Synthesizes the transcript id from ticker + fiscal year +
quarter. Maps script-level error kinds to typed exceptions
(NotFound/Provider/Validation).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `TranscriptsService` + integration tests

**Files:**
- Create: `lib/services/transcripts.ts`
- Test: `tests/integration/transcripts-service.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/transcripts-service.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, transcripts, transcriptChunks, transcriptFreshness } from '@/lib/db/schema';
import { TranscriptsService } from '@/lib/services/transcripts';
import type { TranscriptsProvider } from '@/lib/providers/transcripts';
import type { EmbeddingsProvider } from '@/lib/providers/types';

config({ path: '.env.local' });

function vec(seed = 0): number[] {
  const v = new Array(1024).fill(0);
  v[seed % 1024] = 1;
  return v;
}

function mockProvider(listImpl?: any, fetchImpl?: any): TranscriptsProvider {
  return {
    list: vi.fn().mockImplementation(listImpl ?? (async () => [])),
    fetch: vi.fn().mockImplementation(fetchImpl ?? (async () => ({ sections: [] })))
  } as unknown as TranscriptsProvider;
}

function mockEmbeddings(): EmbeddingsProvider {
  return {
    embed: vi.fn().mockImplementation(async ({ texts }: { texts: string[] }) => ({
      vectors: texts.map((_, i) => vec(i)),
      inputTokens: 10
    }))
  } as unknown as EmbeddingsProvider;
}

describe('TranscriptsService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.execute(sql`TRUNCATE TABLE transcripts, transcript_chunks, transcript_freshness CASCADE`);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
  });

  it('happy path: empty DB → scrape → 4 transcripts ingested', async () => {
    const provider = mockProvider(
      async (ticker: string, k: number) => Array.from({ length: 4 }, (_, i) => ({
        id: `AAPL-2024-Q${4 - i}`, ticker: 'AAPL',
        fiscalYear: 2024, fiscalQuarter: 4 - i,
        callDate: `2024-${String(10 - i * 3).padStart(2, '0')}-31`,
        sourceUrl: `https://x/${i}`
      })),
      async (url: string) => ({
        sections: [
          { kind: 'prepared', speaker: 'Tim Cook', role: 'CEO', text: 'opening remarks ' + url },
          { kind: 'qa', speaker: 'Q1', role: 'Analyst', text: 'first question ' + url }
        ]
      })
    );
    const emb = mockEmbeddings();
    const svc = new TranscriptsService({ db: dbH.db, provider, embeddings: emb });
    const items = await svc.list('AAPL', 4);
    expect(items).toHaveLength(4);

    const tRows = await dbH.db.select().from(transcripts);
    expect(tRows).toHaveLength(4);
    const cRows = await dbH.db.select().from(transcriptChunks);
    expect(cRows).toHaveLength(8);   // 4 transcripts × 2 sections
  });

  it('freshness: lastCheckedAt < 7d → no scraper call', async () => {
    await dbH.db.insert(transcriptFreshness).values({ ticker: 'AAPL', lastUrlSeen: 'x' });
    await dbH.db.insert(transcripts).values({
      id: 'AAPL-2024-Q3', ticker: 'AAPL', fiscalYear: 2024, fiscalQuarter: 3,
      callDate: '2024-10-31', sourceUrl: 'https://x'
    });
    const provider = mockProvider();
    const svc = new TranscriptsService({ db: dbH.db, provider, embeddings: mockEmbeddings() });
    await svc.list('AAPL', 4);
    expect(provider.list).not.toHaveBeenCalled();
  });

  it('idempotency: re-ingest same URL → no duplicate rows', async () => {
    const provider = mockProvider(
      async () => [{
        id: 'AAPL-2024-Q3', ticker: 'AAPL',
        fiscalYear: 2024, fiscalQuarter: 3,
        callDate: '2024-10-31', sourceUrl: 'https://x'
      }],
      async () => ({
        sections: [{ kind: 'prepared', speaker: 'Tim Cook', role: 'CEO', text: 'hello' }]
      })
    );
    const svc = new TranscriptsService({ db: dbH.db, provider, embeddings: mockEmbeddings() });
    await svc.list('AAPL', 4);
    // Wipe freshness so the second call doesn't short-circuit
    await dbH.db.execute(sql`UPDATE transcript_freshness SET last_checked_at = now() - interval '10 days' WHERE ticker = 'AAPL'`);
    await svc.list('AAPL', 4);
    const tRows = await dbH.db.select().from(transcripts);
    expect(tRows).toHaveLength(1);
    const cRows = await dbH.db.select().from(transcriptChunks);
    expect(cRows).toHaveLength(1);
  });

  it('persists speaker, role, section_kind correctly', async () => {
    const provider = mockProvider(
      async () => [{
        id: 'AAPL-2024-Q3', ticker: 'AAPL',
        fiscalYear: 2024, fiscalQuarter: 3,
        callDate: '2024-10-31', sourceUrl: 'https://x'
      }],
      async () => ({
        sections: [
          { kind: 'prepared', speaker: 'Tim Cook', role: 'CEO', text: 'opening' },
          { kind: 'qa', speaker: 'John Smith', role: 'Analyst, Bernstein', text: 'q1' }
        ]
      })
    );
    const svc = new TranscriptsService({ db: dbH.db, provider, embeddings: mockEmbeddings() });
    await svc.list('AAPL', 4);
    const chunks = await dbH.db.select().from(transcriptChunks).orderBy(transcriptChunks.sectionIndex);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.sectionKind).toBe('prepared');
    expect(chunks[0]!.speaker).toBe('Tim Cook');
    expect(chunks[0]!.role).toBe('CEO');
    expect(chunks[1]!.sectionKind).toBe('qa');
    expect(chunks[1]!.role).toBe('Analyst, Bernstein');
  });

  it('empty result from scraper: freshness updated, empty list returned', async () => {
    const provider = mockProvider(async () => []);
    const svc = new TranscriptsService({ db: dbH.db, provider, embeddings: mockEmbeddings() });
    const items = await svc.list('AAPL', 4);
    expect(items).toEqual([]);
    const freshness = await dbH.db.select().from(transcriptFreshness);
    expect(freshness).toHaveLength(1);
    expect(freshness[0]!.ticker).toBe('AAPL');
  });

  it('scrape error: freshness NOT updated, existing rows still returned', async () => {
    await dbH.db.insert(transcripts).values({
      id: 'AAPL-2024-Q3', ticker: 'AAPL', fiscalYear: 2024, fiscalQuarter: 3,
      callDate: '2024-10-31', sourceUrl: 'https://x'
    });
    const provider = mockProvider(async () => { throw new Error('scrape failed'); });
    const svc = new TranscriptsService({ db: dbH.db, provider, embeddings: mockEmbeddings() });
    const items = await svc.list('AAPL', 4);
    expect(items).toHaveLength(1);
    const freshness = await dbH.db.select().from(transcriptFreshness);
    expect(freshness).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm test:integration tests/integration/transcripts-service.test.ts
```

Expected: FAIL with "Cannot find module '@/lib/services/transcripts'".

- [ ] **Step 3: Implement the service**

Create `lib/services/transcripts.ts`:

```ts
import { and, desc, eq, sql } from 'drizzle-orm';
import type { ServiceDb } from '@/lib/db/client';
import type { TranscriptsProvider } from '@/lib/providers/transcripts';
import type { EmbeddingsProvider, TranscriptListItem, TranscriptDocument } from '@/lib/providers/types';
import { transcripts, transcriptChunks, transcriptFreshness } from '@/lib/db/schema';
import { logger } from '@/lib/logger';

const FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;
const EMBED_BATCH = 10;
const EMBED_MODEL = 'text-embedding-v4';

interface Deps {
  db: ServiceDb;
  provider: TranscriptsProvider;
  embeddings: EmbeddingsProvider;
}

export class TranscriptsService {
  constructor(private readonly deps: Deps) {}

  async list(ticker: string, k = 4): Promise<TranscriptListItem[]> {
    const t = ticker.toUpperCase();
    await this.ensureFresh(t, k);
    const rows = await this.deps.db
      .select()
      .from(transcripts)
      .where(eq(transcripts.ticker, t))
      .orderBy(desc(transcripts.callDate))
      .limit(k);
    return rows.map((r) => ({
      id: r.id,
      ticker: r.ticker,
      fiscalYear: r.fiscalYear,
      fiscalQuarter: r.fiscalQuarter,
      callDate: r.callDate,
      sourceUrl: r.sourceUrl
    }));
  }

  async get(transcriptId: string): Promise<TranscriptDocument | null> {
    const tRows = await this.deps.db
      .select()
      .from(transcripts)
      .where(eq(transcripts.id, transcriptId))
      .limit(1);
    const t = tRows[0];
    if (!t) return null;
    const chunks = await this.deps.db
      .select()
      .from(transcriptChunks)
      .where(eq(transcriptChunks.transcriptId, transcriptId))
      .orderBy(transcriptChunks.sectionIndex);
    return {
      id: t.id,
      ticker: t.ticker,
      fiscalYear: t.fiscalYear,
      fiscalQuarter: t.fiscalQuarter,
      callDate: t.callDate,
      sourceUrl: t.sourceUrl,
      sections: chunks.map((c) => ({
        kind: c.sectionKind as 'prepared' | 'qa',
        speaker: c.speaker,
        role: c.role,
        text: c.text
      }))
    };
  }

  private async ensureFresh(ticker: string, k: number): Promise<void> {
    const freshnessRows = await this.deps.db
      .select()
      .from(transcriptFreshness)
      .where(eq(transcriptFreshness.ticker, ticker))
      .limit(1);
    const f = freshnessRows[0];
    if (f) {
      const ageMs = Date.now() - new Date(f.lastCheckedAt).getTime();
      const existing = await this.deps.db.select({ id: transcripts.id }).from(transcripts).where(eq(transcripts.ticker, ticker));
      if (ageMs < FRESHNESS_MS && existing.length >= k) return;
    }

    let items: TranscriptListItem[];
    try {
      items = await this.deps.provider.list(ticker, k);
    } catch (err) {
      logger.warn({ err: String(err), ticker }, 'transcripts.ensureFresh: scrape failed; freshness NOT updated');
      return;
    }

    // Determine which items are new (not in DB)
    const existingIds = new Set(
      (await this.deps.db.select({ id: transcripts.id }).from(transcripts).where(eq(transcripts.ticker, ticker)))
        .map((r) => r.id)
    );
    const newItems = items.filter((it) => !existingIds.has(it.id));

    for (const item of newItems) {
      try {
        await this.ingestOne(item);
      } catch (err) {
        logger.warn({ err: String(err), id: item.id }, 'transcripts.ensureFresh: ingest one failed; continuing');
      }
    }

    // Update freshness (we successfully called the scraper, even if some ingests failed)
    await this.deps.db
      .insert(transcriptFreshness)
      .values({ ticker, lastCheckedAt: new Date(), lastUrlSeen: items[0]?.sourceUrl ?? null })
      .onConflictDoUpdate({
        target: transcriptFreshness.ticker,
        set: { lastCheckedAt: new Date(), lastUrlSeen: items[0]?.sourceUrl ?? null }
      });
  }

  private async ingestOne(item: TranscriptListItem): Promise<void> {
    const doc = await this.deps.provider.fetch(item.sourceUrl);

    await this.deps.db.insert(transcripts).values({
      id: item.id,
      ticker: item.ticker,
      fiscalYear: item.fiscalYear,
      fiscalQuarter: item.fiscalQuarter,
      callDate: item.callDate,
      sourceUrl: item.sourceUrl
    }).onConflictDoNothing();

    if (doc.sections.length === 0) {
      return;   // nothing to embed
    }

    // Batch-embed
    const texts = doc.sections.map((s) => s.text);
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const result = await this.deps.embeddings.embed({ model: EMBED_MODEL, texts: batch });
      vectors.push(...result.vectors);
    }

    // Insert chunks
    const rows = doc.sections.map((s, idx) => ({
      transcriptId: item.id,
      sectionIndex: idx,
      sectionKind: s.kind,
      speaker: s.speaker,
      role: s.role,
      text: s.text,
      embedding: vectors[idx]!,
      model: EMBED_MODEL
    }));
    await this.deps.db.insert(transcriptChunks).values(rows).onConflictDoNothing();

    await this.deps.db.update(transcripts)
      .set({ parsedAt: new Date() })
      .where(eq(transcripts.id, item.id));
  }
}
```

- [ ] **Step 4: Run the test**

```bash
pnpm test:integration tests/integration/transcripts-service.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/services/transcripts.ts tests/integration/transcripts-service.test.ts
git commit -m "$(cat <<'EOF'
feat(transcripts): TranscriptsService + 6 integration tests

list() returns latest K with a 7-day freshness check (skip scrape if
lastCheckedAt < 7d AND rows >= k). Otherwise calls provider.list →
batch-fetches + embeds new transcripts in 10-at-a-time chunks → upserts.
get(id) joins transcripts + transcript_chunks for reader display.

Scrape failure leaves freshness untouched so a near-future retry can
recover. Per-transcript ingest failures don't abort the batch — one
bad URL doesn't lose the other three.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: SearchService `sourceScope` extension

**Files:**
- Modify: `lib/services/search.ts`
- Modify: `tests/integration/search-service.test.ts`

- [ ] **Step 1: Add `sourceScope` parameter to SearchService**

Open `lib/services/search.ts`. Find the `SearchOptions` type (likely near the top) and add:

```ts
export type SourceScope = 'all' | 'filings' | 'transcripts';

export interface SearchOptions {
  // ... existing fields preserved
  sourceScope?: SourceScope;
}
```

Find the existing `search()` method. Around the existing vector query, replace the body with the union-or-scope structure. The exact diff depends on the current shape; the goal is:

```ts
async search(opts: SearchOptions): Promise<SearchResult[]> {
  const scope: SourceScope = opts.sourceScope ?? 'all';
  const filingHits = scope === 'transcripts' ? [] : await this.searchFilings(opts);
  const transcriptHits = scope === 'filings' ? [] : await this.searchTranscripts(opts);
  // Merge by distance ascending, take top-K overall
  return [...filingHits, ...transcriptHits]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, opts.limit ?? 20);
}
```

Add a discriminated `source: 'filing' | 'transcript'` field to `SearchResult`. Add the new `searchTranscripts()` method that mirrors `searchFilings()` but reads from `transcript_chunks` joined with `transcripts`. Return shape per row:

```ts
{
  source: 'transcript',
  sourceId: transcript_id,
  ticker,
  text,
  metadata: { speaker, role, section_kind, fiscal_year, fiscal_quarter, call_date },
  distance,
  similarity: 1 - distance
}
```

Refactor the existing `searchFilings()` to add `source: 'filing'` discriminator on its returns. Keep all existing behavior identical for `sourceScope='filings'` (the default-equivalent path).

- [ ] **Step 2: Add 3 new test cases**

Open `tests/integration/search-service.test.ts`. Find the existing `describe('SearchService.search', ...)` block. Add seed data setup for transcript chunks if not already present. Add these tests:

```ts
  it('sourceScope=all returns mixed filing + transcript chunks ordered by distance', async () => {
    // (assumes the beforeEach already seeded both filing chunks and transcript chunks for AAPL)
    const results = await svc.search({ q: 'iphone', userId, sourceScope: 'all', limit: 10 });
    const sources = new Set(results.map((r) => r.source));
    expect(sources.has('filing')).toBe(true);
    expect(sources.has('transcript')).toBe(true);
    // Sorted ascending by distance
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.distance).toBeGreaterThanOrEqual(results[i - 1]!.distance);
    }
  });

  it('sourceScope=transcripts returns only transcript chunks', async () => {
    const results = await svc.search({ q: 'iphone', userId, sourceScope: 'transcripts', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.source === 'transcript')).toBe(true);
  });

  it('sourceScope=filings returns only filing chunks', async () => {
    const results = await svc.search({ q: 'iphone', userId, sourceScope: 'filings', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.source === 'filing')).toBe(true);
  });
```

In the same file's `beforeEach`, add transcript chunk seed:

```ts
  // Existing chunk_embeddings seed left alone; add transcript_chunks:
  await dbH.db.insert(transcripts).values({
    id: 'AAPL-2024-Q3', ticker: 'AAPL', fiscalYear: 2024, fiscalQuarter: 3,
    callDate: '2024-10-31', sourceUrl: 'https://x'
  });
  await dbH.db.insert(transcriptChunks).values([
    { transcriptId: 'AAPL-2024-Q3', sectionIndex: 0, sectionKind: 'prepared',
      speaker: 'Tim Cook', role: 'CEO', text: 'iphone demand is strong',
      embedding: vec(/* same seed as query embedding mock */), model: 'text-embedding-v4' }
  ]);
```

- [ ] **Step 3: Run the search tests**

```bash
pnpm test:integration tests/integration/search-service.test.ts
```

Expected: existing tests still pass + 3 new tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/services/search.ts tests/integration/search-service.test.ts
git commit -m "$(cat <<'EOF'
feat(search): sourceScope filter for filings vs transcripts

SearchService gains sourceScope: 'all' | 'filings' | 'transcripts'
(default 'all'). When 'all', the service queries both corpora and
merges by cosine distance. When scoped, only the requested table is
queried. Results carry a discriminated source field so RAG citations
can render the right chip.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: API routes + `/api/rag/stream` sourceScope passthrough

**Files:**
- Create: `app/api/tickers/[symbol]/transcripts/route.ts`
- Create: `app/api/tickers/[symbol]/transcripts/[id]/route.ts`
- Modify: `app/api/rag/stream/route.ts`
- Test: `tests/integration/api-tickers-transcripts.test.ts`

- [ ] **Step 1: Write the failing route tests**

Create `tests/integration/api-tickers-transcripts.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, transcripts, transcriptChunks } from '@/lib/db/schema';

config({ path: '.env.local' });

vi.mock('@/lib/auth/current-user', () => ({ requireUserId: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ getServiceDb: vi.fn() }));

import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { GET as listGET } from '@/app/api/tickers/[symbol]/transcripts/route';
import { GET as itemGET } from '@/app/api/tickers/[symbol]/transcripts/[id]/route';

function vec(): number[] {
  const v = new Array(1024).fill(0);
  v[0] = 1;
  return v;
}

describe('GET /api/tickers/[symbol]/transcripts', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => {
    dbH = makeTestServiceDb();
    vi.mocked(getServiceDb).mockReturnValue(dbH.db as any);
    vi.mocked(requireUserId).mockResolvedValue('00000000-0000-0000-0000-000000000001');
  });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.execute(sql`TRUNCATE TABLE transcripts, transcript_chunks, transcript_freshness CASCADE`);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    await dbH.db.insert(transcripts).values([
      { id: 'AAPL-2024-Q3', ticker: 'AAPL', fiscalYear: 2024, fiscalQuarter: 3, callDate: '2024-10-31', sourceUrl: 'https://x' },
      { id: 'AAPL-2024-Q2', ticker: 'AAPL', fiscalYear: 2024, fiscalQuarter: 2, callDate: '2024-07-25', sourceUrl: 'https://y' }
    ]);
  });

  it('returns 200 with list ordered newest-first', async () => {
    const req = new Request('http://localhost/api/tickers/AAPL/transcripts');
    const res = await listGET(req, { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toHaveLength(2);
    expect(json.items[0].id).toBe('AAPL-2024-Q3');
  });

  it('honors k parameter', async () => {
    const req = new Request('http://localhost/api/tickers/AAPL/transcripts?k=1');
    const res = await listGET(req, { params: { symbol: 'AAPL' } });
    const json = await res.json();
    expect(json.items).toHaveLength(1);
  });

  it('400 on invalid ticker', async () => {
    const req = new Request('http://localhost/api/tickers/bad-x/transcripts');
    const res = await listGET(req, { params: { symbol: 'bad-x' } });
    expect(res.status).toBe(400);
  });

  it('400 when k > 12', async () => {
    const req = new Request('http://localhost/api/tickers/AAPL/transcripts?k=99');
    const res = await listGET(req, { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(400);
  });

  it('401 when not authenticated', async () => {
    vi.mocked(requireUserId).mockRejectedValueOnce(new Error('no auth'));
    const req = new Request('http://localhost/api/tickers/AAPL/transcripts');
    const res = await listGET(req, { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(401);
  });

  it('cache-control header present', async () => {
    const req = new Request('http://localhost/api/tickers/AAPL/transcripts');
    const res = await listGET(req, { params: { symbol: 'AAPL' } });
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
  });
});

describe('GET /api/tickers/[symbol]/transcripts/[id]', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => {
    dbH = makeTestServiceDb();
    vi.mocked(getServiceDb).mockReturnValue(dbH.db as any);
    vi.mocked(requireUserId).mockResolvedValue('00000000-0000-0000-0000-000000000001');
  });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.execute(sql`TRUNCATE TABLE transcripts, transcript_chunks, transcript_freshness CASCADE`);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    await dbH.db.insert(transcripts).values({
      id: 'AAPL-2024-Q3', ticker: 'AAPL', fiscalYear: 2024, fiscalQuarter: 3,
      callDate: '2024-10-31', sourceUrl: 'https://x'
    });
    await dbH.db.insert(transcriptChunks).values({
      transcriptId: 'AAPL-2024-Q3', sectionIndex: 0, sectionKind: 'prepared',
      speaker: 'Tim Cook', role: 'CEO', text: 'opening', embedding: vec(), model: 'text-embedding-v4'
    });
  });

  it('returns 200 with document', async () => {
    const req = new Request('http://localhost/api/tickers/AAPL/transcripts/AAPL-2024-Q3');
    const res = await itemGET(req, { params: { symbol: 'AAPL', id: 'AAPL-2024-Q3' } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe('AAPL-2024-Q3');
    expect(json.sections).toHaveLength(1);
    expect(json.sections[0].speaker).toBe('Tim Cook');
  });

  it('returns 404 when transcript missing', async () => {
    const req = new Request('http://localhost/api/tickers/AAPL/transcripts/MISSING');
    const res = await itemGET(req, { params: { symbol: 'AAPL', id: 'MISSING' } });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm test:integration tests/integration/api-tickers-transcripts.test.ts
```

Expected: FAIL (missing modules).

- [ ] **Step 3: Implement the list route**

Create `app/api/tickers/[symbol]/transcripts/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { TranscriptsService } from '@/lib/services/transcripts';
import { TranscriptsProvider } from '@/lib/providers/transcripts';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const DEFAULT_K = 4;
const MAX_K = 12;

interface RouteContext { params: { symbol: string } }

export async function GET(req: Request, ctx: RouteContext) {
  try {
    try { await requireUserId(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid symbol: ${ctx.params.symbol}`);

    const url = new URL(req.url);
    const kRaw = url.searchParams.get('k');
    const k = kRaw == null ? DEFAULT_K : Number(kRaw);
    if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
      throw new ValidationError(`k must be an integer in [1, ${MAX_K}]`);
    }

    const db = getServiceDb();
    const svc = new TranscriptsService({
      db,
      provider: new TranscriptsProvider(),
      embeddings: new EmbeddingsProviderImpl()
    });
    const items = await svc.list(symbol, k);
    return NextResponse.json({ items }, {
      headers: { 'Cache-Control': 'private, max-age=300' }
    });
  } catch (err) {
    return errorResponse(err, { route: 'tickers/transcripts' });
  }
}
```

- [ ] **Step 4: Implement the item route**

Create `app/api/tickers/[symbol]/transcripts/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { TranscriptsService } from '@/lib/services/transcripts';
import { TranscriptsProvider } from '@/lib/providers/transcripts';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const ID_RE = /^[A-Z][A-Z.]{0,5}-\d{4}-Q[1-4]$/;

interface RouteContext { params: { symbol: string; id: string } }

export async function GET(req: Request, ctx: RouteContext) {
  try {
    try { await requireUserId(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid symbol: ${ctx.params.symbol}`);
    if (!ID_RE.test(ctx.params.id)) throw new ValidationError(`Invalid id: ${ctx.params.id}`);

    const db = getServiceDb();
    const svc = new TranscriptsService({
      db,
      provider: new TranscriptsProvider(),
      embeddings: new EmbeddingsProviderImpl()
    });
    const doc = await svc.get(ctx.params.id);
    if (!doc) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json(doc, {
      headers: { 'Cache-Control': 'private, max-age=3600' }
    });
  } catch (err) {
    return errorResponse(err, { route: 'tickers/transcripts/item' });
  }
}
```

- [ ] **Step 5: Add `sourceScope` passthrough to /api/rag/stream**

Open `app/api/rag/stream/route.ts`. Find the body-parse step and add `sourceScope` extraction. Pass it down to wherever `SearchService.search()` is called. The change is small (~5 lines): a Zod field for `sourceScope: z.enum(['all', 'filings', 'transcripts']).optional()` and a passthrough to the service.

Add a single integration test case in the corresponding test file (the path is likely `tests/integration/api-rag-stream.test.ts`):

```ts
  it('passes sourceScope=transcripts through to SearchService', async () => {
    // mock SearchService to capture the sourceScope arg
    // ... (mirror existing test patterns in the same file)
  });
```

- [ ] **Step 6: Run all the route tests**

```bash
pnpm test:integration tests/integration/api-tickers-transcripts.test.ts tests/integration/api-rag-stream.test.ts
```

Expected: all tests pass (8 new + existing rag-stream tests).

- [ ] **Step 7: Commit**

```bash
git add app/api/tickers/[symbol]/transcripts/route.ts app/api/tickers/[symbol]/transcripts/[id]/route.ts app/api/rag/stream/route.ts tests/integration/api-tickers-transcripts.test.ts tests/integration/api-rag-stream.test.ts
git commit -m "$(cat <<'EOF'
feat(transcripts): API routes for list + item + RAG sourceScope passthrough

GET /api/tickers/[symbol]/transcripts — newest-K list (k default 4,
max 12), 5-min cache.
GET /api/tickers/[symbol]/transcripts/[id] — full document with
sections, 1-hour cache (immutable after ingest).
POST /api/rag/stream — accepts optional sourceScope: 'all' | 'filings'
| 'transcripts'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: UI components (list + reader + skeleton + empty)

**Files:**
- Create: `app/(app)/stock/[ticker]/transcripts/_components/transcripts-list.tsx`
- Create: `app/(app)/stock/[ticker]/transcripts/_components/transcript-card.tsx`
- Create: `app/(app)/stock/[ticker]/transcripts/_components/transcripts-empty.tsx`
- Create: `app/(app)/stock/[ticker]/transcripts/_components/transcripts-skeleton.tsx`
- Create: `app/(app)/stock/[ticker]/transcripts/_components/transcript-reader.tsx`
- Create: `app/(app)/stock/[ticker]/transcripts/_components/transcript-section-nav.tsx`
- Create: `app/(app)/stock/[ticker]/transcripts/_components/transcript-turn.tsx`

These are pure render components. No isolated tests — the E2E in Task 10 + visual smoke covers them.

- [ ] **Step 1: `transcript-card.tsx`**

Create `app/(app)/stock/[ticker]/transcripts/_components/transcript-card.tsx`:

```tsx
import Link from 'next/link';
import type { TranscriptListItem } from '@/lib/providers/types';

interface Props { ticker: string; item: TranscriptListItem; }

export function TranscriptCard({ ticker, item }: Props) {
  const dateStr = new Date(item.callDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  return (
    <li className="flex items-baseline justify-between border-b border-border px-3 py-2 hover:bg-muted/50">
      <div>
        <span className="font-medium">Q{item.fiscalQuarter} {item.fiscalYear}</span>
        <span className="text-muted-foreground"> · {dateStr}</span>
      </div>
      <Link href={`/stock/${ticker}/transcripts/${item.id}`} className="text-sm text-primary hover:underline">
        Read →
      </Link>
    </li>
  );
}
```

- [ ] **Step 2: `transcripts-list.tsx`**

Create `app/(app)/stock/[ticker]/transcripts/_components/transcripts-list.tsx`:

```tsx
import type { TranscriptListItem } from '@/lib/providers/types';
import { TranscriptCard } from './transcript-card';

interface Props { ticker: string; items: TranscriptListItem[]; }

export function TranscriptsList({ ticker, items }: Props) {
  return (
    <ul className="rounded border border-border overflow-hidden">
      {items.map((it) => <TranscriptCard key={it.id} ticker={ticker} item={it} />)}
    </ul>
  );
}
```

- [ ] **Step 3: `transcripts-empty.tsx`**

Create `app/(app)/stock/[ticker]/transcripts/_components/transcripts-empty.tsx`:

```tsx
interface Props { ticker: string; }

export function TranscriptsEmpty({ ticker }: Props) {
  return (
    <div className="rounded border border-dashed border-border p-8 text-center space-y-3">
      <p className="text-sm text-muted-foreground">
        No transcripts found for <span className="font-mono font-medium">{ticker}</span> yet.
      </p>
      <p className="text-xs text-muted-foreground">
        Motley Fool may not have posted recent calls for this ticker, or coverage is limited.
        Check back after the next earnings call.
      </p>
    </div>
  );
}
```

- [ ] **Step 4: `transcripts-skeleton.tsx`**

Create `app/(app)/stock/[ticker]/transcripts/_components/transcripts-skeleton.tsx`:

```tsx
export function TranscriptsSkeleton() {
  return (
    <ul className="rounded border border-border overflow-hidden animate-pulse">
      {Array.from({ length: 4 }).map((_, i) => (
        <li key={i} className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="h-4 w-40 bg-muted rounded" />
          <div className="h-4 w-12 bg-muted rounded" />
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 5: `transcript-turn.tsx`**

Create `app/(app)/stock/[ticker]/transcripts/_components/transcript-turn.tsx`:

```tsx
import { cn } from '@/lib/utils';

interface Props {
  kind: 'prepared' | 'qa';
  speaker: string;
  role: string | null;
  text: string;
  sectionIndex: number;
}

export function TranscriptTurn({ kind, speaker, role, text, sectionIndex }: Props) {
  return (
    <article
      id={`turn-${sectionIndex}`}
      className={cn('grid grid-cols-12 gap-4 py-3 border-b border-border last:border-0',
        kind === 'qa' && 'bg-muted/30')}
    >
      <header className="col-span-3 text-sm">
        <div className="font-medium">{speaker}</div>
        {role && <div className="text-muted-foreground text-xs">{role}</div>}
      </header>
      <div className="col-span-9 text-sm leading-relaxed">{text}</div>
    </article>
  );
}
```

- [ ] **Step 6: `transcript-section-nav.tsx`**

Create `app/(app)/stock/[ticker]/transcripts/_components/transcript-section-nav.tsx`:

```tsx
'use client';

interface Props {
  preparedStartIndex: number;
  qaStartIndex: number | null;
}

export function TranscriptSectionNav({ preparedStartIndex, qaStartIndex }: Props) {
  return (
    <nav className="sticky top-4 space-y-2 text-sm">
      <a href={`#turn-${preparedStartIndex}`} className="block hover:text-primary">Prepared Remarks</a>
      {qaStartIndex != null && <a href={`#turn-${qaStartIndex}`} className="block hover:text-primary">Q&amp;A</a>}
    </nav>
  );
}
```

- [ ] **Step 7: `transcript-reader.tsx`**

Create `app/(app)/stock/[ticker]/transcripts/_components/transcript-reader.tsx`:

```tsx
import type { TranscriptDocument } from '@/lib/providers/types';
import { TranscriptTurn } from './transcript-turn';
import { TranscriptSectionNav } from './transcript-section-nav';

interface Props { doc: TranscriptDocument; }

export function TranscriptReader({ doc }: Props) {
  const qaStartIndex = doc.sections.findIndex((s) => s.kind === 'qa');
  return (
    <div className="grid grid-cols-12 gap-6">
      <aside className="col-span-2 hidden md:block">
        <TranscriptSectionNav preparedStartIndex={0} qaStartIndex={qaStartIndex >= 0 ? qaStartIndex : null} />
      </aside>
      <div className="col-span-12 md:col-span-10">
        {doc.sections.map((s, idx) => (
          <TranscriptTurn key={idx} sectionIndex={idx} kind={s.kind} speaker={s.speaker} role={s.role} text={s.text} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add app/\(app\)/stock/\[ticker\]/transcripts/_components/
git commit -m "$(cat <<'EOF'
feat(transcripts): UI components — list cards, empty/skeleton states, reader + section nav

Server components for the new tab. transcripts-list + transcript-card
render the per-quarter list. transcript-reader + transcript-turn +
transcript-section-nav render the single-call view with sticky nav
and Q&A shading.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Page wiring + tab nav + Ask source-scope toggle

**Files:**
- Create: `app/(app)/stock/[ticker]/transcripts/page.tsx`
- Create: `app/(app)/stock/[ticker]/transcripts/[id]/page.tsx`
- Modify: `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx`
- Modify: `app/(app)/_components/ask-panel.tsx` (or wherever AskPanel is)

- [ ] **Step 1: Add `'transcripts'` to DashboardTab union + TABS array**

Open `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx`. In the union add `'transcripts'` between `'filings'` and `'quality'`:

```ts
export type DashboardTab =
  | 'overview'
  | 'financials'
  | 'technical'
  | 'news'
  | 'insiders'
  | 'holdings'
  | 'filings'
  | 'transcripts'
  | 'quality'
  | 'peers'
  | 'ask';
```

In the TABS array, insert between filings and quality:

```ts
  { value: 'filings',     label: 'Filings',     href: (t) => `/stock/${t}/filings` },
  { value: 'transcripts', label: 'Transcripts', href: (t) => `/stock/${t}/transcripts` },
  { value: 'quality',     label: 'Quality',     href: (t) => `/stock/${t}/quality` },
```

- [ ] **Step 2: Implement the list page**

Create `app/(app)/stock/[ticker]/transcripts/page.tsx`:

```tsx
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { TranscriptsService } from '@/lib/services/transcripts';
import { TranscriptsProvider } from '@/lib/providers/transcripts';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';
import { DashboardTabs } from '../_components/dashboard-tabs';
import { TranscriptsList } from './_components/transcripts-list';
import { TranscriptsEmpty } from './_components/transcripts-empty';
import { TranscriptsSkeleton } from './_components/transcripts-skeleton';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface PageProps { params: { ticker: string }; }

async function TranscriptsContent({ ticker }: { ticker: string }) {
  const db = getServiceDb();
  const svc = new TranscriptsService({
    db,
    provider: new TranscriptsProvider(),
    embeddings: new EmbeddingsProviderImpl()
  });
  const items = await svc.list(ticker, 4);
  if (items.length === 0) return <TranscriptsEmpty ticker={ticker} />;
  return <TranscriptsList ticker={ticker} items={items} />;
}

export default async function TranscriptsPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();

  return (
    <article className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
          <p className="text-sm text-muted-foreground">Earnings call transcripts</p>
        </div>
        <DashboardTabs ticker={ticker} active="transcripts" />
      </header>
      <Card>
        <CardHeader><CardTitle>Recent calls</CardTitle></CardHeader>
        <CardContent>
          <Suspense fallback={<TranscriptsSkeleton />}>
            <TranscriptsContent ticker={ticker} />
          </Suspense>
        </CardContent>
      </Card>
    </article>
  );
}
```

- [ ] **Step 3: Implement the item page**

Create `app/(app)/stock/[ticker]/transcripts/[id]/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { TranscriptsService } from '@/lib/services/transcripts';
import { TranscriptsProvider } from '@/lib/providers/transcripts';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';
import { DashboardTabs } from '../../_components/dashboard-tabs';
import { TranscriptReader } from '../_components/transcript-reader';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const ID_RE = /^[A-Z][A-Z.]{0,5}-\d{4}-Q[1-4]$/;

interface PageProps { params: { ticker: string; id: string }; }

export default async function TranscriptItemPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker) || !ID_RE.test(params.id)) notFound();

  const db = getServiceDb();
  const svc = new TranscriptsService({
    db,
    provider: new TranscriptsProvider(),
    embeddings: new EmbeddingsProviderImpl()
  });
  const doc = await svc.get(params.id);
  if (!doc) notFound();

  const dateStr = new Date(doc.callDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  return (
    <article className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
          <p className="text-sm text-muted-foreground">
            Q{doc.fiscalQuarter} {doc.fiscalYear} earnings call · {dateStr} ·{' '}
            <a href={doc.sourceUrl} target="_blank" rel="noopener" className="hover:underline">source ↗</a>
          </p>
        </div>
        <DashboardTabs ticker={ticker} active="transcripts" />
      </header>
      <Card>
        <CardHeader><CardTitle>Transcript</CardTitle></CardHeader>
        <CardContent>
          <TranscriptReader doc={doc} />
        </CardContent>
      </Card>
    </article>
  );
}
```

- [ ] **Step 4: Add source-scope dropdown to AskPanel**

Open `app/(app)/_components/ask-panel.tsx` (path may vary — search via `grep -r "AskPanel" app/`). Above the question input, add a small dropdown:

```tsx
'use client';
// ... existing imports

const SOURCE_SCOPE_OPTIONS = [
  { value: 'all',         label: 'All sources' },
  { value: 'filings',     label: 'Filings only' },
  { value: 'transcripts', label: 'Transcripts only' }
] as const;
type SourceScope = typeof SOURCE_SCOPE_OPTIONS[number]['value'];
```

Add `const [sourceScope, setSourceScope] = useState<SourceScope>('all');` and render the dropdown above the input. Pass `sourceScope` in the POST body to `/api/rag/stream`.

For citation chips: where the existing renderer reads `chunk_metadata` to build the chip label, add a branch on `source`:

```tsx
if (citation.source === 'transcript') {
  // 🎙 Q3 2024 call · Tim Cook (CEO)
  return `🎙 Q${citation.metadata.fiscal_quarter} ${citation.metadata.fiscal_year} call · ${citation.metadata.speaker}${citation.metadata.role ? ` (${citation.metadata.role})` : ''}`;
}
// existing filing format
return `📄 ${citation.metadata.section_title} (${citation.metadata.ticker} ${citation.metadata.form_type})`;
```

- [ ] **Step 5: Typecheck + manual smoke**

```bash
pnpm typecheck
pnpm dev
```

Visit `/stock/AAPL/transcripts` — expect skeleton briefly, then list of 4 cards (first visit triggers ingest, ~10-30s). Click one → reader renders speaker turns. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add app/\(app\)/stock/\[ticker\]/transcripts/page.tsx app/\(app\)/stock/\[ticker\]/transcripts/\[id\]/page.tsx app/\(app\)/stock/\[ticker\]/_components/dashboard-tabs.tsx app/\(app\)/_components/ask-panel.tsx
git commit -m "$(cat <<'EOF'
feat(transcripts): /stock/[TICKER]/transcripts pages + tab nav + Ask source scope

List page server-renders with TranscriptsService.list inside a
Suspense boundary (cold-cache ingest visible as skeleton). Item page
renders one TranscriptReader with section nav. New 'Transcripts' tab
slotted between Filings and Quality. AskPanel gains a SourceScope
dropdown and citation chips render transcript-specific format.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: smoke script + E2E + push + CI + Vercel verify

**Files:**
- Create: `scripts/try-transcripts.ts`
- Create: `tests/e2e/transcripts.spec.ts`

- [ ] **Step 1: Smoke-test script**

Create `scripts/try-transcripts.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Manual smoke test for the transcripts pipeline.
 * Usage: pnpm exec tsx scripts/try-transcripts.ts AAPL
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { getServiceDb } from '@/lib/db/client';
import { TranscriptsService } from '@/lib/services/transcripts';
import { TranscriptsProvider } from '@/lib/providers/transcripts';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';

async function main() {
  const ticker = (process.argv[2] || 'AAPL').toUpperCase();
  console.log(`Smoke test transcripts for ${ticker}`);
  const db = getServiceDb();
  const svc = new TranscriptsService({
    db,
    provider: new TranscriptsProvider(),
    embeddings: new EmbeddingsProviderImpl()
  });
  const t0 = Date.now();
  const items = await svc.list(ticker, 4);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Got ${items.length} transcripts in ${elapsed}s:`);
  for (const it of items) {
    console.log(`  ${it.id} · ${it.callDate} · ${it.sourceUrl}`);
  }
  if (items.length > 0) {
    const doc = await svc.get(items[0]!.id);
    console.log(`\nFirst transcript (${items[0]!.id}) has ${doc?.sections.length ?? 0} sections.`);
    if (doc && doc.sections.length > 0) {
      const first = doc.sections[0]!;
      console.log(`  First turn: ${first.speaker}${first.role ? ` (${first.role})` : ''} — ${first.text.slice(0, 80)}...`);
    }
  }
  process.exit(0);
}

main().catch((err) => { console.error('smoke failed:', err); process.exit(1); });
```

- [ ] **Step 2: Run the smoke script**

```bash
pnpm exec tsx scripts/try-transcripts.ts AAPL
```

Expected: 4 transcripts listed, first one shows speaker + role + opening sentence. If <4 transcripts come back, investigate whether Motley Fool changed their HTML.

- [ ] **Step 3: Write E2E spec**

Create `tests/e2e/transcripts.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { signInAsTestUser } from './fixtures/auth';

test.describe('Transcripts tab', () => {
  test('navigates from a watchlist ticker to transcripts and reads one', async ({ page }) => {
    await signInAsTestUser(page);
    await page.goto('/stock/AAPL');
    await page.getByRole('link', { name: 'Transcripts' }).click();
    await expect(page).toHaveURL(/\/stock\/AAPL\/transcripts/);
    await expect(page.getByRole('heading', { name: 'AAPL' })).toBeVisible();
    await expect(page.getByText('Earnings call transcripts')).toBeVisible();
    // Cold cache ingest ~10-30s
    await expect(page.getByText(/Q\d 20\d\d/).first()).toBeVisible({ timeout: 45_000 });
    // Click Read on the first card
    await page.getByRole('link', { name: 'Read' }).first().click();
    await expect(page).toHaveURL(/\/stock\/AAPL\/transcripts\/AAPL-\d{4}-Q\d/);
    await expect(page.getByRole('heading', { name: 'Transcript' })).toBeVisible();
  });
});
```

- [ ] **Step 4: Run the full test matrix locally**

```bash
pnpm test                                          # unit + provider tests
pnpm test:integration                              # all integration tests
pnpm test:e2e tests/e2e/transcripts.spec.ts        # the new E2E
pnpm typecheck                                     # final TS check
```

Expected: all green.

- [ ] **Step 5: Commit + push**

```bash
git add scripts/try-transcripts.ts tests/e2e/transcripts.spec.ts
git commit -m "$(cat <<'EOF'
test(transcripts): try-transcripts smoke + Playwright E2E happy path

Smoke script prints the 4 latest transcripts for a ticker and the
first speaker turn of the most-recent one. E2E navigates from the
watchlist into Transcripts tab, lets the cold-cache ingest finish,
and clicks into the most-recent call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin master
```

- [ ] **Step 6: Watch CI**

Open the GitHub Actions tab for the master push. Wait for typecheck + unit + integration + E2E to all go green.

- [ ] **Step 7: Vercel deploy + browser smoke**

Once Vercel finishes deploying:
1. Visit `/stock/AAPL/transcripts` on the production URL. Cold-cache ingest happens once (~30s). Confirm 4 cards render.
2. Click one card. Confirm the reader renders speaker turns with section nav on the left.
3. Refresh the list page. Should be instant (<1s).
4. Try a Brazilian ADR (e.g., `/stock/ITUB/transcripts`). Confirm either: 4 transcripts render, or `TranscriptsEmpty` shows ("No transcripts found for ITUB yet"). Either is correct depending on Motley Fool coverage.
5. Open the Ask panel from the watchlist. Select "Transcripts only" from the source scope dropdown. Ask: "What did Apple management say about iPhone demand?" — confirm only transcript citations appear.
6. Switch source scope back to "All sources" and ask the same. Confirm citations mix filings + transcripts.

If anything looks wrong, note the URL + behavior and roll forward with a fix commit.

---

## Self-Review

**Spec coverage:**
- Motley Fool scraper → Task 3
- 7-day freshness check → Task 5 (`ensureFresh`)
- Latest 4 quarters → Task 5 + Task 7 (default + max parameters)
- `transcripts` + `transcript_chunks` + `transcript_freshness` schema → Task 1
- Parallel-table architecture (not extending chunk_embeddings) → Task 1 + Task 6
- RLS policies → Task 2
- TranscriptsProvider with `spawn` injection → Task 4
- TranscriptsService with promote-on-demand-style on-demand ingest → Task 5
- Embedding strategy: one chunk per speaker turn → Task 5
- API routes: list + item + RAG sourceScope → Task 7
- SearchService sourceScope param → Task 6
- New /stock/[TICKER]/transcripts tab with reader → Task 8 + Task 9
- AskPanel SourceScope dropdown + transcript-aware citations → Task 9
- E2E happy path → Task 10
- Vercel parity script → Task 3

No gaps.

**Placeholder scan:** Step 5 of Task 6 says "the exact diff depends on the current shape" — but the desired *outcome* is fully specified (the union-or-scope structure shown). The implementer needs to read the current `search.ts` to apply the change, which is unavoidable for a modification task. Similarly Task 7 Step 5 says "the path may vary" for AskPanel — search command provided. These are not "TBD" placeholders; they're handoffs to verified-existing code.

**Type consistency:**
- `TranscriptListItem` defined Task 1, used Tasks 4, 5, 7, 8, 9. Same shape: `{ id, ticker, fiscalYear, fiscalQuarter, callDate, sourceUrl }`. ✓
- `TranscriptSection` defined Task 1, used Tasks 4, 5, 8. Same shape. ✓
- `TranscriptDocument` defined Task 1, used Tasks 4, 5, 7, 8, 9. Same shape. ✓
- `SourceScope` defined Task 6, used Task 7 + Task 9. Same enum values. ✓
- Schema field names match between schema (Task 1), service (Task 5), and tests. ✓
- API path `/api/tickers/[symbol]/transcripts` consistent between routes (Task 7), service tests (Task 5/7), and UI (Task 9). ✓
