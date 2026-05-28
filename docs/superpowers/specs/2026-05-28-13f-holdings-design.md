# 13F Institutional Holdings — Design Spec

> **Status:** Design complete. Implementation plan to follow.
> **Date:** 2026-05-28
> **Owner:** Equity Research Workbench

---

## Goal

Surface SEC Form 13F institutional ownership per ticker — which mutual funds and hedge funds hold the stock, in what size, how that's changed over the last 8 quarters, and which moves come from a curated "smart money" list of well-known managers.

## Non-goals

- **Cross-ticker views.** "Which of my watchlist tickers had the most smart-money buying this quarter?" is a different surface (would live on `/watchlist`) and is out of scope.
- **User-configurable smart-money lists.** The list lives in code as a hard-coded constant. CRUD UI is explicitly excluded.
- **Holder-side detail pages.** Clicking through to "all positions Berkshire holds" is a separate ingestion problem (ticker-keyed vs. CIK-keyed) and a follow-up slice.
- **Cron / nightly auto-refresh.** Same as Insider Trades — manual Refresh button + `try-13f` script.
- **Sector / industry breakdowns of holders.**
- **LLM commentary on the holder list.** Glyph and category chips do the disambiguation work.

## User value

13F is the cleanest signal of "what professional money is doing with this stock," at the cost of being ~6 weeks stale when fresh and 4+ months stale at the end of a quarter. The slice gives three layered views:

1. **At a glance (Overview card):** holder count, top-10 concentration, smart-money moves count, currency-of-data date.
2. **Quarter-by-quarter (`/holdings` tab):** the full top-200 holder list with QoQ deltas (new / added / reduced / sold-out / unchanged), smart-money callout block, breadth-trend sparkline.
3. **Smart-money tracking:** explicit highlighting when a curated list of ~30 well-known managers (Berkshire, Tiger, Renaissance, Pershing Square, etc.) changes a position.

Useful for: trend confirmation, conviction checks against your own thesis, spotting smart-money rotations. Not useful for: timing entries, anything intraday. The UI design makes that asymmetry obvious by leading with the "As of YYYY-MM-DD" date.

## Architecture

```
                          ┌──────────────────────────────┐
                          │ FD /institutional-ownership/ │
                          └──────────────┬───────────────┘
                                         │ HoldingsMeta[]
                          ┌──────────────▼───────────────┐
                          │   HoldingsService.refresh    │
                          │     (idempotent dedupe       │
                          │      via composite UK)       │
                          └──────────────┬───────────────┘
                                         │
                          ┌──────────────▼───────────────┐
                          │  Postgres institutional_     │
                          │  holdings (one row per       │
                          │  ticker × fund × quarter)    │
                          └──────────────┬───────────────┘
                                         │ getList / getAggregate
                          ┌──────────────▼───────────────┐
                          │ lib/compute/holdings-        │
                          │ aggregate.ts (pure)          │
                          │ - breadth, top-N, deltas,    │
                          │   smart-money moves          │
                          └──────────────┬───────────────┘
                                         │
                  ┌──────────────────────┴─────────────────────┐
                  │                                            │
        ┌─────────▼─────────┐                       ┌──────────▼─────────┐
        │ Overview card     │                       │ /stock/[ticker]/   │
        │ <HoldingsCard>    │                       │ holdings page      │
        │ - breadth, top10  │                       │ - aggregate panel  │
        │ - smart-money     │                       │ - smart-money     │
        │   moves summary   │                       │   callout         │
        │                   │                       │ - full holder list│
        └───────────────────┘                       │   w/ QoQ deltas   │
                                                    └────────────────────┘
```

**Approach choice — raw rows + pure compute.** Single `institutional_holdings` table holds the wire-format-ish data (one row per ticker × fund × quarter). All views are computed on read by `lib/compute/holdings-aggregate.ts`. Same pattern as Insider Trades. Rejected alternatives:

- *Pre-aggregated summary table*: every new metric requires a backfill, and the smart-money classification is runtime-dynamic (the curated list is a code constant that can change between deploys).
- *Snapshot + diff dual storage*: optimizes "what changed" queries at the cost of redundant writes; not worth it when per-ticker datasets are under 5k rows.

## Schema

**Drizzle table:**

```ts
export const institutionalHoldings = pgTable(
  'institutional_holdings',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    ticker: text('ticker').notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    investorCik: text('investor_cik').notNull(),
    investorName: text('investor_name').notNull(),
    reportPeriod: date('report_period').notNull(),                // quarter-end
    shares: numeric('shares', { precision: 20, scale: 4 }).notNull(),
    marketValue: numeric('market_value', { precision: 20, scale: 2 }),
    sharesPctOfPortfolio: numeric('shares_pct_of_portfolio', { precision: 10, scale: 6 }),
    sharesPctOfShareholders: numeric('shares_pct_of_shareholders', { precision: 10, scale: 6 }),
    filingDate: date('filing_date').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    dedupeKey: uniqueIndex('institutional_holdings_dedupe')
      .on(t.ticker, t.investorCik, t.reportPeriod),
    tickerPeriodIdx: index('institutional_holdings_ticker_period_idx')
      .on(t.ticker, t.reportPeriod.desc()),
    tickerCikIdx: index('institutional_holdings_ticker_cik_idx')
      .on(t.ticker, t.investorCik, t.reportPeriod.desc())          // QoQ delta queries
  })
);
```

**Invariants:**
- `(ticker, investorCik, reportPeriod)` is unique. A fund holds a ticker exactly once per quarter; refresh uses `onConflictDoNothing` for idempotency.
- `shares` is NOT NULL. Negative or non-finite shares get skipped (and warn-logged) at the service boundary — same defensive pattern that caught MSFT's null-shares hotfix in Insider Trades.
- Window enforcement: refresh prunes rows with `reportPeriod < (newest reportPeriod for ticker - 8 quarters)` in the same call. Bounds storage.

**RLS migration** (`9992_rls_institutional_holdings.sql`): authenticated users read, service role writes. Identical pattern to Insider Trades.

**Both migrations applied via `_apply.ts` to both Neon branches.** Never `drizzle-kit push --force`.

## Provider

`lib/providers/financial-datasets.ts` gains one method:

```ts
async institutionalOwnership(
  ticker: string,
  opts: { limit?: number; reportPeriodGte?: string; reportPeriodLte?: string } = {}
): Promise<HoldingsMeta[]>
```

Calls `/institutional-ownership/?ticker=X&limit=N&report_period_gte=Y&report_period_lte=Z`. Default `limit=500`. Returns `out.institutional_ownership ?? []`.

`HoldingsMeta` wire-format type in `lib/providers/types.ts` (snake_case, mirrors FD's response shape):

```ts
export interface HoldingsMeta {
  ticker: string;
  investor: string;                          // investor name; FD does not consistently return CIK
  report_period: string;                     // ISO YYYY-MM-DD
  shares: number;
  market_value: number | null;
  price: number | null;
  is_active: boolean;
  url: string | null;
}
```

**CIK normalization:** SEC CIKs are 10-digit zero-padded strings. FD does not always include the CIK in the response payload (the field varies by endpoint). When CIK is absent, the service falls back to deterministic name-based matching via uppercased+normalized investor name. The smart-money list stores both CIK and canonical-name variants for resilience. Verified against the live FD response shape during T2.

## Compute layer

**`lib/compute/holdings-aggregate.ts`** — pure, no DB, no network.

```ts
export type HolderDelta = 'new' | 'added' | 'reduced' | 'sold-out' | 'unchanged';
export type SmartMoneyCategory = 'value' | 'macro' | 'quant' | 'growth' | 'activist';

export interface HoldingsRow {
  investorCik: string;
  investorName: string;
  reportPeriod: string;
  shares: number;
  marketValue: number | null;
  sharesPctOfPortfolio: number | null;
}

export interface HolderWithDelta {
  investorCik: string;
  investorName: string;
  shares: number;
  marketValue: number | null;
  sharesPctOfPortfolio: number | null;
  delta: HolderDelta;
  sharesPrev: number | null;
  sharesChange: number;
  isSmartMoney: boolean;
  smartMoneyCategory: SmartMoneyCategory | null;
}

export interface HoldingsAggregate {
  currentPeriod: string | null;
  previousPeriod: string | null;
  totalHolders: number;
  totalSharesHeld: number;
  totalMarketValue: number;
  top10Concentration: number;                                   // 0..1
  breadthTrend: Array<{ period: string; holders: number }>;     // up to 8 entries, newest first
  newPositions: number;
  exits: number;
  smartMoneyMoves: {
    additions: HolderWithDelta[];                                // delta='new' or 'added'
    reductions: HolderWithDelta[];                               // delta='reduced' or 'sold-out'
  };
}

export function classifyDelta(currentShares: number, prevShares: number | null): HolderDelta;
export function joinHoldersWithDeltas(
  currentRows: HoldingsRow[],
  previousRows: HoldingsRow[]
): HolderWithDelta[];
export function computeHoldingsAggregate(
  joined: HolderWithDelta[],
  breadthTrend: Array<{ period: string; holders: number }>
): HoldingsAggregate;
```

**Delta classification thresholds:**
- `new`: previousShares == null or 0, currentShares > 0
- `sold-out`: previousShares > 0, currentShares == 0
- `added`: `(current - prev) / prev > 0.05` (5% increase)
- `reduced`: `(current - prev) / prev < -0.05` (5% decrease)
- `unchanged`: everything else (rounding noise, custodial moves, small adjustments)

The 5% threshold is the industry-standard cutoff used by 13F trackers like WhaleWisdom. Filters real positional intent from accounting/admin noise.

**`lib/compute/smart-money.ts`** — single exported constant:

```ts
export interface SmartMoneyEntry {
  cik: string;                          // 10-digit zero-padded
  canonicalNames: string[];             // multiple aliases tolerated
  name: string;                         // display name
  category: SmartMoneyCategory;
}

export const SMART_MONEY: ReadonlyArray<SmartMoneyEntry>;

export function matchSmartMoney(
  cik: string | null,
  investorName: string
): SmartMoneyEntry | null;
```

Initial ~30 entries spanning the categories: Berkshire Hathaway, Renaissance Technologies, Tiger Global Management, Pershing Square Capital, Citadel Advisors, Bridgewater Associates, Two Sigma, ARK Investment Management, Baupost Group, Greenlight Capital, Third Point, Soros Fund Management, Davis Selected Advisers, Lone Pine Capital, Coatue Management, Viking Global Investors, D.E. Shaw & Co., Millennium Management, AQR Capital Management, Appaloosa Management, Maverick Capital, Lansdowne Partners, Marshall Wace, Point72 Asset Management, Elliott Investment Management, Children's Investment Fund Management, Eminence Capital, Hound Partners, Glenview Capital, Sequoia Fund. Verified CIK numbers from SEC EDGAR; canonical-name variants based on observed FD response strings.

## Service layer

**`lib/services/holdings.ts`** — `HoldingsService`:

```ts
class HoldingsService {
  constructor(deps: { db: ServiceDb; fdProvider: FdHoldingsProvider });

  async refresh(ticker: string): Promise<HoldingsRefreshSummary>;
  async getList(
    ticker: string,
    reportPeriod?: string,                  // ISO YYYY-MM-DD; defaults to most-recent in DB
    limit?: number                          // default 200
  ): Promise<InstitutionalHolding[]>;
  async getAggregate(ticker: string): Promise<HoldingsAggregate>;
  async listAvailablePeriods(ticker: string): Promise<string[]>;   // for period dropdown
}
```

- **`refresh`**: fetches up to 500 rows from FD, batch-inserts with `onConflictDoNothing`, runs the 8-quarter prune in the same transaction, records a `refresh_runs` row with `kind='holdings'`. Uses the `numToStr` helper from the Insider Trades hotfix — null/NaN/non-finite get filtered out before insert with a `logger.warn`.
- **`getList`**: queries `WHERE ticker = X AND report_period = Y ORDER BY shares DESC LIMIT N`. Maps Drizzle string outputs to numbers at the boundary.
- **`getAggregate`**: queries the most-recent + prior quarter rows, calls `joinHoldersWithDeltas`, builds the breadth-trend with a separate `SELECT report_period, COUNT(*) GROUP BY report_period ORDER BY DESC LIMIT 8`, then calls `computeHoldingsAggregate`.
- **`listAvailablePeriods`**: `SELECT DISTINCT report_period ORDER BY DESC LIMIT 8` — drives the period selector dropdown.

`InstitutionalHolding` is the camelCase row type returned by getList (numbers, not strings). Mirror the `InsiderTrade` shape from Insider Trades.

## API routes

**`app/api/tickers/[symbol]/holdings/route.ts`** — `GET` + `POST`:

- `GET`: returns `{ holdings: InstitutionalHolding[]; aggregate: HoldingsAggregate; availablePeriods: string[] }`. Accepts optional `?period=YYYY-MM-DD` to return holdings for a specific quarter (defaults to most recent).
- `POST`: triggers `refresh()`, rate-limited 10/min/user via Redis (same key pattern as `insiders-refresh`).
- Validation: ticker matches `/^[A-Z][A-Z.]{0,5}$/`; if `period` is provided, it must parse as a valid ISO date.

`requireUserId()` gates both. Errors via `errorResponse`. Returns 429 with `Retry-After: 60` when rate-limited.

## UI

### Overview card — `<HoldingsCard>`

Three branches mirroring `<InsiderCard>`:
1. `hasAnyData === false` → empty state with "Visit the Holdings tab to refresh" link.
2. has rows but no current-quarter aggregate (defensive) → "No quarterly data yet."
3. happy path: holder count, top-10 concentration, +new / -exits counts, smart-money moves count + label (only when > 0), "As of YYYY-MM-DD" date, "See full list →" link.

### `/stock/[ticker]/holdings` server page

Same `<article>` + `<header>` shell as Overview, Insiders, and Quality. `<DashboardTabs active="holdings">`. Loads aggregate + first-page holdings + available periods in parallel. Wraps `<HoldingsView>` in a `<Card>`.

### Sub-components in `app/(app)/stock/[ticker]/holdings/_components/`

- **`<HoldingsAggregatePanel>`** (server): 2-col grid breakdown (Total holders / Top-10 concentration / +N new / -N exits / Total market value) plus an 8-quarter holder-count sparkline using Recharts. Same Card pattern as Insiders' panel.
- **`<SmartMoneyCallout>`** (server): bordered callout, conditional on `additions.length + reductions.length > 0`. Each move rendered as `{name} · {delta-label} · {sharesPrev?.toLocaleString()} → {shares.toLocaleString()} ({sharesChange sign + pct})` with a small category chip. Green for additions/new, red for reductions/sold-out.
- **`<HolderRow>`** (server): 12-col grid row.
  - Glyphs: `▲` (green) = new/added · `●` (muted) = unchanged · `▼` (red) = reduced · `✕` (red) = sold-out.
  - Smart-money rows show a category chip ("value", "macro", etc.) in a subtle accent color; non-smart-money rows omit the chip.
  - Columns: glyph · investor name · shares · market value · % change · delta label.
- **`<HoldingsView>`** (client): wraps panel + callout + holder list. State:
  - Refresh button (POST + `router.refresh()`).
  - Filter dropdown: "All holders" / "Smart money only" / "New positions only" / "Exits only" / "Additions only" / "Reductions only". Default: "All holders".
  - Period selector dropdown: lists `availablePeriods`, defaults to most recent. Selecting a non-current period re-fetches via `?period=YYYY-MM-DD` query param.

### `<DashboardTabs>` update

Insert `'holdings'` into the `DashboardTab` union and the `TABS` array, positioned between `'insiders'` and `'filings'`:

```ts
| 'holdings'
{ value: 'holdings', label: 'Holdings', href: (t) => `/stock/${t}/holdings` }
```

Final 9-tab order: Overview · Financials · Technical · News · Insiders · **Holdings** · Filings · Quality · Ask.

### Overview integration

Add `<HoldingsCard>` to the existing 1-card grid row that was added in the Insider Trades slice. That row was sized at `lg:grid-cols-3` with only `<InsiderCard>` populating one column; we slot `<HoldingsCard>` next to it as the second cell. Final row: `[InsiderCard] [HoldingsCard] [empty]` — ready to add a third in a future slice.

## Truncation policy

Per-quarter holder lists for popular tickers can have 1500+ entries. The UI loads and displays the **top 200 by shares descending** (which typically covers ≥ 98% of float). A footer like `"1,247 funds total · showing top 200 by shares"` makes the truncation visible. No pagination — the long tail is index funds and tiny prop shops; adding pagination is build-it-when-someone-asks territory.

## Testing matrix

| Layer | Test file | Coverage |
|---|---|---|
| Compute | `tests/compute/holdings-aggregate.test.ts` | `classifyDelta` (5 cases + 5% threshold edge); `joinHoldersWithDeltas` (CIK join correctness, missing-from-current = sold-out, missing-from-previous = new, CIK-missing fallback to name match); `computeHoldingsAggregate` (totals, top-10 concentration, smart-money detection, breadth trend, sold-out + new counting). ~12 tests. |
| Smart-money | covered inline in compute tests | `matchSmartMoney` CIK match, name-fallback match, no-match returns null, case insensitivity. |
| Provider | `tests/providers/financial-datasets.test.ts` (additions) | `.institutionalOwnership()` URL building, fixture parse, empty-array shape, 404 / 429 error mapping. 5 tests. |
| Service | `tests/integration/holdings-service.test.ts` | `refresh` happy path, `refresh` idempotency, `refresh` records `refresh_runs` row with `kind='holdings'`, `refresh` prunes to 8 quarters, `refresh` skips invalid-numeric rows with warn log, `getList`, `getAggregate` delegates to compute. 7 tests. |
| API | `tests/integration/api-tickers-holdings.test.ts` | GET empty returns zero aggregate, POST refresh inserts, GET-after-POST returns holdings, 400 invalid ticker, 400 invalid period, 429 rate-limit. 6 tests. |
| RLS | `tests/integration/institutional-holdings-rls.test.ts` | authenticated SELECT works, authenticated INSERT denied. 2 tests. |

Total new tests: ~32. Existing suite expected to remain green.

## File structure (preview)

| File | Action |
|---|---|
| `lib/db/schema.ts` | Modify (add `institutionalHoldings` table) |
| `lib/db/migrations/<auto>.sql` | Generated (Drizzle) |
| `lib/db/migrations/9992_rls_institutional_holdings.sql` | Create |
| `lib/providers/types.ts` | Modify (add `HoldingsMeta`) |
| `lib/providers/financial-datasets.ts` | Modify (add `.institutionalOwnership()`) |
| `lib/providers/__fixtures__/fd-institutional-ownership-aapl.json` | Create |
| `lib/compute/holdings-aggregate.ts` | Create |
| `lib/compute/smart-money.ts` | Create |
| `lib/services/holdings.ts` | Create |
| `app/api/tickers/[symbol]/holdings/route.ts` | Create |
| `scripts/try-13f.ts` | Create |
| `app/(app)/stock/[ticker]/_components/holdings-card.tsx` | Create |
| `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx` | Modify (add `'holdings'`) |
| `app/(app)/stock/[ticker]/page.tsx` | Modify (load + render `<HoldingsCard>` next to Insiders) |
| `app/(app)/stock/[ticker]/holdings/page.tsx` | Create |
| `app/(app)/stock/[ticker]/holdings/_components/holdings-view.tsx` | Create (client) |
| `app/(app)/stock/[ticker]/holdings/_components/holdings-aggregate-panel.tsx` | Create |
| `app/(app)/stock/[ticker]/holdings/_components/smart-money-callout.tsx` | Create |
| `app/(app)/stock/[ticker]/holdings/_components/holder-row.tsx` | Create |
| `tests/compute/holdings-aggregate.test.ts` | Create |
| `tests/providers/financial-datasets.test.ts` | Modify (add `.institutionalOwnership()` describe block) |
| `tests/integration/holdings-service.test.ts` | Create |
| `tests/integration/api-tickers-holdings.test.ts` | Create |
| `tests/integration/institutional-holdings-rls.test.ts` | Create |
| `package.json` | Modify (add `try-13f` script) |

## Rollout

Final task in the plan covers:
1. Push and watch CI green.
2. Populate via `pnpm try-13f <TICKER>` for AAPL / NVDA / MSFT / GOOGL / JD / TSLA. Expect GOOGL and JD to return 402 (same FD coverage gap that affects news + insiders for those tickers); document outcomes, do not treat as a bug.
3. Browser smoke on Vercel:
   - Overview card visible on /stock/AAPL with breadth + concentration + smart-money summary.
   - /stock/AAPL/holdings shows panel + smart-money callout (if any) + top-200 holder list with glyphs and category chips.
   - Filter dropdown works (All / Smart money / New / Exits / Additions / Reductions).
   - Period selector dropdown works (default = current, switching = re-fetch).
   - 9-tab nav: Overview · Financials · Technical · News · Insiders · **Holdings** · Filings · Quality · Ask.
   - Empty-state path on GOOGL or JD renders cleanly.

## Risks and mitigations

- **FD response shape uncertainty.** Wire format is inferred from FD's `/institutional-ownership/` documented schema; T2 verifies with a real fixture. If shape differs, adjust `HoldingsMeta` and the fixture. Same risk pattern handled successfully in Slice 5B (news) and Insider Trades.
- **CIK normalization.** Funds can be reported by FD with or without CIK, with leading-zero variation, or under multiple legal-entity names. The smart-money matcher uses CIK first with `padStart(10, '0')` normalization, falls back to canonical-name matching with an alias list. `matchSmartMoney` returns null on miss, not a throw — non-matches are the common case.
- **Stale data perception.** A Q1 13F is published in mid-May; the Overview card shows "As of YYYY-MM-DD" prominently, and the /holdings page header date is part of the visual hierarchy. UI does not silently imply real-time data.
- **GOOGL / JD paywall.** Expected based on FD's coverage gaps for those tickers (same as news + insiders). Empty-state UI handles it gracefully.
- **Storage growth.** 8-quarter prune in every refresh bounds it. Worst case for AAPL-tier popularity: ~1500 holders × 8 quarters = 12k rows. Negligible.
- **Smart-money list goes stale.** The list is a code constant — easy to update via a small PR. Not a feature the user touches at runtime, so no operational burden.

## Success criteria

- Overview card renders breadth + concentration + smart-money summary for any ticker with data, and a clean empty state otherwise.
- `/stock/[ticker]/holdings` shows the full top-200 list with correct QoQ deltas, smart-money classification, and a working period selector + filter dropdown.
- Smart-money callout fires whenever a curated manager has a new / added / reduced / sold-out delta in the latest available quarter.
- Refresh button updates data within ~5 seconds for tickers with available FD coverage.
- All tests pass (target ~32 new tests, existing suite green).
- 9-tab DashboardTabs nav reflows correctly with Holdings inserted between Insiders and Filings.
