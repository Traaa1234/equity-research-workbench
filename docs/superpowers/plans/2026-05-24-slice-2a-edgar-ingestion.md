# Slice 2A — EDGAR Ingestion + Section Parsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working "Filings" tab on the ticker dashboard. User clicks a button → ~30-90s later they have 10-K + 10-Q filings from SEC EDGAR (last 5 years), parsed into the 4-6 major research sections each, readable in-app.

**Architecture:** Add a `FilingsService` over a Postgres-only cache layer. New `SecEdgarProvider` TS adapter that spawns a Python script locally (yfinance pattern) or HTTP-calls a Vercel Python serverless function in prod. Two new tables (`filings`, `filing_chunks`) with RLS matching existing reference-data tables. Filings UI is on-demand: empty state shows "Load filings" button, no auto-fetch.

**Tech Stack:** Phase 1A-1C stack + SEC EDGAR REST API + BeautifulSoup (Python) for HTML parsing + the existing Vercel Python serverless infrastructure from Phase 1C M7.

**Spec reference:** `docs/superpowers/specs/2026-05-24-slice-2a-edgar-ingestion-design.md`

**Prior phases:** Slice 1 (Phase 1A + 1B + 1C) is shipped — 95 commits, 73 unit + 61 integration tests, live on Vercel. This plan picks up at commit `f9f02c8` or later (the Slice 2A spec).

---

## File Structure for Slice 2A

```
equity-research-workbench/
├── api/
│   ├── fallback/
│   │   └── sec.py                                  # Vercel Python serverless (NEW)
│   └── requirements.txt                            # MODIFIED: add beautifulsoup4 + requests
├── app/
│   ├── (app)/stock/[ticker]/
│   │   ├── _components/
│   │   │   └── filings-empty-state.tsx             # client island: "Load" button + polling (NEW)
│   │   └── filings/
│   │       ├── page.tsx                            # filings list page (NEW)
│   │       ├── loading.tsx                         # skeleton (NEW)
│   │       └── [accession]/
│   │           ├── page.tsx                        # single-filing reader (NEW)
│   │           └── _components/
│   │               └── section-nav.tsx             # client island: section tabs + lazy text fetch (NEW)
│   └── api/
│       └── tickers/[symbol]/
│           └── filings/
│               ├── route.ts                        # GET list, POST trigger (NEW)
│               └── [accession]/
│                   ├── route.ts                    # GET filing metadata + section list (NEW)
│                   └── sections/[sectionKey]/
│                       └── route.ts                # GET section text (NEW)
├── lib/
│   ├── db/
│   │   ├── schema.ts                               # MODIFIED: add filings + filing_chunks
│   │   ├── types.ts                                # MODIFIED: add Filing, FilingChunk types
│   │   └── migrations/
│   │       └── 9998_rls_filings.sql                # RLS for 2 new tables (NEW)
│   ├── providers/
│   │   ├── sec-edgar.ts                            # TS adapter (NEW)
│   │   └── types.ts                                # MODIFIED: add SecFiling + SecFilingFull types
│   └── services/
│       └── filings.ts                              # FilingsService (NEW)
├── scripts/
│   ├── sec_fetch.py                                # Python CLI for local dev (NEW)
│   ├── requirements.txt                            # MODIFIED: add beautifulsoup4 + requests
│   └── try-filings.ts                              # smoke test (NEW)
└── tests/
    ├── providers/
    │   ├── sec-edgar.test.ts                       # unit tests (NEW)
    │   └── __fixtures__/
    │       ├── sec-cik-aapl.json                   # NEW
    │       ├── sec-index-aapl.json                 # NEW
    │       └── sec-filing-aapl-10k-2024.json       # NEW
    └── integration/
        ├── filings-service.test.ts                 # NEW
        ├── api-filings.test.ts                     # NEW
        └── filings-schema.test.ts                  # RLS check (NEW)
```

**Module responsibilities:**

| Module | Purpose | Depends on |
| --- | --- | --- |
| `scripts/sec_fetch.py` | Python CLI: CIK lookup, filings index, single-filing parse. Same dispatch shape as `scripts/yfinance_fetch.py` | `requests`, `beautifulsoup4` |
| `api/fallback/sec.py` | Vercel serverless wrapper around the same Python logic (or duplicates it) | same Python deps |
| `lib/providers/sec-edgar.ts` | TS adapter; runtime branch (subprocess vs HTTP) like `yfinance.ts` | provider types, env |
| `lib/services/filings.ts` | `FilingsService` — list/ingest/getFiling/getSectionText | provider, db |
| `app/api/tickers/[symbol]/filings/**` | Thin HTTP shells | service |
| `app/(app)/stock/[ticker]/filings/**` | RSC pages + client islands | service (server-side), API (client-side fetch) |

---

## Milestone 1: Schema + RLS

### Task 1.1: Add `filings` and `filing_chunks` to Drizzle schema

**Files:**
- Modify: `lib/db/schema.ts`
- Modify: `lib/db/types.ts`

- [ ] **Step 1: Append to `lib/db/schema.ts`**

Open the file and add the new tables. Make sure `integer` and `bigserial` are imported from `drizzle-orm/pg-core` (most other imports are already present from Slice 1).

```ts
import { integer } from 'drizzle-orm/pg-core';

export const filings = pgTable(
  'filings',
  {
    accessionNo: text('accession_no').primaryKey(),
    ticker: text('ticker')
      .notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    cik: text('cik').notNull(),
    formType: text('form_type').notNull(),
    filingDate: date('filing_date').notNull(),
    periodEnd: date('period_end'),
    primaryDocUrl: text('primary_doc_url').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    parsedAt: timestamp('parsed_at', { withTimezone: true }),
    source: text('source').notNull().default('sec_edgar')
  },
  (t) => ({
    tickerDateIdx: index('filings_ticker_date_idx').on(t.ticker, t.filingDate),
    tickerFormDateIdx: index('filings_ticker_form_date_idx').on(t.ticker, t.formType, t.filingDate)
  })
);

export const filingChunks = pgTable(
  'filing_chunks',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    filingId: text('filing_id')
      .notNull()
      .references(() => filings.accessionNo, { onDelete: 'cascade' }),
    sectionKey: text('section_key').notNull(),
    sectionTitle: text('section_title').notNull(),
    text: text('text').notNull(),
    charCount: integer('char_count').notNull(),
    charOffsetStart: integer('char_offset_start'),
    charOffsetEnd: integer('char_offset_end')
  },
  (t) => ({
    filingSectionUniq: uniqueIndex('filing_chunks_filing_section_uniq').on(t.filingId, t.sectionKey),
    filingIdx: index('filing_chunks_filing_idx').on(t.filingId)
  })
);
```

Drizzle's `uniqueIndex` import: `import { uniqueIndex } from 'drizzle-orm/pg-core'`. Add it to the existing imports at the top of the file.

- [ ] **Step 2: Append to `lib/db/types.ts`**

```ts
import type { filings, filingChunks } from './schema';

export type Filing       = typeof filings.$inferSelect;
export type NewFiling    = typeof filings.$inferInsert;
export type FilingChunk  = typeof filingChunks.$inferSelect;
export type NewFilingChunk = typeof filingChunks.$inferInsert;
```

- [ ] **Step 3: Generate migration**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm db:generate
```

Expected: creates a new migration file in `lib/db/migrations/` with `CREATE TABLE filings ...` and `CREATE TABLE filing_chunks ...`.

- [ ] **Step 4: Apply migration to production Neon branch**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm exec drizzle-kit push --force
```

Expected: prompts to apply changes, accepts, exits cleanly. `[✓] Changes applied`.

- [ ] **Step 5: Apply migration to test Neon branch**

```powershell
$env:DATABASE_URL_SERVICE_ROLE = $env:DATABASE_URL_TEST_SERVICE_ROLE
pnpm exec drizzle-kit push --force
Remove-Item Env:DATABASE_URL_SERVICE_ROLE
```

Expected: same `[✓] Changes applied` against the test branch.

- [ ] **Step 6: Verify both branches have the new tables**

Quick verification (one-off script, deleted after):

```ts
// _check.ts
import { config } from 'dotenv';
config({ path: '.env.local' });
import postgres from 'postgres';

for (const [label, url] of [
  ['prod', process.env.DATABASE_URL_SERVICE_ROLE!],
  ['test', process.env.DATABASE_URL_TEST_SERVICE_ROLE!]
]) {
  const sql = postgres(url, { prepare: false, max: 1 });
  const t = await sql`select table_name from information_schema.tables where table_schema = 'public' and table_name in ('filings', 'filing_chunks') order by table_name`;
  console.log(`${label}:`, t.map((r) => r.table_name).join(', '));
  await sql.end();
}
```

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm exec tsx _check.ts && rm _check.ts
```

Expected output:
```
prod: filing_chunks, filings
test: filing_chunks, filings
```

- [ ] **Step 7: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add lib/db/schema.ts lib/db/types.ts lib/db/migrations/
git commit -m "feat(db): add filings + filing_chunks tables for Slice 2A"
```

---

### Task 1.2: RLS policies + grants for the new tables

**Files:**
- Create: `lib/db/migrations/9998_rls_filings.sql`

The numeric prefix `9998` runs before the existing `9999_rls_policies.sql`. Both are hand-applied (Drizzle migrations don't manage raw SQL files yet in this project).

- [ ] **Step 1: Write the SQL file**

```sql
-- RLS for Slice 2A reference data: filings + filing_chunks.
-- Same pattern as companies/snapshots/etc: any authenticated user can SELECT,
-- writes go through service_role (BYPASSRLS).

alter table public.filings        enable row level security;
alter table public.filing_chunks  enable row level security;

drop policy if exists "auth read filings" on public.filings;
create policy "auth read filings"
  on public.filings for select to authenticated using (true);

drop policy if exists "auth read filing_chunks" on public.filing_chunks;
create policy "auth read filing_chunks"
  on public.filing_chunks for select to authenticated using (true);

grant select on public.filings, public.filing_chunks to authenticated;
```

The `drop policy if exists ... ; create policy ...` shape makes the migration idempotent — safe to re-run on either branch.

- [ ] **Step 2: Apply to production Neon branch**

In Neon's SQL editor, switch to your production branch, paste the SQL above, and click Run. Expected: `ALTER TABLE` × 2, `DROP POLICY` × 2 (no-op the first time), `CREATE POLICY` × 2, `GRANT`.

- [ ] **Step 3: Apply to test Neon branch**

Same drill: switch to the `test` branch in Neon's SQL editor, paste, run.

- [ ] **Step 4: Verify policies exist on both branches**

In each branch's SQL editor:
```sql
select tablename, policyname from pg_policies where schemaname = 'public' and tablename in ('filings', 'filing_chunks');
```

Expected: 2 rows on each branch.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add lib/db/migrations/9998_rls_filings.sql
git commit -m "feat(db): RLS for filings + filing_chunks (read-only for authenticated)"
```

---

## Milestone 2: Python parser

### Task 2.1: Add Python deps + write the CIK + index logic

**Files:**
- Modify: `scripts/requirements.txt`
- Modify: `api/requirements.txt`
- Create: `scripts/sec_fetch.py` (CIK + index only — section parser is Task 2.2)

- [ ] **Step 1: Add deps to both requirements files**

`scripts/requirements.txt`:
```
yfinance>=0.2.40
beautifulsoup4>=4.12.0
requests>=2.31.0
```

`api/requirements.txt`:
```
yfinance>=0.2.40
beautifulsoup4>=4.12.0
requests>=2.31.0
```

- [ ] **Step 2: Install locally**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pip install -r scripts/requirements.txt
```

Expected: pip installs `beautifulsoup4` and `requests` if not already present.

- [ ] **Step 3: Write `scripts/sec_fetch.py` skeleton**

```python
#!/usr/bin/env python3
"""
SEC EDGAR fetcher used by lib/providers/sec-edgar.ts.

Usage: python sec_fetch.py <kind> [--ticker T] [--cik C] [--accession A] [--forms 10-K,10-Q] [--years 5]

  kind = resolve_cik | index | filing

Output: JSON on stdout. Exit 0 on success, exit 1 on failure with
        { "error": str, "kind": "NotFound" | "Provider" | "Validation" | "RateLimit" | "Unknown" }
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import date, timedelta

try:
    import requests
except ImportError as e:
    print(json.dumps({"error": f"requests not installed: {e}", "kind": "Provider"}))
    sys.exit(1)

try:
    from bs4 import BeautifulSoup
except ImportError as e:
    print(json.dumps({"error": f"beautifulsoup4 not installed: {e}", "kind": "Provider"}))
    sys.exit(1)


USER_AGENT = os.environ.get(
    "SEC_USER_AGENT",
    "Equity Research Workbench admin@example.com"
)
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"})

MIN_INTERVAL_SECONDS = 0.21  # ~4.76 req/sec; well under SEC's 10/sec ceiling
_last_request = 0.0


def fail(msg: str, kind: str = "Unknown"):
    print(json.dumps({"error": msg, "kind": kind}))
    sys.exit(1)


def throttled_get(url: str) -> requests.Response:
    global _last_request
    elapsed = time.time() - _last_request
    if elapsed < MIN_INTERVAL_SECONDS:
        time.sleep(MIN_INTERVAL_SECONDS - elapsed)
    _last_request = time.time()
    return SESSION.get(url, timeout=30)


def resolve_cik(ticker: str) -> str:
    """SEC publishes a ticker->CIK index. Tickers are case-insensitive."""
    url = "https://www.sec.gov/files/company_tickers.json"
    resp = throttled_get(url)
    if resp.status_code == 429:
        fail("SEC rate limited", "RateLimit")
    if resp.status_code >= 500:
        fail(f"SEC returned {resp.status_code}", "Provider")
    if not resp.ok:
        fail(f"SEC unexpected {resp.status_code}", "Unknown")
    data = resp.json()
    target = ticker.upper()
    for row in data.values():
        if row.get("ticker", "").upper() == target:
            return f"{int(row['cik_str']):010d}"
    fail(f"Ticker not found at SEC: {ticker}", "NotFound")


def list_filings(cik: str, forms: list[str], years: int) -> dict:
    """SEC publishes a per-CIK submissions JSON; we filter to the requested forms + date window."""
    url = f"https://data.sec.gov/submissions/CIK{cik}.json"
    resp = throttled_get(url)
    if resp.status_code == 404:
        fail(f"CIK not found: {cik}", "NotFound")
    if resp.status_code == 429:
        fail("SEC rate limited", "RateLimit")
    if resp.status_code >= 500:
        fail(f"SEC returned {resp.status_code}", "Provider")
    if not resp.ok:
        fail(f"SEC unexpected {resp.status_code}", "Unknown")
    data = resp.json()
    recent = data.get("filings", {}).get("recent", {})
    cutoff = date.today() - timedelta(days=years * 365)
    out = []
    for i in range(len(recent.get("accessionNumber", []))):
        form = recent["form"][i]
        if form not in forms:
            continue
        filed = date.fromisoformat(recent["filingDate"][i])
        if filed < cutoff:
            continue
        accession = recent["accessionNumber"][i]  # '0000320193-24-000123'
        accession_nodash = accession.replace("-", "")
        primary_doc = recent.get("primaryDocument", [None] * (i + 1))[i]
        period_end = recent.get("reportDate", [None] * (i + 1))[i] or None
        primary_url = (
            f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession_nodash}/{primary_doc}"
            if primary_doc
            else None
        )
        out.append({
            "accessionNo": accession,
            "formType": form,
            "filingDate": recent["filingDate"][i],
            "periodEnd": period_end if period_end else None,
            "primaryDocUrl": primary_url
        })
    return {"cik": cik, "filings": out}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=["resolve_cik", "index", "filing"])
    parser.add_argument("--ticker")
    parser.add_argument("--cik")
    parser.add_argument("--accession")
    parser.add_argument("--forms", default="10-K,10-Q")
    parser.add_argument("--years", type=int, default=5)
    args = parser.parse_args()

    try:
        if args.kind == "resolve_cik":
            if not args.ticker:
                fail("--ticker required", "Validation")
            cik = resolve_cik(args.ticker)
            print(json.dumps({"cik": cik}))
        elif args.kind == "index":
            if not args.cik:
                fail("--cik required", "Validation")
            forms = [f.strip() for f in args.forms.split(",") if f.strip()]
            result = list_filings(args.cik, forms, args.years)
            print(json.dumps(result))
        elif args.kind == "filing":
            if not args.accession:
                fail("--accession required", "Validation")
            # Implemented in Task 2.2
            fail("filing kind not yet implemented", "Provider")
    except SystemExit:
        raise
    except Exception as e:
        fail(f"{type(e).__name__}: {e}", "Provider")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Smoke test CIK + index against live SEC**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
python scripts/sec_fetch.py resolve_cik --ticker AAPL
```
Expected: `{"cik": "0000320193"}` (or whatever Apple's CIK is, zero-padded to 10 digits).

```bash
python scripts/sec_fetch.py index --cik 0000320193 --forms 10-K,10-Q --years 5
```
Expected: JSON with a `filings` array containing ~25 entries (5 × 10-K + 20 × 10-Q over 5 years).

```bash
python scripts/sec_fetch.py resolve_cik --ticker ZZZZZZ
```
Expected: `{"error": "Ticker not found at SEC: ZZZZZZ", "kind": "NotFound"}`, exit code 1.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add scripts/requirements.txt api/requirements.txt scripts/sec_fetch.py
git commit -m "feat(providers): Python SEC EDGAR fetcher (CIK + index)"
```

---

### Task 2.2: Add filing fetch + section parsing to the Python script

**Files:**
- Modify: `scripts/sec_fetch.py`

- [ ] **Step 1: Add section patterns + parse logic above `main()` in `scripts/sec_fetch.py`**

```python
# ---------- Section parsing ----------

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

SECTION_TITLES = {
    'item_1_business': 'Business',
    'item_1a_risk_factors': 'Risk Factors',
    'item_7_mdna': "Management's Discussion and Analysis",
    'item_7a_market_risk': 'Quantitative and Qualitative Disclosures About Market Risk',
    'item_8_financial_statements': 'Financial Statements and Notes',
    'part1_item1_financial_statements': 'Financial Statements',
    'part1_item2_mdna': "Management's Discussion and Analysis",
    'part2_item1a_risk_factor_updates': 'Risk Factor Updates',
    'full_document': 'Full Document'
}


def clean_html_to_text(html: str) -> str:
    """Strip scripts/styles/nav, extract text, collapse whitespace."""
    soup = BeautifulSoup(html, 'html.parser')
    for tag in soup(['script', 'style', 'head', 'meta', 'link']):
        tag.decompose()
    # Drop tables that look like ToC (header rows mentioning "Table of Contents")
    for table in soup.find_all('table'):
        text = table.get_text(' ', strip=True)
        if 'table of contents' in text.lower()[:200]:
            table.decompose()
    text = soup.get_text('\n')
    # Collapse whitespace: many \n -> two \n; many spaces -> one
    text = re.sub(r'\r\n', '\n', text)
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n[ \t]+', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def extract_sections(text: str, form_type: str) -> list[dict]:
    """Find section boundaries via regex patterns; return list of {section_key, section_title, text, char_offset_start, char_offset_end}."""
    patterns = SECTION_PATTERNS_10K if form_type == '10-K' else SECTION_PATTERNS_10Q
    # Find all matches across all patterns; record (offset, section_key, length_of_match)
    hits = []
    for key, pat in patterns:
        for m in pat.finditer(text):
            hits.append((m.start(), key, m.end() - m.start()))
    if not hits:
        # Fallback: return one chunk for the whole document
        return [{
            'section_key': 'full_document',
            'section_title': SECTION_TITLES['full_document'],
            'text': text,
            'char_offset_start': 0,
            'char_offset_end': len(text)
        }]
    # Sort by offset; collapse duplicate keys (keep earliest)
    hits.sort(key=lambda h: h[0])
    seen = set()
    deduped = []
    for h in hits:
        if h[1] in seen:
            continue
        seen.add(h[1])
        deduped.append(h)
    # Re-sort by offset (the dedupe preserved insertion order but keys could be out of position)
    deduped.sort(key=lambda h: h[0])
    # Build sections: from this hit's offset to next hit's offset (or end of text)
    sections = []
    for i, (offset, key, _match_len) in enumerate(deduped):
        end_offset = deduped[i + 1][0] if i + 1 < len(deduped) else len(text)
        section_text = text[offset:end_offset].strip()
        if not section_text:
            continue
        sections.append({
            'section_key': key,
            'section_title': SECTION_TITLES.get(key, key),
            'text': section_text,
            'char_offset_start': offset,
            'char_offset_end': end_offset
        })
    return sections


def fetch_filing(primary_url: str, form_type: str) -> dict:
    """Download the primary document, clean to plaintext, parse sections."""
    resp = throttled_get(primary_url)
    if resp.status_code == 404:
        fail(f"Filing document not found: {primary_url}", "NotFound")
    if resp.status_code == 429:
        fail("SEC rate limited", "RateLimit")
    if resp.status_code >= 500:
        fail(f"SEC returned {resp.status_code}", "Provider")
    if not resp.ok:
        fail(f"SEC unexpected {resp.status_code}", "Unknown")

    html = resp.text
    text = clean_html_to_text(html)
    sections = extract_sections(text, form_type)
    return {
        "formType": form_type,
        "primaryDocUrl": primary_url,
        "sections": sections,
        "totalChars": len(text)
    }
```

- [ ] **Step 2: Update `main()` argparse to accept the new args**

Replace the existing `main()` with:

```python
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=["resolve_cik", "index", "filing"])
    parser.add_argument("--ticker")
    parser.add_argument("--cik")
    parser.add_argument("--accession")
    parser.add_argument("--primary-url")
    parser.add_argument("--form-type")
    parser.add_argument("--forms", default="10-K,10-Q")
    parser.add_argument("--years", type=int, default=5)
    args = parser.parse_args()

    try:
        if args.kind == "resolve_cik":
            if not args.ticker:
                fail("--ticker required", "Validation")
            cik = resolve_cik(args.ticker)
            print(json.dumps({"cik": cik}))
        elif args.kind == "index":
            if not args.cik:
                fail("--cik required", "Validation")
            forms = [f.strip() for f in args.forms.split(",") if f.strip()]
            result = list_filings(args.cik, forms, args.years)
            print(json.dumps(result))
        elif args.kind == "filing":
            if not args.primary_url or not args.form_type:
                fail("--primary-url and --form-type required", "Validation")
            result = fetch_filing(args.primary_url, args.form_type)
            print(json.dumps(result))
    except SystemExit:
        raise
    except Exception as e:
        fail(f"{type(e).__name__}: {e}", "Provider")
```

- [ ] **Step 3: Smoke test against AAPL's most recent 10-K**

First get the URL from the index:

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
python scripts/sec_fetch.py index --cik 0000320193 --forms 10-K --years 1
```

Copy the `primaryDocUrl` of the first result. Then fetch that filing:

```bash
python scripts/sec_fetch.py filing --primary-url "<paste URL>" --form-type 10-K
```

Expected: JSON with a `sections` array of ~5 entries, each with a non-empty `text` field and plausible char offsets. The `text` of `item_1_business` should start with "Business" and contain something about Apple's products.

If section extraction returns only `full_document`, the regex patterns don't match Apple's specific 10-K format. Inspect the cleaned text (add a debug print of `text[:500]`) and adjust patterns if needed.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add scripts/sec_fetch.py
git commit -m "feat(providers): SEC filing fetcher + section parser"
```

---

### Task 2.3: Vercel Python serverless wrapper

**Files:**
- Create: `api/fallback/sec.py`

The Vercel function reuses the same logic. Because Vercel Python doesn't import from arbitrary project paths easily, we duplicate the file (same pattern as yfinance). The diff is just the HTTP handler shape vs argparse.

- [ ] **Step 1: Create `api/fallback/sec.py`**

```python
"""
Vercel Python serverless function: SEC EDGAR fallback fetcher.

URL: /api/fallback/sec?kind=<KIND>&...

kind values:
  resolve_cik    requires: ticker
  index          requires: cik; optional: forms (default 10-K,10-Q), years (default 5)
  filing         requires: primary_url, form_type

Returns JSON. HTTP 200 on success; non-2xx with { error, kind } shape on failure.
"""
import json
import os
import re
import time
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

try:
    import requests
except ImportError:
    requests = None

try:
    from bs4 import BeautifulSoup
except ImportError:
    BeautifulSoup = None


USER_AGENT = os.environ.get(
    "SEC_USER_AGENT",
    "Equity Research Workbench admin@example.com"
)
SESSION = None  # initialized lazily so the import doesn't fail in cold-start before deps load

MIN_INTERVAL_SECONDS = 0.21
_last_request = 0.0


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

SECTION_TITLES = {
    'item_1_business': 'Business',
    'item_1a_risk_factors': 'Risk Factors',
    'item_7_mdna': "Management's Discussion and Analysis",
    'item_7a_market_risk': 'Quantitative and Qualitative Disclosures About Market Risk',
    'item_8_financial_statements': 'Financial Statements and Notes',
    'part1_item1_financial_statements': 'Financial Statements',
    'part1_item2_mdna': "Management's Discussion and Analysis",
    'part2_item1a_risk_factor_updates': 'Risk Factor Updates',
    'full_document': 'Full Document'
}


def session():
    global SESSION
    if SESSION is None:
        SESSION = requests.Session()
        SESSION.headers.update({"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"})
    return SESSION


def throttled_get(url):
    global _last_request
    elapsed = time.time() - _last_request
    if elapsed < MIN_INTERVAL_SECONDS:
        time.sleep(MIN_INTERVAL_SECONDS - elapsed)
    _last_request = time.time()
    return session().get(url, timeout=30)


def clean_html_to_text(html):
    soup = BeautifulSoup(html, 'html.parser')
    for tag in soup(['script', 'style', 'head', 'meta', 'link']):
        tag.decompose()
    for table in soup.find_all('table'):
        text = table.get_text(' ', strip=True)
        if 'table of contents' in text.lower()[:200]:
            table.decompose()
    text = soup.get_text('\n')
    text = re.sub(r'\r\n', '\n', text)
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n[ \t]+', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def extract_sections(text, form_type):
    patterns = SECTION_PATTERNS_10K if form_type == '10-K' else SECTION_PATTERNS_10Q
    hits = []
    for key, pat in patterns:
        for m in pat.finditer(text):
            hits.append((m.start(), key))
    if not hits:
        return [{
            'section_key': 'full_document',
            'section_title': SECTION_TITLES['full_document'],
            'text': text,
            'char_offset_start': 0,
            'char_offset_end': len(text)
        }]
    hits.sort(key=lambda h: h[0])
    seen = set()
    deduped = []
    for h in hits:
        if h[1] in seen:
            continue
        seen.add(h[1])
        deduped.append(h)
    deduped.sort(key=lambda h: h[0])
    sections = []
    for i, (offset, key) in enumerate(deduped):
        end_offset = deduped[i + 1][0] if i + 1 < len(deduped) else len(text)
        section_text = text[offset:end_offset].strip()
        if not section_text:
            continue
        sections.append({
            'section_key': key,
            'section_title': SECTION_TITLES.get(key, key),
            'text': section_text,
            'char_offset_start': offset,
            'char_offset_end': end_offset
        })
    return sections


def resolve_cik(ticker):
    url = "https://www.sec.gov/files/company_tickers.json"
    resp = throttled_get(url)
    if resp.status_code == 429:
        return 503, {"error": "SEC rate limited", "kind": "RateLimit"}
    if resp.status_code >= 500:
        return 503, {"error": f"SEC returned {resp.status_code}", "kind": "Provider"}
    if not resp.ok:
        return 500, {"error": f"SEC unexpected {resp.status_code}", "kind": "Unknown"}
    data = resp.json()
    target = ticker.upper()
    for row in data.values():
        if row.get("ticker", "").upper() == target:
            return 200, {"cik": f"{int(row['cik_str']):010d}"}
    return 404, {"error": f"Ticker not found at SEC: {ticker}", "kind": "NotFound"}


def list_filings(cik, forms, years):
    url = f"https://data.sec.gov/submissions/CIK{cik}.json"
    resp = throttled_get(url)
    if resp.status_code == 404:
        return 404, {"error": f"CIK not found: {cik}", "kind": "NotFound"}
    if resp.status_code == 429:
        return 503, {"error": "SEC rate limited", "kind": "RateLimit"}
    if resp.status_code >= 500:
        return 503, {"error": f"SEC returned {resp.status_code}", "kind": "Provider"}
    if not resp.ok:
        return 500, {"error": f"SEC unexpected {resp.status_code}", "kind": "Unknown"}
    data = resp.json()
    recent = data.get("filings", {}).get("recent", {})
    cutoff = date.today() - timedelta(days=years * 365)
    out = []
    for i in range(len(recent.get("accessionNumber", []))):
        form = recent["form"][i]
        if form not in forms:
            continue
        filed = date.fromisoformat(recent["filingDate"][i])
        if filed < cutoff:
            continue
        accession = recent["accessionNumber"][i]
        accession_nodash = accession.replace("-", "")
        primary_doc = recent.get("primaryDocument", [None] * (i + 1))[i]
        period_end = recent.get("reportDate", [None] * (i + 1))[i] or None
        primary_url = (
            f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession_nodash}/{primary_doc}"
            if primary_doc
            else None
        )
        out.append({
            "accessionNo": accession,
            "formType": form,
            "filingDate": recent["filingDate"][i],
            "periodEnd": period_end if period_end else None,
            "primaryDocUrl": primary_url
        })
    return 200, {"cik": cik, "filings": out}


def fetch_filing(primary_url, form_type):
    resp = throttled_get(primary_url)
    if resp.status_code == 404:
        return 404, {"error": f"Filing document not found: {primary_url}", "kind": "NotFound"}
    if resp.status_code == 429:
        return 503, {"error": "SEC rate limited", "kind": "RateLimit"}
    if resp.status_code >= 500:
        return 503, {"error": f"SEC returned {resp.status_code}", "kind": "Provider"}
    if not resp.ok:
        return 500, {"error": f"SEC unexpected {resp.status_code}", "kind": "Unknown"}
    html = resp.text
    text = clean_html_to_text(html)
    sections = extract_sections(text, form_type)
    return 200, {
        "formType": form_type,
        "primaryDocUrl": primary_url,
        "sections": sections,
        "totalChars": len(text)
    }


def dispatch(qs):
    if requests is None or BeautifulSoup is None:
        return 500, {"error": "Python deps not installed", "kind": "Provider"}
    kind = (qs.get("kind") or [""])[0]
    if kind == "resolve_cik":
        ticker = (qs.get("ticker") or [""])[0]
        if not ticker:
            return 400, {"error": "ticker required", "kind": "Validation"}
        return resolve_cik(ticker)
    if kind == "index":
        cik = (qs.get("cik") or [""])[0]
        if not cik:
            return 400, {"error": "cik required", "kind": "Validation"}
        forms = (qs.get("forms") or ["10-K,10-Q"])[0].split(",")
        years = int((qs.get("years") or ["5"])[0])
        return list_filings(cik, forms, years)
    if kind == "filing":
        primary_url = (qs.get("primary_url") or [""])[0]
        form_type = (qs.get("form_type") or [""])[0]
        if not primary_url or not form_type:
            return 400, {"error": "primary_url and form_type required", "kind": "Validation"}
        return fetch_filing(primary_url, form_type)
    return 400, {"error": f"Unknown kind: {kind}", "kind": "Validation"}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            url = urlparse(self.path)
            qs = parse_qs(url.query)
            status, body = dispatch(qs)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(body).encode("utf-8"))
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"{type(e).__name__}: {e}", "kind": "Provider"}).encode("utf-8"))
```

- [ ] **Step 2: Commit (the Vercel function ships with the next push)**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add api/fallback/sec.py
git commit -m "feat(deploy): Vercel Python serverless function for SEC EDGAR"
```

We'll verify it works against the live URL after the TS adapter lands in M3.

---

## Milestone 3: TS provider adapter

### Task 3.1: Provider types + adapter shell

**Files:**
- Modify: `lib/providers/types.ts`
- Create: `lib/providers/sec-edgar.ts`

- [ ] **Step 1: Append types to `lib/providers/types.ts`**

```ts
// SEC EDGAR provider types — used by SecEdgarProvider.
export interface SecFilingMeta {
  accessionNo: string;
  formType: '10-K' | '10-Q' | string; // string for forward compat (8-K etc.)
  filingDate: string;                  // ISO date YYYY-MM-DD
  periodEnd: string | null;
  primaryDocUrl: string;
}

export interface SecFilingsList {
  cik: string;
  filings: SecFilingMeta[];
}

export interface SecSection {
  section_key: string;
  section_title: string;
  text: string;
  char_offset_start: number;
  char_offset_end: number;
}

export interface SecFilingFull {
  formType: string;
  primaryDocUrl: string;
  sections: SecSection[];
  totalChars: number;
}

export interface SecEdgarProvider {
  resolveCik(ticker: string): Promise<string>;
  listFilings(cik: string, forms: string[], yearsBack: number): Promise<SecFilingsList>;
  fetchFiling(primaryDocUrl: string, formType: string): Promise<SecFilingFull>;
}
```

- [ ] **Step 2: Write `lib/providers/sec-edgar.ts`**

This adapter mirrors the yfinance.ts pattern exactly: subprocess locally, HTTP on Vercel.

```ts
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import {
  NotFoundError,
  ProviderError,
  RateLimitError,
  SecEdgarProvider,
  SecFilingFull,
  SecFilingsList,
  UnknownProviderError,
  ValidationError
} from './types';

interface Options {
  pythonBin?: string;
  scriptPath?: string;
  spawn?: typeof nodeSpawn;
  timeoutMs?: number;
  useHttp?: boolean;
  httpEndpoint?: string;
  fetch?: typeof fetch;
}

const DEFAULT_SCRIPT = path.resolve(process.cwd(), 'scripts/sec_fetch.py');

function defaultHttpEndpoint(): string {
  const vercelUrl = process.env.VERCEL_URL;
  const base = vercelUrl ? `https://${vercelUrl}` : 'http://localhost:3000';
  return `${base}/api/fallback/sec`;
}

export class SecEdgarProviderImpl implements SecEdgarProvider {
  private readonly pythonBin: string;
  private readonly scriptPath: string;
  private readonly spawnImpl: typeof nodeSpawn;
  private readonly timeoutMs: number;
  private readonly useHttp: boolean;
  private readonly httpEndpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: Options = {}) {
    this.pythonBin = opts.pythonBin ?? process.env.PYTHON_BIN ?? 'python';
    this.scriptPath = opts.scriptPath ?? DEFAULT_SCRIPT;
    this.spawnImpl = opts.spawn ?? nodeSpawn;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.useHttp = opts.useHttp ?? process.env.VERCEL === '1';
    this.httpEndpoint = opts.httpEndpoint ?? defaultHttpEndpoint();
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async resolveCik(ticker: string): Promise<string> {
    const out = await this.run({ kind: 'resolve_cik', ticker: ticker.toUpperCase() });
    return out.cik as string;
  }

  async listFilings(cik: string, forms: string[], yearsBack: number): Promise<SecFilingsList> {
    const out = await this.run({
      kind: 'index',
      cik,
      forms: forms.join(','),
      years: String(yearsBack)
    });
    return out as SecFilingsList;
  }

  async fetchFiling(primaryDocUrl: string, formType: string): Promise<SecFilingFull> {
    const out = await this.run({
      kind: 'filing',
      primary_url: primaryDocUrl,
      form_type: formType
    });
    return out as SecFilingFull;
  }

  // ----- Dispatch -----

  private run(params: Record<string, string>): Promise<any> {
    return this.useHttp ? this.runHttp(params) : this.runSubprocess(params);
  }

  private async runHttp(params: Record<string, string>): Promise<any> {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.httpEndpoint}?${qs}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal });
      const body = (await res.json().catch(() => null)) as { error?: string; kind?: string } | null;
      if (res.ok) return body;
      if (!body) throw new UnknownProviderError(`SEC HTTP ${res.status}: empty body`);
      throw toTypedError(body);
    } finally {
      clearTimeout(timer);
    }
  }

  private runSubprocess(params: Record<string, string>): Promise<any> {
    return new Promise((resolve, reject) => {
      const argv: string[] = [this.scriptPath, params.kind!];
      for (const [k, v] of Object.entries(params)) {
        if (k === 'kind') continue;
        argv.push(`--${k.replace(/_/g, '-')}`, v);
      }
      const proc = this.spawnImpl(this.pythonBin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill?.('SIGKILL');
        reject(new ProviderError(`SEC script timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      proc.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
      proc.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(new ProviderError(`Failed to spawn Python: ${err.message}`));
      });
      proc.on('close', (code: number) => {
        clearTimeout(timer);
        let body: any;
        try {
          body = JSON.parse(stdout);
        } catch {
          return reject(new UnknownProviderError(`SEC script returned non-JSON. exit=${code} stderr=${stderr}`));
        }
        if (code === 0) resolve(body);
        else reject(toTypedError(body));
      });
    });
  }
}

function toTypedError(body: { error?: string; kind?: string }): Error {
  const msg = body.error ?? 'Unknown SEC error';
  switch (body.kind) {
    case 'NotFound':
      return new NotFoundError(msg);
    case 'Validation':
      return new ValidationError(msg);
    case 'Provider':
      return new ProviderError(msg);
    case 'RateLimit':
      return new RateLimitError(msg);
    default:
      return new UnknownProviderError(msg);
  }
}
```

- [ ] **Step 3: Verify typecheck**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm typecheck 2>&1 | tail -3
```
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add lib/providers/types.ts lib/providers/sec-edgar.ts
git commit -m "feat(providers): SEC EDGAR TS adapter (subprocess + HTTP dispatch)"
```

---

### Task 3.2: Provider unit tests

**Files:**
- Create: `tests/providers/__fixtures__/sec-cik-aapl.json`
- Create: `tests/providers/__fixtures__/sec-index-aapl.json`
- Create: `tests/providers/__fixtures__/sec-filing-aapl-10k-2024.json`
- Create: `tests/providers/sec-edgar.test.ts`

- [ ] **Step 1: Write the three fixtures**

`tests/providers/__fixtures__/sec-cik-aapl.json`:
```json
{
  "cik": "0000320193"
}
```

`tests/providers/__fixtures__/sec-index-aapl.json`:
```json
{
  "cik": "0000320193",
  "filings": [
    {
      "accessionNo": "0000320193-24-000123",
      "formType": "10-K",
      "filingDate": "2024-11-01",
      "periodEnd": "2024-09-28",
      "primaryDocUrl": "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm"
    },
    {
      "accessionNo": "0000320193-24-000080",
      "formType": "10-Q",
      "filingDate": "2024-08-02",
      "periodEnd": "2024-06-29",
      "primaryDocUrl": "https://www.sec.gov/Archives/edgar/data/320193/000032019324000080/aapl-20240629.htm"
    }
  ]
}
```

`tests/providers/__fixtures__/sec-filing-aapl-10k-2024.json`:
```json
{
  "formType": "10-K",
  "primaryDocUrl": "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm",
  "totalChars": 250000,
  "sections": [
    {
      "section_key": "item_1_business",
      "section_title": "Business",
      "text": "Item 1. Business\n\nApple Inc. designs, manufactures...",
      "char_offset_start": 1200,
      "char_offset_end": 45000
    },
    {
      "section_key": "item_1a_risk_factors",
      "section_title": "Risk Factors",
      "text": "Item 1A. Risk Factors\n\nThe Company's business...",
      "char_offset_start": 45001,
      "char_offset_end": 95000
    },
    {
      "section_key": "item_7_mdna",
      "section_title": "Management's Discussion and Analysis",
      "text": "Item 7. Management's Discussion and Analysis...",
      "char_offset_start": 120000,
      "char_offset_end": 180000
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

`tests/providers/sec-edgar.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';
import { NotFoundError, ProviderError, RateLimitError, ValidationError } from '@/lib/providers/types';
import { loadFixture } from '../helpers/fixtures';

function makeProviderHttp(fetchImpl: typeof fetch) {
  return new SecEdgarProviderImpl({
    useHttp: true,
    httpEndpoint: 'http://test.local/api/fallback/sec',
    fetch: fetchImpl
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  });
}

describe('SecEdgarProviderImpl (HTTP mode)', () => {
  describe('.resolveCik()', () => {
    it('returns CIK for known ticker', async () => {
      const fix = loadFixture('sec-cik-aapl.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProviderHttp(fetchMock);
      const cik = await provider.resolveCik('AAPL');
      expect(cik).toBe('0000320193');
    });

    it('throws NotFoundError on 404', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'not found', kind: 'NotFound' }), { status: 404 })
      );
      const provider = makeProviderHttp(fetchMock);
      await expect(provider.resolveCik('ZZZZ')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('throws RateLimitError on 503/RateLimit', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'rate limited', kind: 'RateLimit' }), { status: 503 })
      );
      const provider = makeProviderHttp(fetchMock);
      await expect(provider.resolveCik('AAPL')).rejects.toBeInstanceOf(RateLimitError);
    });
  });

  describe('.listFilings()', () => {
    it('returns filings list', async () => {
      const fix = loadFixture('sec-index-aapl.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProviderHttp(fetchMock);
      const result = await provider.listFilings('0000320193', ['10-K', '10-Q'], 5);
      expect(result.cik).toBe('0000320193');
      expect(result.filings).toHaveLength(2);
      expect(result.filings[0]!.formType).toBe('10-K');
    });

    it('400 from upstream produces ValidationError', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'bad cik', kind: 'Validation' }), { status: 400 })
      );
      const provider = makeProviderHttp(fetchMock);
      await expect(provider.listFilings('bad', ['10-K'], 5)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('.fetchFiling()', () => {
    it('returns parsed sections', async () => {
      const fix = loadFixture('sec-filing-aapl-10k-2024.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProviderHttp(fetchMock);
      const result = await provider.fetchFiling('https://example.com/aapl-10k.htm', '10-K');
      expect(result.formType).toBe('10-K');
      expect(result.sections).toHaveLength(3);
      expect(result.sections[0]!.section_key).toBe('item_1_business');
    });
  });

  describe('subprocess mode (smoke)', () => {
    function fakeSpawn(stdout: string, exitCode: number) {
      return () => {
        const listeners: Record<string, ((arg?: any) => void)[]> = {};
        const proc = {
          stdout: { on: (ev: string, cb: (data: Buffer) => void) => { if (ev === 'data') cb(Buffer.from(stdout)); } },
          stderr: { on: () => {} },
          on: (ev: string, cb: (arg?: any) => void) => { (listeners[ev] ??= []).push(cb); }
        };
        setTimeout(() => listeners.close?.forEach((cb) => cb(exitCode)), 0);
        return proc;
      };
    }

    it('parses subprocess JSON stdout', async () => {
      const provider = new SecEdgarProviderImpl({
        useHttp: false,
        spawn: fakeSpawn(JSON.stringify({ cik: '0000320193' }), 0) as any
      });
      const cik = await provider.resolveCik('AAPL');
      expect(cik).toBe('0000320193');
    });

    it('subprocess exit 1 with NotFound kind throws NotFoundError', async () => {
      const provider = new SecEdgarProviderImpl({
        useHttp: false,
        spawn: fakeSpawn(JSON.stringify({ error: 'no such', kind: 'NotFound' }), 1) as any
      });
      await expect(provider.resolveCik('ZZ')).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
```

- [ ] **Step 3: Run, verify fails**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test tests/providers/sec-edgar.test.ts 2>&1 | tail -10
```
Expected: tests fail with `Cannot find module` for the fixtures (until written), then pass once everything is in place. If you already wrote the fixtures, this should pass immediately. Adjust as needed.

- [ ] **Step 4: Verify passes**

```bash
pnpm test tests/providers/sec-edgar.test.ts 2>&1 | tail -10
```
Expected: 8 passing (3 + 2 + 1 + 2 across the describe blocks).

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add tests/providers/sec-edgar.test.ts tests/providers/__fixtures__/sec-*.json
git commit -m "test(providers): SEC EDGAR adapter unit tests with fixtures"
```

---

## Milestone 4: FilingsService

### Task 4.1: Service with list / ingest / getFiling / getSectionText

**Files:**
- Create: `lib/services/filings.ts`
- Create: `tests/integration/filings-service.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/filings-service.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, filings, filingChunks } from '@/lib/db/schema';
import { FilingsService } from '@/lib/services/filings';

config({ path: '.env.local' });

function mockProvider(opts: {
  cik?: string;
  filings?: Array<{ accessionNo: string; formType: string; filingDate: string; periodEnd: string | null; primaryDocUrl: string }>;
  sections?: Array<{ section_key: string; section_title: string; text: string; char_offset_start: number; char_offset_end: number }>;
}) {
  return {
    resolveCik: vi.fn().mockResolvedValue(opts.cik ?? '0000320193'),
    listFilings: vi.fn().mockResolvedValue({ cik: opts.cik ?? '0000320193', filings: opts.filings ?? [] }),
    fetchFiling: vi.fn().mockResolvedValue({
      formType: '10-K',
      primaryDocUrl: 'https://x',
      sections: opts.sections ?? [],
      totalChars: 1000
    })
  };
}

describe('FilingsService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.', cik: null });
  });

  it('getList: empty case returns needsIngest=true', async () => {
    const svc = new FilingsService({ db: dbH.db, provider: mockProvider({}) as any });
    const res = await svc.getList('AAPL');
    expect(res.filings).toEqual([]);
    expect(res.needsIngest).toBe(true);
  });

  it('getList: populated case returns the filings sorted desc', async () => {
    await dbH.db.insert(filings).values([
      { accessionNo: '0000320193-24-000080', ticker: 'AAPL', cik: '0000320193', formType: '10-Q', filingDate: '2024-08-02', periodEnd: '2024-06-29', primaryDocUrl: 'https://x/2' },
      { accessionNo: '0000320193-24-000123', ticker: 'AAPL', cik: '0000320193', formType: '10-K', filingDate: '2024-11-01', periodEnd: '2024-09-28', primaryDocUrl: 'https://x/1' }
    ]);
    const svc = new FilingsService({ db: dbH.db, provider: mockProvider({}) as any });
    const res = await svc.getList('AAPL');
    expect(res.filings).toHaveLength(2);
    expect(res.filings[0]!.accessionNo).toBe('0000320193-24-000123'); // newest first
    expect(res.needsIngest).toBe(false);
  });

  it('ingest: resolves CIK, lists, fetches, persists chunks', async () => {
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
    const svc = new FilingsService({ db: dbH.db, provider: provider as any });
    const summary = await svc.ingest('AAPL');
    expect(summary.count).toBe(1);
    expect(provider.resolveCik).toHaveBeenCalledWith('AAPL');

    // Filing persisted
    const f = await dbH.db.select().from(filings).where(eq(filings.ticker, 'AAPL'));
    expect(f).toHaveLength(1);
    expect(f[0]!.parsedAt).not.toBeNull();

    // Chunk persisted
    const c = await dbH.db.select().from(filingChunks);
    expect(c).toHaveLength(1);
    expect(c[0]!.sectionKey).toBe('item_1_business');

    // Company cik populated
    const company = await dbH.db.select().from(companies).where(eq(companies.ticker, 'AAPL'));
    expect(company[0]!.cik).toBe('0000320193');
  });

  it('ingest: skips resolveCik when company.cik already set', async () => {
    await dbH.db.update(companies).set({ cik: '0000320193' }).where(eq(companies.ticker, 'AAPL'));
    const provider = mockProvider({ filings: [] });
    const svc = new FilingsService({ db: dbH.db, provider: provider as any });
    await svc.ingest('AAPL');
    expect(provider.resolveCik).not.toHaveBeenCalled();
    expect(provider.listFilings).toHaveBeenCalledWith('0000320193', ['10-K', '10-Q'], 5);
  });

  it('getSectionText returns the chunk text', async () => {
    await dbH.db.insert(filings).values({
      accessionNo: '0000320193-24-000123', ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
    });
    await dbH.db.insert(filingChunks).values({
      filingId: '0000320193-24-000123', sectionKey: 'item_1_business',
      sectionTitle: 'Business', text: 'Apple does things.', charCount: 18
    });
    const svc = new FilingsService({ db: dbH.db, provider: mockProvider({}) as any });
    const text = await svc.getSectionText('0000320193-24-000123', 'item_1_business');
    expect(text).toBe('Apple does things.');
  });

  it('getSectionText returns null for missing section', async () => {
    const svc = new FilingsService({ db: dbH.db, provider: mockProvider({}) as any });
    const text = await svc.getSectionText('nope', 'nope');
    expect(text).toBeNull();
  });

  it('getFiling returns metadata + section list (no text)', async () => {
    await dbH.db.insert(filings).values({
      accessionNo: '0000320193-24-000123', ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
    });
    await dbH.db.insert(filingChunks).values([
      { filingId: '0000320193-24-000123', sectionKey: 'item_1_business', sectionTitle: 'Business', text: 'a', charCount: 1 },
      { filingId: '0000320193-24-000123', sectionKey: 'item_1a_risk_factors', sectionTitle: 'Risk Factors', text: 'b', charCount: 1 }
    ]);
    const svc = new FilingsService({ db: dbH.db, provider: mockProvider({}) as any });
    const res = await svc.getFiling('AAPL', '0000320193-24-000123');
    expect(res).not.toBeNull();
    expect(res!.filing.accessionNo).toBe('0000320193-24-000123');
    expect(res!.sections).toHaveLength(2);
    // Make sure section list doesn't include the actual text (saves bandwidth)
    expect((res!.sections[0] as any).text).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify fails**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/filings-service.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Write `lib/services/filings.ts`**

```ts
import { and, desc, eq, sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { companies, filings, filingChunks, refreshRuns } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import { NotFoundError, SecEdgarProvider, ValidationError } from '@/lib/providers/types';
import { logger } from '@/lib/logger';

interface Deps {
  db: ServiceDb;
  provider: SecEdgarProvider;
}

export interface FilingListItem {
  accessionNo: string;
  formType: string;
  filingDate: string;
  periodEnd: string | null;
  primaryDocUrl: string;
  parsedAt: Date | null;
}

export interface FilingListResult {
  filings: FilingListItem[];
  needsIngest: boolean;
}

export interface FilingSectionRef {
  sectionKey: string;
  sectionTitle: string;
  charCount: number;
}

export interface FilingDetail {
  filing: FilingListItem;
  sections: FilingSectionRef[];
}

export interface IngestSummary {
  ticker: string;
  count: number;
  succeeded: number;
  failed: number;
  durationMs: number;
}

const FORMS_DEFAULT = ['10-K', '10-Q'];
const YEARS_DEFAULT = 5;

export class FilingsService {
  constructor(private readonly deps: Deps) {}

  async getList(ticker: string): Promise<FilingListResult> {
    const t = ticker.toUpperCase();
    const rows = await this.deps.db
      .select({
        accessionNo: filings.accessionNo,
        formType: filings.formType,
        filingDate: filings.filingDate,
        periodEnd: filings.periodEnd,
        primaryDocUrl: filings.primaryDocUrl,
        parsedAt: filings.parsedAt
      })
      .from(filings)
      .where(eq(filings.ticker, t))
      .orderBy(desc(filings.filingDate));

    return { filings: rows, needsIngest: rows.length === 0 };
  }

  async ingest(ticker: string): Promise<IngestSummary> {
    const t = ticker.toUpperCase();
    const started = Date.now();
    const summary: IngestSummary = { ticker: t, count: 0, succeeded: 0, failed: 0, durationMs: 0 };

    // Ensure company row exists; refuse otherwise (caller should have created it)
    const companyRows = await this.deps.db.select().from(companies).where(eq(companies.ticker, t)).limit(1);
    if (companyRows.length === 0) {
      throw new NotFoundError(`Company ${t} not in companies table; add via /api/tickers/add first`);
    }
    const company = companyRows[0]!;

    // Resolve CIK if missing
    let cik = company.cik;
    if (!cik) {
      cik = await this.deps.provider.resolveCik(t);
      await this.deps.db.update(companies).set({ cik }).where(eq(companies.ticker, t));
    }

    // List filings
    const list = await this.deps.provider.listFilings(cik, FORMS_DEFAULT, YEARS_DEFAULT);

    // Upsert metadata rows
    if (list.filings.length === 0) {
      summary.durationMs = Date.now() - started;
      return summary;
    }
    await this.deps.db
      .insert(filings)
      .values(
        list.filings.map((f) => ({
          accessionNo: f.accessionNo,
          ticker: t,
          cik: cik!,
          formType: f.formType,
          filingDate: f.filingDate,
          periodEnd: f.periodEnd,
          primaryDocUrl: f.primaryDocUrl
        }))
      )
      .onConflictDoNothing();
    summary.count = list.filings.length;

    // For each filing without parsed_at, fetch + parse + persist chunks
    const needParsing = await this.deps.db
      .select()
      .from(filings)
      .where(and(eq(filings.ticker, t), sql`${filings.parsedAt} is null`));

    for (const filing of needParsing) {
      const t0 = new Date();
      try {
        const full = await this.deps.provider.fetchFiling(filing.primaryDocUrl, filing.formType);
        if (full.sections.length > 0) {
          await this.deps.db
            .insert(filingChunks)
            .values(
              full.sections.map((s) => ({
                filingId: filing.accessionNo,
                sectionKey: s.section_key,
                sectionTitle: s.section_title,
                text: s.text,
                charCount: s.text.length,
                charOffsetStart: s.char_offset_start,
                charOffsetEnd: s.char_offset_end
              }))
            )
            .onConflictDoNothing();
        }
        await this.deps.db.update(filings).set({ parsedAt: new Date() }).where(eq(filings.accessionNo, filing.accessionNo));
        await this.deps.db.insert(refreshRuns).values({
          ticker: t,
          kind: `filing:${filing.accessionNo}`,
          startedAt: t0,
          completedAt: new Date(),
          ok: true,
          sourceUsed: 'sec_edgar'
        });
        summary.succeeded++;
      } catch (err) {
        await this.deps.db.insert(refreshRuns).values({
          ticker: t,
          kind: `filing:${filing.accessionNo}`,
          startedAt: t0,
          completedAt: new Date(),
          ok: false,
          sourceUsed: 'sec_edgar',
          error: String(err).slice(0, 1000)
        });
        summary.failed++;
        logger.warn({ ticker: t, accession: filing.accessionNo, err: String(err) }, 'filings: parse failed');
      }
    }

    summary.durationMs = Date.now() - started;
    return summary;
  }

  async getFiling(ticker: string, accessionNo: string): Promise<FilingDetail | null> {
    const t = ticker.toUpperCase();
    const rows = await this.deps.db
      .select({
        accessionNo: filings.accessionNo,
        formType: filings.formType,
        filingDate: filings.filingDate,
        periodEnd: filings.periodEnd,
        primaryDocUrl: filings.primaryDocUrl,
        parsedAt: filings.parsedAt
      })
      .from(filings)
      .where(and(eq(filings.ticker, t), eq(filings.accessionNo, accessionNo)))
      .limit(1);
    if (rows.length === 0) return null;
    const filing = rows[0]!;
    const sectionRows = await this.deps.db
      .select({ sectionKey: filingChunks.sectionKey, sectionTitle: filingChunks.sectionTitle, charCount: filingChunks.charCount })
      .from(filingChunks)
      .where(eq(filingChunks.filingId, accessionNo))
      .orderBy(filingChunks.id);
    return { filing, sections: sectionRows };
  }

  async getSectionText(accessionNo: string, sectionKey: string): Promise<string | null> {
    const rows = await this.deps.db
      .select({ text: filingChunks.text })
      .from(filingChunks)
      .where(and(eq(filingChunks.filingId, accessionNo), eq(filingChunks.sectionKey, sectionKey)))
      .limit(1);
    return rows[0]?.text ?? null;
  }
}
```

- [ ] **Step 4: Run, verify passes**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/filings-service.test.ts 2>&1 | tail -10
```
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add lib/services/filings.ts tests/integration/filings-service.test.ts
git commit -m "feat(services): FilingsService with list/ingest/getFiling/getSectionText"
```

---

## Milestone 5: API routes

### Task 5.1: GET + POST /api/tickers/[symbol]/filings

**Files:**
- Create: `app/api/tickers/[symbol]/filings/route.ts`
- Create: `tests/integration/api-filings.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/api-filings.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companies, filings } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('/api/tickers/[symbol]/filings', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => newUserId(),
      getCurrentUserId: async () => newUserId(),
      UnauthorizedError: class extends Error {}
    }));
  });

  it('GET returns empty + needsIngest=true when no filings exist', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    const { GET } = await import('@/app/api/tickers/[symbol]/filings/route');
    const res = await GET(new Request('http://localhost/api/tickers/AAPL/filings'), { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filings).toEqual([]);
    expect(body.needsIngest).toBe(true);
  });

  it('GET returns populated list when filings exist', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await dbH.db.insert(filings).values({
      accessionNo: '0000320193-24-000123',
      ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01',
      primaryDocUrl: 'https://x'
    });
    const { GET } = await import('@/app/api/tickers/[symbol]/filings/route');
    const res = await GET(new Request('http://localhost/api/tickers/AAPL/filings'), { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filings).toHaveLength(1);
    expect(body.needsIngest).toBe(false);
  });

  it('GET 400 on invalid ticker', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/filings/route');
    const res = await GET(new Request('http://localhost/api/tickers/lower-case/filings'), { params: { symbol: 'lower-case' } });
    expect(res.status).toBe(400);
  });

  // POST tests intentionally don't fire a real ingest (would hit live SEC).
  // Live ingestion is exercised in the smoke test (try-filings.ts).
  it('POST 400 on invalid ticker', async () => {
    const { POST } = await import('@/app/api/tickers/[symbol]/filings/route');
    const res = await POST(new Request('http://localhost/api/tickers/bogus-1/filings', { method: 'POST' }), { params: { symbol: 'bogus-1' } });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run, verify fails**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/api-filings.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Write the handler**

```ts
// app/api/tickers/[symbol]/filings/route.ts
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FilingsService } from '@/lib/services/filings';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface RouteContext { params: { symbol: string }; }

let svc: FilingsService | null = null;
function service() {
  if (svc) return svc;
  svc = new FilingsService({ db: getServiceDb(), provider: new SecEdgarProviderImpl() });
  return svc;
}

export async function GET(_req: Request, ctx: RouteContext) {
  try {
    await requireUserId();
    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid ticker: ${symbol}`);
    const result = await service().getList(symbol);
    return ok(result);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/filings GET' });
  }
}

export async function POST(_req: Request, ctx: RouteContext) {
  try {
    await requireUserId();
    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid ticker: ${symbol}`);
    const summary = await service().ingest(symbol);
    return ok(summary);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/filings POST' });
  }
}

export const maxDuration = 90; // ingest can take ~30-90s
```

- [ ] **Step 4: Run, verify passes**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/api-filings.test.ts 2>&1 | tail -10
```
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/api/tickers/[symbol]/filings/route.ts tests/integration/api-filings.test.ts
git commit -m "feat(api): GET + POST /api/tickers/[symbol]/filings"
```

---

### Task 5.2: GET /api/tickers/[symbol]/filings/[accession]

**Files:**
- Create: `app/api/tickers/[symbol]/filings/[accession]/route.ts`
- Append to: `tests/integration/api-filings.test.ts`

- [ ] **Step 1: Append failing test**

```ts
  it('GET single filing returns metadata + section list (no text)', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await dbH.db.insert(filings).values({
      accessionNo: '0000320193-24-000123',
      ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01',
      primaryDocUrl: 'https://x'
    });
    // Insert a chunk so the section list is populated
    const { filingChunks } = await import('@/lib/db/schema');
    await dbH.db.insert(filingChunks).values({
      filingId: '0000320193-24-000123',
      sectionKey: 'item_1_business',
      sectionTitle: 'Business',
      text: 'Apple does things.',
      charCount: 18
    });

    const { GET } = await import('@/app/api/tickers/[symbol]/filings/[accession]/route');
    const res = await GET(new Request('http://localhost/api/tickers/AAPL/filings/0000320193-24-000123'), {
      params: { symbol: 'AAPL', accession: '0000320193-24-000123' }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filing.accessionNo).toBe('0000320193-24-000123');
    expect(body.sections).toHaveLength(1);
    expect((body.sections[0] as any).text).toBeUndefined();
  });

  it('GET single filing 404 when missing', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    const { GET } = await import('@/app/api/tickers/[symbol]/filings/[accession]/route');
    const res = await GET(new Request('http://localhost/api/tickers/AAPL/filings/nope'), {
      params: { symbol: 'AAPL', accession: 'nope' }
    });
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 2: Write the handler**

```ts
// app/api/tickers/[symbol]/filings/[accession]/route.ts
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FilingsService } from '@/lib/services/filings';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/;

interface RouteContext { params: { symbol: string; accession: string }; }

let svc: FilingsService | null = null;
function service() {
  if (svc) return svc;
  svc = new FilingsService({ db: getServiceDb(), provider: new SecEdgarProviderImpl() });
  return svc;
}

export async function GET(_req: Request, ctx: RouteContext) {
  try {
    await requireUserId();
    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid ticker: ${symbol}`);
    const accession = ctx.params.accession;
    if (!ACCESSION_RE.test(accession)) throw new ValidationError(`Invalid accession: ${accession}`);
    const result = await service().getFiling(symbol, accession);
    if (!result) throw new NotFoundError(`Filing not found: ${accession}`);
    return ok(result);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/filings/[accession] GET' });
  }
}
```

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/api/tickers/[symbol]/filings/[accession]/route.ts tests/integration/api-filings.test.ts
git commit -m "feat(api): GET /api/tickers/[symbol]/filings/[accession]"
```

---

### Task 5.3: GET /api/tickers/[symbol]/filings/[accession]/sections/[sectionKey]

**Files:**
- Create: `app/api/tickers/[symbol]/filings/[accession]/sections/[sectionKey]/route.ts`
- Append to: `tests/integration/api-filings.test.ts`

- [ ] **Step 1: Append failing test**

```ts
  it('GET section text returns the chunk text', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await dbH.db.insert(filings).values({
      accessionNo: '0000320193-24-000123', ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
    });
    const { filingChunks } = await import('@/lib/db/schema');
    await dbH.db.insert(filingChunks).values({
      filingId: '0000320193-24-000123', sectionKey: 'item_1_business',
      sectionTitle: 'Business', text: 'Apple does things.', charCount: 18
    });
    const { GET } = await import('@/app/api/tickers/[symbol]/filings/[accession]/sections/[sectionKey]/route');
    const res = await GET(
      new Request('http://localhost/api/tickers/AAPL/filings/0000320193-24-000123/sections/item_1_business'),
      { params: { symbol: 'AAPL', accession: '0000320193-24-000123', sectionKey: 'item_1_business' } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe('Apple does things.');
  });

  it('GET section text returns 404 when section missing', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/filings/[accession]/sections/[sectionKey]/route');
    const res = await GET(
      new Request('http://localhost/api/tickers/AAPL/filings/missing/sections/nope'),
      { params: { symbol: 'AAPL', accession: '0000320193-24-000123', sectionKey: 'nope' } }
    );
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 2: Write the handler**

```ts
// app/api/tickers/[symbol]/filings/[accession]/sections/[sectionKey]/route.ts
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FilingsService } from '@/lib/services/filings';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';

const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/;
const SECTION_KEY_RE = /^[a-z0-9_]+$/;

interface RouteContext { params: { symbol: string; accession: string; sectionKey: string }; }

let svc: FilingsService | null = null;
function service() {
  if (svc) return svc;
  svc = new FilingsService({ db: getServiceDb(), provider: new SecEdgarProviderImpl() });
  return svc;
}

export async function GET(_req: Request, ctx: RouteContext) {
  try {
    await requireUserId();
    const { accession, sectionKey } = ctx.params;
    if (!ACCESSION_RE.test(accession)) throw new ValidationError(`Invalid accession: ${accession}`);
    if (!SECTION_KEY_RE.test(sectionKey)) throw new ValidationError(`Invalid section key: ${sectionKey}`);
    const text = await service().getSectionText(accession, sectionKey);
    if (text == null) throw new NotFoundError(`Section not found: ${sectionKey}`);
    return ok({ text });
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/filings/[accession]/sections/[sectionKey] GET' });
  }
}
```

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/api/tickers/[symbol]/filings/[accession]/sections/[sectionKey]/route.ts tests/integration/api-filings.test.ts
git commit -m "feat(api): GET /api/tickers/[symbol]/filings/[accession]/sections/[sectionKey]"
```

---

### Task 5.4: RLS smoke test for the new tables

**Files:**
- Create: `tests/integration/filings-schema.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, makeTestUserDb, newUserId, resetDb } from '../helpers/test-db';
import { companies, filings, filingChunks } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('RLS: filings + filing_chunks', () => {
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
    await svc.db.insert(filingChunks).values({
      filingId: '0000320193-24-000123', sectionKey: 'item_1_business',
      sectionTitle: 'Business', text: 'Apple does things.', charCount: 18
    });
  });

  it('authenticated role can SELECT filings + filing_chunks', async () => {
    const uid = newUserId();
    const result = await user.asUser(uid, async (tx) => {
      const f = await tx.select().from(filings);
      const c = await tx.select().from(filingChunks);
      return { fCount: f.length, cCount: c.length };
    });
    expect(result.fCount).toBe(1);
    expect(result.cCount).toBe(1);
  });

  it('authenticated role cannot INSERT into filings', async () => {
    const uid = newUserId();
    await expect(
      user.asUser(uid, async (tx) =>
        tx.insert(filings).values({
          accessionNo: 'X', ticker: 'AAPL', cik: 'X',
          formType: '10-K', filingDate: '2024-01-01', primaryDocUrl: 'https://x'
        })
      )
    ).rejects.toThrow();
  });

  it('authenticated role cannot INSERT into filing_chunks', async () => {
    const uid = newUserId();
    await expect(
      user.asUser(uid, async (tx) =>
        tx.insert(filingChunks).values({
          filingId: '0000320193-24-000123', sectionKey: 'x', sectionTitle: 'x', text: 'x', charCount: 1
        })
      )
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, verify passes**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/filings-schema.test.ts 2>&1 | tail -10
```
Expected: 3 passing.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add tests/integration/filings-schema.test.ts
git commit -m "test(db): RLS smoke for filings + filing_chunks"
```

---

## Milestone 6: UI

### Task 6.1: Filings list page + empty state

**Files:**
- Create: `app/(app)/stock/[ticker]/filings/page.tsx`
- Create: `app/(app)/stock/[ticker]/filings/loading.tsx`
- Create: `app/(app)/stock/[ticker]/_components/filings-empty-state.tsx`

- [ ] **Step 1: Write `app/(app)/stock/[ticker]/filings/page.tsx`**

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { companies } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { FilingsService } from '@/lib/services/filings';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';
import { FilingsEmptyState } from '../_components/filings-empty-state';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface PageProps { params: { ticker: string }; }

export default async function FilingsPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();

  const db = getServiceDb();
  const company = await db.select().from(companies).where(eq(companies.ticker, ticker)).limit(1);
  if (company.length === 0) notFound();

  const svc = new FilingsService({ db, provider: new SecEdgarProviderImpl() });
  const { filings: filingsList, needsIngest } = await svc.getList(ticker);

  return (
    <article className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
          <p className="text-sm text-muted-foreground">{company[0]!.name}</p>
        </div>
        <Tabs value="filings" className="hidden sm:block">
          <TabsList>
            <TabsTrigger value="overview" asChild><Link href={`/stock/${ticker}`}>Overview</Link></TabsTrigger>
            <TabsTrigger value="financials" asChild><Link href={`/stock/${ticker}/financials`}>Financials</Link></TabsTrigger>
            <TabsTrigger value="filings" asChild><Link href={`/stock/${ticker}/filings`}>Filings</Link></TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      {needsIngest ? (
        <FilingsEmptyState ticker={ticker} />
      ) : (
        <Card>
          <CardHeader><CardTitle>SEC Filings (last 5 years)</CardTitle></CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {filingsList.map((f) => (
                <li key={f.accessionNo} className="py-3 flex items-baseline justify-between">
                  <div>
                    <Link
                      href={`/stock/${ticker}/filings/${f.accessionNo}`}
                      className="font-medium hover:underline"
                    >
                      {f.formType} — filed {f.filingDate}
                    </Link>
                    {f.periodEnd && (
                      <span className="ml-3 text-sm text-muted-foreground">period ending {f.periodEnd}</span>
                    )}
                  </div>
                  <a
                    href={f.primaryDocUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    open on SEC ↗
                  </a>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </article>
  );
}
```

- [ ] **Step 2: Write `app/(app)/stock/[ticker]/filings/loading.tsx`**

```tsx
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-32" />
      <Skeleton className="h-64" />
    </div>
  );
}
```

- [ ] **Step 3: Write `app/(app)/stock/[ticker]/_components/filings-empty-state.tsx`**

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';

export function FilingsEmptyState({ ticker }: { ticker: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const { toast } = useToast();

  async function loadFilings() {
    setBusy(true);
    setProgress('Resolving CIK + fetching filings index from SEC…');
    try {
      const res = await fetch(`/api/tickers/${ticker}/filings`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast({
          title: 'Could not load filings',
          description: body.error ?? `HTTP ${res.status}`,
          variant: 'destructive'
        });
        setBusy(false);
        setProgress(null);
        return;
      }
      const summary = await res.json();
      toast({
        title: `Loaded ${summary.succeeded}/${summary.count} filings`,
        description: summary.failed > 0 ? `${summary.failed} failed (check logs)` : undefined
      });
      router.refresh();
    } catch (e: any) {
      toast({ title: 'Network error', description: String(e), variant: 'destructive' });
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>No filings loaded yet</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Click the button to fetch {ticker}&apos;s 10-K and 10-Q filings from SEC EDGAR (last 5 years).
          The first load takes 30-90 seconds. Subsequent visits are instant.
        </p>
        <Button onClick={loadFilings} disabled={busy}>
          {busy ? (progress ?? 'Loading…') : 'Load filings from SEC'}
        </Button>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Verify build / typecheck**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm typecheck 2>&1 | tail -3
```
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add 'app/(app)/stock/[ticker]/filings/' 'app/(app)/stock/[ticker]/_components/filings-empty-state.tsx'
git commit -m "feat(ui): filings list page + empty state with 'Load filings' button"
```

---

### Task 6.2: Single-filing reader page + section navigator

**Files:**
- Create: `app/(app)/stock/[ticker]/filings/[accession]/page.tsx`
- Create: `app/(app)/stock/[ticker]/filings/[accession]/_components/section-nav.tsx`

- [ ] **Step 1: Write `app/(app)/stock/[ticker]/filings/[accession]/page.tsx`**

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FilingsService } from '@/lib/services/filings';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';
import { SectionNav } from './_components/section-nav';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/;

interface PageProps { params: { ticker: string; accession: string }; }

export default async function FilingPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();
  if (!ACCESSION_RE.test(params.accession)) notFound();

  const svc = new FilingsService({ db: getServiceDb(), provider: new SecEdgarProviderImpl() });
  const result = await svc.getFiling(ticker, params.accession);
  if (!result) notFound();

  const { filing, sections } = result;

  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <Link
          href={`/stock/${ticker}/filings`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← back to {ticker} filings
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">
          {ticker} {filing.formType}
        </h1>
        <p className="text-sm text-muted-foreground">
          Filed {filing.filingDate}
          {filing.periodEnd && <> · period ending {filing.periodEnd}</>}
          {' · '}
          <a
            href={filing.primaryDocUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground"
          >
            open original on SEC ↗
          </a>
        </p>
      </header>

      {sections.length === 0 ? (
        <Card>
          <CardContent className="py-6">
            <p className="text-sm text-muted-foreground">
              No sections parsed for this filing. The parser may not have recognized
              this filing&apos;s structure.
            </p>
          </CardContent>
        </Card>
      ) : (
        <SectionNav ticker={ticker} accession={filing.accessionNo} sections={sections} />
      )}
    </article>
  );
}
```

- [ ] **Step 2: Write `app/(app)/stock/[ticker]/filings/[accession]/_components/section-nav.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

interface SectionRef {
  sectionKey: string;
  sectionTitle: string;
  charCount: number;
}

interface Props {
  ticker: string;
  accession: string;
  sections: SectionRef[];
}

export function SectionNav({ ticker, accession, sections }: Props) {
  const firstKey = sections[0]?.sectionKey ?? '';
  const [active, setActive] = useState(firstKey);
  const [textCache, setTextCache] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active || textCache[active] !== undefined) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/tickers/${ticker}/filings/${accession}/sections/${active}`)
      .then((r) => r.json())
      .then((d: { text: string }) => {
        if (!cancelled) {
          setTextCache((c) => ({ ...c, [active]: d.text ?? '' }));
        }
      })
      .catch(() => {
        if (!cancelled) setTextCache((c) => ({ ...c, [active]: '' }));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [active, accession, ticker, textCache]);

  if (sections.length === 0) return null;

  return (
    <Tabs value={active} onValueChange={setActive}>
      <TabsList className="flex flex-wrap h-auto">
        {sections.map((s) => (
          <TabsTrigger key={s.sectionKey} value={s.sectionKey}>
            {s.sectionTitle}
          </TabsTrigger>
        ))}
      </TabsList>
      {sections.map((s) => (
        <TabsContent key={s.sectionKey} value={s.sectionKey}>
          <Card>
            <CardContent className="py-6">
              {textCache[s.sectionKey] === undefined ? (
                <p className="text-sm text-muted-foreground">{loading ? 'Loading section…' : ''}</p>
              ) : textCache[s.sectionKey] === '' ? (
                <p className="text-sm text-muted-foreground">No text available for this section.</p>
              ) : (
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
                  {textCache[s.sectionKey]}
                </pre>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      ))}
    </Tabs>
  );
}
```

- [ ] **Step 3: Verify build / typecheck**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm typecheck 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add 'app/(app)/stock/[ticker]/filings/[accession]/'
git commit -m "feat(ui): single-filing reader with section navigator (lazy text fetch)"
```

---

### Task 6.3: Add "Filings" tab link to ticker dashboard

**Files:**
- Modify: `app/(app)/stock/[ticker]/page.tsx`
- Modify: `app/(app)/stock/[ticker]/financials/page.tsx`

The Overview and Financials pages have a Tabs widget with "Overview" + "Financials". Add a third tab for "Filings."

- [ ] **Step 1: Read the existing `page.tsx` to find the Tabs block**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
grep -n "Tabs" 'app/(app)/stock/[ticker]/page.tsx'
grep -n "Tabs" 'app/(app)/stock/[ticker]/financials/page.tsx'
```

- [ ] **Step 2: In both files, find the existing Tabs block:**

```tsx
<Tabs value="overview" className="hidden sm:block">
  <TabsList>
    <TabsTrigger value="overview" asChild><Link href={`/stock/${ticker}`}>Overview</Link></TabsTrigger>
    <TabsTrigger value="financials" asChild><Link href={`/stock/${ticker}/financials`}>Financials</Link></TabsTrigger>
  </TabsList>
</Tabs>
```

And replace with:

```tsx
<Tabs value="overview" className="hidden sm:block">
  <TabsList>
    <TabsTrigger value="overview" asChild><Link href={`/stock/${ticker}`}>Overview</Link></TabsTrigger>
    <TabsTrigger value="financials" asChild><Link href={`/stock/${ticker}/financials`}>Financials</Link></TabsTrigger>
    <TabsTrigger value="filings" asChild><Link href={`/stock/${ticker}/filings`}>Filings</Link></TabsTrigger>
  </TabsList>
</Tabs>
```

Same change in `financials/page.tsx` but with `value="financials"` (already there). Just add the Filings trigger.

- [ ] **Step 3: Verify build**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm typecheck 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add 'app/(app)/stock/[ticker]/page.tsx' 'app/(app)/stock/[ticker]/financials/page.tsx'
git commit -m "feat(ui): add Filings tab to ticker dashboard nav"
```

---

## Milestone 7: Smoke test + verification

### Task 7.1: `scripts/try-filings.ts`

**Files:**
- Create: `scripts/try-filings.ts`

- [ ] **Step 1: Write the script**

```ts
#!/usr/bin/env tsx
/**
 * End-to-end smoke test: `pnpm try-filings AAPL`
 *
 * Resolves CIK, lists 10-K + 10-Q for last 5y, fetches+parses each,
 * prints per-filing section counts and the first 100 chars of MD&A.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';

async function main() {
  const ticker = (process.argv[2] ?? '').toUpperCase();
  if (!/^[A-Z][A-Z.]{0,5}$/.test(ticker)) {
    console.error('Usage: pnpm try-filings <TICKER>');
    process.exit(2);
  }

  const provider = new SecEdgarProviderImpl({ useHttp: false });

  console.log(`\nResolving CIK for ${ticker}…`);
  const cik = await provider.resolveCik(ticker);
  console.log(`  CIK: ${cik}`);

  console.log(`\nListing 10-K + 10-Q filings (last 5Y)…`);
  const list = await provider.listFilings(cik, ['10-K', '10-Q'], 5);
  console.log(`  ${list.filings.length} filings`);

  for (const f of list.filings.slice(0, 5)) {
    console.log(`\n[${f.formType} ${f.filingDate}] ${f.accessionNo}`);
    try {
      const full = await provider.fetchFiling(f.primaryDocUrl, f.formType);
      console.log(`  ${full.sections.length} sections, ${full.totalChars} total chars`);
      for (const s of full.sections) {
        console.log(`    • ${s.section_title} (${s.text.length} chars)`);
      }
      const mdna = full.sections.find((s) => s.section_key.endsWith('mdna'));
      if (mdna) {
        const preview = mdna.text.slice(0, 100).replace(/\s+/g, ' ');
        console.log(`  MD&A preview: ${preview}…`);
      }
    } catch (err) {
      console.error(`  FAILED: ${err}`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('try-filings failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add to `package.json` scripts**

Find the existing `"try": "tsx scripts/try-snapshot.ts"` line and add right after:

```json
"try-filings": "tsx scripts/try-filings.ts",
```

- [ ] **Step 3: Run against live SEC**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm try-filings AAPL
```

Expected output (truncated):
```
Resolving CIK for AAPL…
  CIK: 0000320193

Listing 10-K + 10-Q filings (last 5Y)…
  25 filings

[10-K 2024-11-01] 0000320193-24-000123
  5 sections, 245132 total chars
    • Business (43221 chars)
    • Risk Factors (52410 chars)
    ...
  MD&A preview: Item 7. Management's Discussion and Analysis of Financial Condition and Results of Operations…
```

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add scripts/try-filings.ts package.json
git commit -m "chore(scripts): pnpm try-filings <TICKER> smoke test"
```

---

### Task 7.2: Push + Vercel verification + manual browser smoke test

**Files:** none (verification only)

- [ ] **Step 1: Push everything**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git push origin master
```

GitHub Actions will run (CI is green-gated). Vercel will auto-deploy. Wait ~3-5 min.

- [ ] **Step 2: Verify Vercel Python function deployed**

In Vercel dashboard → your project → Functions tab. You should now see:
- Existing functions (Node.js routes + `api/fallback/yfinance.py`)
- **NEW: `api/fallback/sec.py`**

If the new Python function isn't there, check the deployment logs for `requirements.txt` issues.

- [ ] **Step 3: Smoke test the live Python function**

```powershell
Invoke-RestMethod 'https://YOUR-DEPLOY-URL/api/fallback/sec?kind=resolve_cik&ticker=AAPL'
```

Expected: `{ cik: '0000320193' }`.

- [ ] **Step 4: Browser smoke test**

1. Navigate to https://YOUR-DEPLOY-URL/stock/AAPL/filings (sign in if needed).
2. See empty state with "Load filings from SEC" button.
3. Click button. Wait ~30-90s.
4. See list of ~25 filings populated.
5. Click one. Land on reader page.
6. Click a section tab (e.g., "Business"). Text loads.
7. Test a non-seed ticker: navigate to /stock/JD/filings. Click load. Same flow.

- [ ] **Step 5: Verify CI is green for the merged commit**

```powershell
gh run list --limit 1
```
Expected: ✓ for the latest commit.

- [ ] **Step 6: No commit — this task is verification only**

---

## Slice 2A — Completion checklist

After all tasks above pass, verify the slice is done:

- [ ] All unit tests pass: `pnpm test` (existing 73 + 8 new = 81)
- [ ] All integration tests pass: `pnpm test:integration` (existing 61 + 7 service + 8 api + 3 rls = 79)
- [ ] Typecheck clean: `pnpm typecheck`
- [ ] Lint clean: `pnpm lint`
- [ ] `pnpm build` succeeds
- [ ] Smoke test works: `pnpm try-filings AAPL` succeeds against live SEC
- [ ] Browser flow: visit `/stock/AAPL/filings`, click "Load", see populated list, click into a filing, read a section
- [ ] Same browser flow works on a non-seed ticker (e.g., JD, NIO)
- [ ] Vercel deploy live + Python function reachable at `/api/fallback/sec`
- [ ] GitHub Actions CI green on `main`

When all boxes are checked, Slice 2A is complete and Slice 2B (LLM TLDR) can be planned.

---

## Slice 2A — What's NOT in here (deliberate)

- LLM summarization, TLDR generation, red-flag detection → Slice 2B
- Embeddings + semantic search → Slice 2C
- 8-K, DEF 14A, S-1 ingestion → Slice 2.5
- Background / scheduled re-ingestion (filings stay frozen until user re-clicks) → Slice 4
- SSE-based progress UI (polling-based is good enough) → Slice 2.5
- Python parser unit tests in CI → Slice 2.5
- Playwright E2E for filings UI (auth fixture still broken) → Slice 2.5
- Custom-domain deep links to specific sections from external apps → unclear if needed

Each is queued for the slice indicated. The skeleton built in 2A (provider adapter, service layer, schema) supports all of them as additive work — no refactors needed.
