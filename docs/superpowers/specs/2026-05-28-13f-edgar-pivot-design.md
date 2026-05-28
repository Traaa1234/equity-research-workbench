# 13F Institutional Holdings — EDGAR Pivot Design Spec

> **Status:** Design complete. Replaces the FD data source in `2026-05-28-13f-holdings-design.md` with SEC EDGAR raw 13F-HR XML. Schema, compute, UI shape all stay.
> **Date:** 2026-05-28
> **Owner:** Equity Research Workbench
> **Supersedes data-source choice in:** `docs/superpowers/specs/2026-05-28-13f-holdings-design.md`

---

## Why the pivot

Shipped the 13F slice using Financial Datasets `/institutional-ownership/?ticker=X`. During T8 rollout smoke we discovered two blocking issues:

1. **FD's by-ticker endpoint returns only the alphabetical first 200 filers per ticker.** There is no sort, no offset, no cursor, no pagination. The biggest holders (Vanguard, BlackRock, State Street, Berkshire) never appear because they're alphabetically beyond the cutoff. We verified this with direct probes against the live API.
2. **FD account balance is $0.00.** Even if pagination existed, every refresh would 402.

The slice's schema, compute, service shape, and UI are correctly designed and work. Only the data source is wrong. This pivot replaces FD with SEC EDGAR raw 13F-HR XML — the canonical free source — while keeping everything else.

## Goal

Surface SEC Form 13F institutional ownership per ticker by tracking a curated set of ~45 well-known active managers and index giants. Refresh from raw SEC 13F-HR filings via a Python serverless extension. Same Overview card + `/holdings` tab + 9-tab nav as the FD design, with UI copy relabeled to "Tracked investors."

## Non-goals

- **Tracking every 13F filer** — the long tail of ~1500 alphabetical filers is gone. We track ~45 curated managers.
- **User-configurable tracked-investor lists.** The list stays a code constant.
- **Cron / nightly ingestion.** Manual Refresh button only.
- **Cross-investor views** ("biggest AAPL adders this quarter").
- **CUSIP discovery API.** Watchlist CUSIPs are hardcoded.
- **Holder-side detail pages** (clicking through to Berkshire's full portfolio).
- **Switching back to FD when credits are restored.** EDGAR is the better source even when FD works.

## User value

13F-HR is the canonical SEC source for institutional positions. Filed quarterly within 45 days of quarter-end. By tracking a curated set of ~30 well-known active managers (Berkshire, Tiger, Renaissance, Pershing Square, etc.) plus ~15 index-AUM giants (Vanguard, BlackRock, State Street, etc.), we surface:

1. **At a glance (Overview card):** "X of 45 tracked investors hold this," top-10 share-of-tracked, smart-money moves count, as-of date.
2. **Quarter-by-quarter (`/holdings` tab):** full tracked-investor list with QoQ deltas, smart-money callout, 8-quarter breadth-trend sparkline.
3. **Smart-money tracking:** explicit highlighting of moves by the ~30 curated active managers.

What the user loses vs. the original FD design:
- Total filer count ("1,247 funds hold AAPL") — replaced with "23 of 45 tracked investors hold AAPL."
- Long-tail-fund visibility — small/midsize funds outside the curated list are not tracked.

What the user gains:
- **The smart-money signal actually works.** Berkshire, Tiger, Pershing Square, etc., are guaranteed to appear when they hold the ticker.
- **Top-10 concentration becomes meaningful** (within the tracked set, with Vanguard/BlackRock/State Street included).
- **No FD dependency** for this feature — no credit burn, no broken endpoint, no paywalls.
- **Every row gets a correct QoQ delta** — the FD design had a limitation where non-smart-money rows defaulted to "unchanged" because we lacked join data. Now we have full prev-quarter data for every tracked investor.

## Architecture

```
                ┌─────────────────────────────────────────┐
                │ Refresh button on /stock/[ticker]/      │
                │ holdings ("Refresh tracked investors")  │
                └──────────────────┬──────────────────────┘
                                   │
                ┌──────────────────▼──────────────────────┐
                │ POST /api/holdings/refresh-tracked      │
                │ (no ticker param — refreshes all)       │
                └──────────────────┬──────────────────────┘
                                   │
                ┌──────────────────▼──────────────────────┐
                │ HoldingsService.refreshTrackedInvestors │
                │                                         │
                │  for each cik in 45 curated investors:  │
                │    call Python serverless               │
                │    parse positions[]                    │
                │    filter to watchlist CUSIPs           │
                │    upsert rows                          │
                │  prune to 8-quarter window              │
                │  write one refresh_runs row             │
                └──────────────────┬──────────────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              │                                         │
   ┌──────────▼──────────┐              ┌──────────────▼──────────────┐
   │ api/fallback/sec.py │              │  CUSIP → ticker mapping     │
   │  ?kind=thirteen_f   │              │  (hardcoded for 6 tickers,  │
   │  &cik=0001067983    │              │   easy to extend)           │
   │                     │              └─────────────────────────────┘
   │ - fetch index.json  │
   │ - find latest 13F-HR│
   │ - download xml      │
   │ - parse positions   │
   │ - return JSON       │
   └─────────────────────┘
                                   │
                ┌──────────────────▼──────────────────────┐
                │ Same DB table: institutional_holdings   │
                │ (no schema changes — investorId is the  │
                │  zero-padded CIK from EDGAR)            │
                └──────────────────┬──────────────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              │                                         │
   ┌──────────▼─────────┐                    ┌──────────▼─────────┐
   │ Overview card      │                    │ /stock/[ticker]/   │
   │ <HoldingsCard>     │                    │ holdings tab       │
   │ (unchanged code,   │                    │ (unchanged code,   │
   │  relabeled copy)   │                    │  relabeled copy)   │
   └────────────────────┘                    └────────────────────┘
```

### What stays unchanged

- `institutional_holdings` table + RLS policy
- `lib/compute/smart-money.ts` (30 curated managers + 15 index giants + `matchSmartMoney` + `normalizeInvestorName` + `getReverseLookupCiks`)
- `lib/compute/holdings-aggregate.ts` (classifyDelta, joinHoldersWithDeltas, computeHoldingsAggregate)
- `HoldingsService.getList`, `.getAggregate`, `.listAvailablePeriods`
- 5 UI components — only copy/labels change

### What changes

- Python `api/fallback/sec.py` gets a new `kind=thirteen_f_filings` handler
- `lib/providers/sec-edgar.ts` gets a new `thirteenFFilings(cik)` method
- `lib/compute/cusip-map.ts` is a new file
- `HoldingsService.refresh()` becomes `HoldingsService.refreshTrackedInvestors()` (no ticker arg; iterates the curated CIKs; deps changes from `fdProvider` to `secProvider`)
- New API route `POST /api/holdings/refresh-tracked`
- Existing `app/api/tickers/[symbol]/holdings/route.ts` — POST handler deleted, GET kept
- `scripts/try-13f.ts` — no ticker arg, calls the global refresh
- UI labels/copy updated per "UI relabeling" section below

### What gets deleted (dead code from the FD design)

- `FinancialDatasetsProvider.institutionalOwnership()` method
- `HoldingsMeta` interface in `lib/providers/types.ts`
- `lib/providers/__fixtures__/fd-institutional-ownership-aapl.json`
- `.institutionalOwnership()` describe block (5 tests) in `tests/providers/financial-datasets.test.ts`

## Python serverless endpoint

Extends the existing `api/fallback/sec.py` with a new `kind` value.

**Request:** `GET /api/fallback/sec?kind=thirteen_f_filings&cik=<CIK>`

- `cik` — required, 10-digit zero-padded SEC CIK

**Response shape (HTTP 200):**

```json
{
  "cik": "0001067983",
  "investor_name": "BERKSHIRE HATHAWAY INC",
  "filings": [
    {
      "accession": "0001067983-26-000001",
      "filing_date": "2026-05-14",
      "report_period": "2026-03-31",
      "form_type": "13F-HR",
      "positions": [
        {
          "cusip": "037833100",
          "issuer_name": "APPLE INC",
          "class_title": "COM",
          "value_usd": 263012040000,
          "shares": 905560000,
          "shares_type": "SH"
        }
      ]
    }
  ]
}
```

**Implementation steps inside the handler:**

1. Call `https://data.sec.gov/submissions/CIK{cik}.json` (where `{cik}` is the zero-padded form) to get the investor's filing index and the canonical `name` (used as `investor_name`).
2. Filter the recent filings list for `form in ('13F-HR', '13F-HR/A')`. Take the most recent 8 entries.
3. For each filing, fetch the filing's index page at `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=13F-HR&dateb=&owner=include&count=40&action=getcompany` OR (simpler) construct the index URL: `https://www.sec.gov/Archives/edgar/data/{cik_no_zeros}/{accession_no_dashes}/`. List the directory, find the file matching `*_informationtable.xml` (case-insensitive; SEC's naming varies — common patterns: `informationtable.xml`, `<accession>_informationtable.xml`).
4. Download the InformationTable XML. Parse with `BeautifulSoup` (already imported). Each `<infoTable>` element contains:
   - `<nameOfIssuer>` — `issuer_name`
   - `<titleOfClass>` — `class_title`
   - `<cusip>` — 9-char CUSIP
   - `<value>` — value in thousands of USD. **MULTIPLY BY 1000** when returning `value_usd`.
   - `<shrsOrPrnAmt><sshPrnamt>` — shares
   - `<shrsOrPrnAmt><sshPrnamtType>` — typically "SH" (shares) or "PRN" (principal amount for bonds; ignore for equity 13Fs)
5. Return the JSON above.

**Existing rate-limit machinery** (`MIN_INTERVAL_SECONDS = 0.21`, `USER_AGENT`) applies automatically. A single investor's refresh makes 2-9 SEC HTTP calls (1 for submissions index + 1 per filing's directory + 1 per InformationTable). Worst case ~2 seconds per investor.

**Error handling:**
- If the investor doesn't have any 13F-HR filings (smaller managers that fall under $100M AUM): return `{ cik, investor_name, filings: [] }` with HTTP 200. Empty is normal.
- If SEC returns 404 for the submissions JSON: HTTP 404 with `{ error: "investor not found", kind: "thirteen_f_filings" }`.
- If a single InformationTable fails to parse: skip that filing, log a warning, continue with the rest. Don't fail the whole request.

## TS provider adapter

Extend `lib/providers/sec-edgar.ts` with one new method:

```ts
interface ThirteenFPosition {
  cusip: string;
  issuerName: string;
  classTitle: string;
  valueUsd: number;
  shares: number;
  sharesType: string;
}

interface ThirteenFFiling {
  accession: string;
  filingDate: string;          // YYYY-MM-DD
  reportPeriod: string;        // YYYY-MM-DD (quarter-end)
  formType: string;
  positions: ThirteenFPosition[];
}

interface ThirteenFInvestor {
  cik: string;
  investorName: string;
  filings: ThirteenFFiling[];
}

class SecEdgarProvider {
  // ... existing methods (resolveCik, listFilings, fetchFiling, etc.)
  async thirteenFFilings(cik: string): Promise<ThirteenFInvestor>;
}
```

The method calls the Python serverless via the existing fetch helper. snake_case → camelCase mapping happens at this boundary. Errors map to the standard `NotFoundError` / `RateLimitError` / generic Error pattern.

## CUSIP↔ticker mapping

New file `lib/compute/cusip-map.ts`:

```ts
export const CUSIP_BY_TICKER: Readonly<Record<string, string>> = {
  AAPL:  '037833100',
  NVDA:  '67066G104',
  MSFT:  '594918104',
  GOOGL: '02079K305',     // Class A; GOOG is 02079K107 — Class A only in watchlist
  TSLA:  '88160R101',
  JD:    '47215P106'
};

const TICKER_BY_CUSIP: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CUSIP_BY_TICKER).map(([t, c]) => [c, t])
);

export function tickerForCusip(cusip: string): string | null {
  return TICKER_BY_CUSIP[cusip.toUpperCase()] ?? null;
}

export function watchlistCusips(): string[] {
  return Object.values(CUSIP_BY_TICKER);
}
```

To add a watchlist ticker: append one line to `CUSIP_BY_TICKER`. CUSIPs are looked up once at SEC EDGAR (`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=<ticker>`) and never change for a given security.

## Service refactor

`lib/services/holdings.ts` changes:

**Constructor deps change:**

```ts
interface Deps {
  db: ServiceDb;
  secProvider: SecHoldingsProvider;     // was: fdProvider: FdHoldingsProvider
}

interface SecHoldingsProvider {
  thirteenFFilings(cik: string): Promise<ThirteenFInvestor>;
}
```

**`refresh()` replaced with `refreshTrackedInvestors()`:**

```ts
interface TrackedInvestorRefreshSummary {
  investorsAttempted: number;
  investorsSucceeded: number;
  investorsFailed: number;
  newRows: number;
  prunedRows: number;
  durationMs: number;
}

async refreshTrackedInvestors(): Promise<TrackedInvestorRefreshSummary> {
  const ciks = getReverseLookupCiks();         // 45 CIKs from smart-money.ts
  const watchlistCusipSet = new Set(watchlistCusips());
  const inserts: Array<typeof institutionalHoldings.$inferInsert> = [];
  let succeeded = 0, failed = 0;

  for (const cik of ciks) {
    try {
      const investor = await this.deps.secProvider.thirteenFFilings(cik);
      succeeded++;
      for (const filing of investor.filings) {
        for (const pos of filing.positions) {
          if (!watchlistCusipSet.has(pos.cusip)) continue;
          const ticker = tickerForCusip(pos.cusip);
          if (!ticker) continue;
          const sharesStr = numToStr(pos.shares);
          if (sharesStr == null) continue;
          inserts.push({
            ticker,
            investorId: cik.padStart(10, '0'),
            investorName: investor.investorName,
            reportPeriod: filing.reportPeriod,
            shares: sharesStr,
            marketValue: numToStr(pos.valueUsd),
            sharesPctOfPortfolio: null,
            sharesPctOfShareholders: null,
            filingDate: filing.filingDate
          });
        }
      }
    } catch (err) {
      failed++;
      logger.warn({ cik, err: String(err) }, 'refreshTrackedInvestors: investor fetch failed');
    }
  }

  let newRows = 0;
  if (inserts.length > 0) {
    const before = await this.countTotalRows();
    await this.deps.db.insert(institutionalHoldings).values(inserts).onConflictDoNothing();
    const after = await this.countTotalRows();
    newRows = after - before;
  }

  const prunedRows = await this.pruneAllTickersTo8Q();

  await this.deps.db.insert(refreshRuns).values({
    ticker: '*',                           // sentinel for global refresh
    kind: 'holdings',
    startedAt,
    completedAt: new Date(),
    ok: true,
    sourceUsed: 'sec_edgar'
  });

  return { investorsAttempted: ciks.length, investorsSucceeded: succeeded, investorsFailed: failed, newRows, prunedRows, durationMs: Date.now() - started };
}
```

**Helper methods needed:**
- `private async countTotalRows(): Promise<number>` — `SELECT COUNT(*) FROM institutional_holdings` (across all tickers).
- `private async pruneAllTickersTo8Q(): Promise<number>` — for each ticker in `CUSIP_BY_TICKER`, find latest period, prune rows where `report_period < (latest - 90*8 days)`. Sums and returns total deleted.

**Use of `ticker = '*'` in refresh_runs:** the existing schema requires `ticker NOT NULL`. Rather than a schema migration, use `'*'` as a sentinel for "global refresh." Acceptable YAGNI compromise — refresh_runs is observational, not load-bearing.

**`getList`, `getAggregate`, `listAvailablePeriods`:** unchanged.

**Service test rewrites:** `tests/integration/holdings-service.test.ts` is largely rewritten. New mock provider shape: `mockSecProvider(perCikResponses: Record<string, ThirteenFInvestor>)`. Six new test cases listed in the testing matrix below.

## API routes

**New route — `app/api/holdings/refresh-tracked/route.ts`:**

```ts
export async function POST() {
  try {
    const userId = await requireUserId();
    if (!(await rateLimit(userId))) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '3600' } });
    }
    const summary = await service().refreshTrackedInvestors();
    return ok(summary);
  } catch (err) {
    return errorResponse(err, { route: 'holdings/refresh-tracked POST' });
  }
}
```

**Rate limit:** 5 requests per hour per user (key `ratelimit:holdings-refresh-global:{userId}`). 13F filings update quarterly, so even a few refreshes per day per user is generous.

**Existing route — `app/api/tickers/[symbol]/holdings/route.ts`:**
- GET handler stays as-is (serves the per-ticker page).
- POST handler deleted entirely.

## UI relabeling

All 5 components keep their visual structure. Only labels/copy change.

**`<HoldingsCard>` (Overview compact):**
- Title: `Institutional holdings` → `Tracked investor holdings`
- "Holders" row label: `Holders` → `Tracked holding`
- Value display: `1,247 funds` → `23 of 45 tracked`
- Empty state: `No 13F data fetched yet. Visit the Holdings tab to refresh.` → `No tracked investor data yet. Visit the Holdings tab to refresh.`

**`<HoldingsAggregatePanel>` (`/holdings` page):**
- Section title: `Summary as of YYYY-MM-DD` → `Tracked investors as of YYYY-MM-DD`
- "Total holders" → `Tracked investors holding`
- "Top-10 concentration" → `Top-10 share-of-tracked` (tooltip: *"Concentration within our 45 tracked managers, not total float."*)
- "Total market value" — unchanged label
- "New positions" / "Exits" — unchanged labels (now means new/exited within the tracked set)
- Breadth-trend chart caption: `Holder count trend (8 quarters)` → `Tracked investor breadth (out of 45, 8 quarters)`

**`<SmartMoneyCallout>`:** unchanged. Title stays `⚡ Smart-money moves this quarter`. This component was always designed for the curated list — now the data source matches the design.

**`<HolderRow>`:** unchanged structure. The visual layout works identically. **Behavior improvement:** the previous T6 limitation where non-smart-money rows always showed `delta='unchanged'` (because we lacked join data for them) goes away — every row now gets a correct delta because the service has full prev-quarter data for every tracked investor.

**`<HoldingsView>` (client wrapper):**
- Refresh button: `Refresh` → `Refresh tracked investors` (tooltip on hover: *"Updates all tracked managers across all watchlist tickers (~10s)"*).
- Filter dropdown: **drop the "Smart money only" option.** Every row is now smart-money or index-giant, so the filter doesn't distinguish anything useful. Final filter options: `All holders / Additions only / Reductions only / New positions only / Exits only`. 5 options instead of 6.
- Period selector: unchanged.
- 200-holders truncation footer: **delete entirely.** The natural max is 45 holders per ticker per quarter, well under 200.

**`<DashboardTabs>`:** tab label stays `Holdings` (not `Tracked Holdings`) — short label fits the visual rhythm, page content sets the framing.

**Compute layer simplification (opportunistic):** with full prev-quarter data available for all rows, we can remove the `HoldingPlus` interface workaround in `HoldingsView`. The service should return rows pre-joined with delta information. Suggested simplification: add an `EnrichedHolding` type that extends `InstitutionalHolding` with `delta`, `sharesPrev`, `isSmartMoney`, `smartMoneyCategory`; update `getList` to return `EnrichedHolding[]`; delete the `HoldingPlus` interface from `holdings-view.tsx`. This is a small, well-contained cleanup that lives naturally in this slice — not unrelated refactoring.

## File structure changes

| File | Action |
|---|---|
| `api/fallback/sec.py` | Modify — add `thirteen_f_filings` handler |
| `lib/providers/sec-edgar.ts` | Modify — add `thirteenFFilings(cik)` method + types |
| `lib/providers/financial-datasets.ts` | Modify — delete `institutionalOwnership()` method |
| `lib/providers/types.ts` | Modify — delete `HoldingsMeta` interface |
| `lib/providers/__fixtures__/fd-institutional-ownership-aapl.json` | Delete |
| `lib/providers/__fixtures__/sec-13f-berkshire-2026q1.xml` | Create — fixture for parser test |
| `lib/compute/cusip-map.ts` | Create |
| `lib/services/holdings.ts` | Rewrite — `refreshTrackedInvestors` replaces `refresh` |
| `app/api/holdings/refresh-tracked/route.ts` | Create |
| `app/api/tickers/[symbol]/holdings/route.ts` | Modify — delete POST handler |
| `scripts/try-13f.ts` | Modify — no ticker arg, call global refresh |
| `app/(app)/stock/[ticker]/_components/holdings-card.tsx` | Modify — relabel |
| `app/(app)/stock/[ticker]/holdings/_components/holdings-aggregate-panel.tsx` | Modify — relabel |
| `app/(app)/stock/[ticker]/holdings/_components/holdings-view.tsx` | Modify — relabel + drop smart-money filter + use EnrichedHolding |
| `tests/providers/financial-datasets.test.ts` | Modify — delete `.institutionalOwnership()` describe block (5 tests) |
| `tests/providers/sec-edgar.test.ts` | Modify — add `.thirteenFFilings()` describe block (3 tests) |
| `tests/compute/cusip-map.test.ts` | Create — 3 tests |
| `tests/integration/holdings-service.test.ts` | Rewrite — new mock shape, 6 tests |
| `tests/integration/api-tickers-holdings.test.ts` | Modify — drop POST tests, keep GET tests (4 tests) |
| `tests/integration/api-holdings-refresh-tracked.test.ts` | Create — 2 tests |
| `tests/integration/institutional-holdings-rls.test.ts` | Unchanged |
| `api/fallback/sec.py` | Modify — add inline assertion test at the bottom |

## Testing matrix

| Layer | Test file | Coverage |
|---|---|---|
| Python | `api/fallback/sec.py` inline assertion | Parse Berkshire fixture: positions count, AAPL cusip presence, shares + value math (value × 1000), filter to most-recent 8 13F-HRs. 3 assertions. |
| TS provider | `tests/providers/sec-edgar.test.ts` | `thirteenFFilings(cik)` URL building, JSON parse to camelCase, error mapping (404, 5xx). 3 tests. |
| Compute | `tests/compute/cusip-map.test.ts` | `tickerForCusip` (known + unknown), `watchlistCusips()` returns 6 entries, case insensitivity. 3 tests. |
| Service | `tests/integration/holdings-service.test.ts` | `refreshTrackedInvestors` happy path (mock 3 investors × 2 filings each across 2 watchlist tickers), idempotency, prune to 8Q, skip non-watchlist CUSIPs, 1-investor partial failure continues, records refresh_runs row with ticker='*' kind='holdings'. 6 integration tests. |
| API (new) | `tests/integration/api-holdings-refresh-tracked.test.ts` | POST happy path inserts rows, 429 rate-limit. 2 tests. |
| API (existing) | `tests/integration/api-tickers-holdings.test.ts` | Drop POST tests; keep GET empty, GET with data, GET 400 invalid ticker, GET 400 invalid period. 4 tests. |
| RLS | `tests/integration/institutional-holdings-rls.test.ts` | Unchanged. 2 tests. |

Net new tests: ~19. Net deleted: ~8 (5 FD + 3 per-ticker POST). Compute unit tests for `holdings-aggregate.test.ts` and `smart-money.test.ts` remain green — those modules don't change.

## Rollout

1. Implement, push, watch CI to green.
2. Local smoke: `pnpm try-13f` (no ticker arg). Expect ~10 seconds for ~45 investors, expect 5-15 to return empty (managers under $100M AUM or who don't file). Expect 30-40 successful filings across the watchlist.
3. Vercel deploy. The Python serverless `sec.py` change requires a new deployment to pick up the new `kind` handler. Existing 10-K / 10-Q handlers are unaffected — only added a code path.
4. Browser smoke on the 6 watchlist tickers:
   - AAPL: Overview card shows `~20 of 45 tracked`, top-10 dominated by Vanguard/BlackRock/State Street (with the actual largest position counts), Berkshire visible in the smart-money callout.
   - NVDA: Tiger Global, Coatue, Viking visible; Berkshire absent.
   - MSFT: similar shape to AAPL.
   - GOOGL: similar shape to AAPL (some growth managers may overweight here).
   - TSLA: Coatue, ARK visible; index-giant concentration lower than for AAPL/MSFT.
   - JD: very few tracked investors hold this (it's a Chinese ADR). Empty-or-thin state. Expected.

## Risks and mitigations

- **EDGAR rate-limit.** SEC's stated max is 10 req/sec with a proper User-Agent. Our `MIN_INTERVAL_SECONDS = 0.21` keeps us at ~5 req/sec — safe margin. A single user refreshing twice in quick succession won't cause issues; concurrent users could in theory, but our manual-refresh model makes that rare.
- **InformationTable XML naming variation.** SEC's filename pattern for InformationTable XML varies (`informationtable.xml`, `<accession>_informationtable.xml`, sometimes capitalized). The Python parser does a case-insensitive `*informationtable*` glob on the filing's directory listing. Fixture-driven testing covers the parser logic; the directory-listing logic is naturally robust to filename variation.
- **CUSIP class ambiguity.** GOOGL Class A (`02079K305`) vs GOOG Class C (`02079K107`) are different securities. Only GOOGL Class A is in the watchlist — documented in `cusip-map.ts`. If a fund holds GOOG Class C, that position is correctly ignored (it's not for the watchlisted GOOGL).
- **Some tracked investors don't file 13F every quarter.** Hound Partners, Eminence Capital, and similar smaller managers may fall below the $100M AUM threshold occasionally. The Python parser returns `filings: []` for these — service handles empty gracefully.
- **Investor name drift.** SEC sometimes changes how a fund's name appears across filings ("BERKSHIRE HATHAWAY INC" vs "BERKSHIRE HATHAWAY INC."). We use the CIK as the primary key (`investorId`), so name drift doesn't break dedup. The `investorName` field stores the most recent observed name.
- **`refresh_runs.ticker = '*'` sentinel.** Non-blocking — refresh_runs is observational. If anyone later queries it expecting real ticker values, they'll need to filter `WHERE ticker <> '*'` or similar.

## Success criteria

- `pnpm try-13f` completes in <15 seconds, with most of the 45 investors returning filings.
- Overview card on /stock/AAPL shows a realistic "N of 45 tracked" count, top-10 includes Vanguard or BlackRock at the top.
- /stock/AAPL/holdings page shows Berkshire's positions correctly across the last few quarters.
- Smart-money callout fires on multiple tickers when curated managers have new/added/reduced/sold-out deltas in the latest available quarter.
- Refresh button label clearly conveys "this is a global refresh."
- All tests pass (target ~21 new tests + ~8 deleted).
- Vercel deploy doesn't break the existing 10-K / 10-Q ingestion (no regressions in Slice 2A's tests).
