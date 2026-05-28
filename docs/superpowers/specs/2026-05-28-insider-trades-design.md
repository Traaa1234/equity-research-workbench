# Insider Trades (SEC Form 4) — Design Spec

**Date:** 2026-05-28
**Status:** Design approved, plan pending
**Sibling:** 13F institutional holdings is a follow-up slice (not in scope here)

## Goal

Add an Overview card + dedicated `/stock/[ticker]/insiders` tab that surface SEC Form 4 insider transactions for each ticker. The user can see at a glance "is this stock seeing insider buying or selling?", drill in to the full transaction list, and refresh on demand.

The headline signal is **net open-market activity over the last 90 days** plus a **cluster-buy detector** (2+ distinct insiders buying within a rolling 30-day window — a classic high-conviction signal).

## Non-Goals

- Cron-based refresh (manual button only, matches news pattern)
- Multi-ticker insider feed across watchlist
- Alerts on new Form 4 filings (would need cron — defer)
- LLM scoring of insider activity (cluster-buy heuristic is already unbiased + interpretable)
- Form 4 PDF attachments (FD doesn't expose them)
- Distinguishing exercise+hold vs exercise+sell (FD aggregates these as one transaction)
- Sentiment scoring of sells (sells are weak signals — insiders sell for many reasons; we surface as context but don't aggregate as a directional signal)
- 13F institutional holdings (separate slice)

## Architecture

DB-cached, on-demand refresh. Same shape as Slice 5B (News).

```
┌─────────────────────────────────────────────────────────────────┐
│  /stock/[ticker]/insiders  (server component)                    │
│    1. requireUserId()                                            │
│    2. InsidersService.getList(ticker)  → reads insider_trades    │
│    3. InsidersService.getAggregate(ticker, days=90)              │
│    4. Render <InsidersView>                                      │
└─────────────────────────────────────────────────────────────────┘
                                                              │
                                                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  POST /api/tickers/[ticker]/insiders   (refresh, rate-limited)  │
│    1. FD.insiderTrades(ticker, limit=500)                        │
│    2. Upsert into insider_trades, dedupe by composite key        │
│    3. Insert refresh_runs row                                    │
│    4. Return { fetched, newRows, durationMs }                    │
└─────────────────────────────────────────────────────────────────┘
                                                              │
                                                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layers:                                                         │
│    lib/providers/financial-datasets.ts                            │
│      NEW method: insiderTrades(ticker, opts?)                     │
│    lib/providers/types.ts                                         │
│      NEW: InsiderTradeMeta interface                              │
│    lib/compute/insider-aggregate.ts                               │
│      NEW pure compute: computeInsiderAggregate(rows, windowDays)  │
│    lib/services/insiders.ts                                       │
│      NEW: InsidersService { refresh, getList, getAggregate }      │
│    lib/db/schema.ts                                               │
│      NEW table: insider_trades                                    │
└─────────────────────────────────────────────────────────────────┘
```

### Key invariants

- **No cron, manual refresh only.** Predictable cost.
- **Idempotent refresh** — composite unique index `(ticker, filing_date, insider_name, transaction_date, shares, transaction_type)` prevents duplicates on re-run.
- **Open-market filter on aggregate.** Awards / option exercises / gifts / conversions are NOT counted as buys or sells in the headline metric — they're compensation/admin, not conviction signals. They still appear in the full transaction list (classified by glyph) so the user can see the full picture.
- **Sells are weak signals.** We show buy and sell counts in the aggregate but explicitly emphasize buys (especially clusters) as the actionable signal.
- **RLS:** authenticated SELECT, service-role writes — same pattern as filings / news / filing_summaries.

## Data Model

`insider_trades` Drizzle table:

```ts
export const insiderTrades = pgTable(
  'insider_trades',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    ticker: text('ticker').notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    insiderName: text('insider_name').notNull(),
    insiderTitle: text('insider_title'),
    isBoardDirector: boolean('is_board_director').notNull().default(false),
    transactionDate: date('transaction_date').notNull(),
    transactionType: text('transaction_type').notNull(),
    shares: numeric('shares', { precision: 20, scale: 4 }).notNull(),
    pricePerShare: numeric('price_per_share', { precision: 20, scale: 6 }),
    transactionValue: numeric('transaction_value', { precision: 20, scale: 2 }),
    sharesOwnedBefore: numeric('shares_owned_before', { precision: 20, scale: 4 }),
    sharesOwnedAfter: numeric('shares_owned_after', { precision: 20, scale: 4 }),
    securityTitle: text('security_title'),
    filingDate: date('filing_date').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    dedupeKey: uniqueIndex('insider_trades_dedupe').on(
      t.ticker, t.filingDate, t.insiderName, t.transactionDate, t.shares, t.transactionType
    ),
    tickerDateIdx: index('insider_trades_ticker_date_idx').on(
      t.ticker, t.transactionDate.desc()
    )
  })
);
```

**RLS migration** (`9993_rls_insider_trades.sql`):

```sql
ALTER TABLE public.insider_trades ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated read insider_trades" ON public.insider_trades;
CREATE POLICY "authenticated read insider_trades"
  ON public.insider_trades FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.insider_trades TO authenticated;
```

## Provider Layer

### `FinancialDatasetsProvider.insiderTrades(ticker, opts?)`

```ts
interface InsiderTradesOptions {
  limit?: number;            // default 500, FD max 5000
  filingDateGte?: string;    // ISO YYYY-MM-DD
  filingDateLte?: string;
}

async insiderTrades(ticker: string, opts: InsiderTradesOptions = {}): Promise<InsiderTradeMeta[]> {
  const params = new URLSearchParams({ ticker: ticker.toUpperCase() });
  params.set('limit', String(opts.limit ?? 500));
  if (opts.filingDateGte) params.set('filing_date_gte', opts.filingDateGte);
  if (opts.filingDateLte) params.set('filing_date_lte', opts.filingDateLte);
  const out = await this.request<{ insider_trades?: InsiderTradeMeta[] }>(
    `/insider-trades/?${params.toString()}`
  );
  return out.insider_trades ?? [];
}
```

### `InsiderTradeMeta` type (mirrors FD response, snake_case at API boundary)

```ts
export interface InsiderTradeMeta {
  ticker: string;
  issuer: string;
  name: string;
  title: string | null;
  is_board_director: boolean;
  transaction_date: string;          // ISO YYYY-MM-DD
  transaction_type: string;          // 'Open market sale', 'Open market purchase', 'Award', etc.
  transaction_shares: number;
  transaction_price_per_share: number | null;
  transaction_value: number | null;
  shares_owned_before_transaction: number | null;
  shares_owned_after_transaction: number | null;
  security_title: string | null;
  filing_date: string;               // ISO YYYY-MM-DD
}
```

Error mapping is the standard FD pattern (404/429/4xx/5xx → typed errors, retry on transient).

## Aggregation Logic (Pure)

`lib/compute/insider-aggregate.ts` — pure function over an array of insider-trade rows. Tested in isolation.

```ts
export interface InsiderTradeRow {
  insiderName: string;
  insiderTitle: string | null;
  transactionDate: string;     // ISO YYYY-MM-DD
  transactionType: string;
  shares: number;
  transactionValue: number | null;
}

export interface InsiderAggregate {
  windowDays: number;
  netShares: number;
  netDollarValue: number;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  largestBuy: { name: string; date: string; valueUsd: number } | null;
  largestSell: { name: string; date: string; valueUsd: number } | null;
  hasClusterBuy: boolean;
  clusterBuyDates: string[];     // window-start dates if any cluster
  lastTransactionDate: string | null;
}

export function computeInsiderAggregate(
  rows: InsiderTradeRow[],     // sorted newest first
  windowDays = 90,
  asOf: Date = new Date()
): InsiderAggregate;
```

### Classification

Each transaction is classified into one of: `'buy' | 'sell' | 'award' | 'exercise' | 'other'` based on `transactionType`:

| transactionType (lowercased) | Classified as |
|---|---|
| Contains "open market purchase" or "open market buy" | `buy` |
| Contains "open market sale" or "open market sell" | `sell` |
| Contains "award" or "grant" | `award` |
| Contains "exercise" | `exercise` |
| Anything else | `other` |

**Only `buy` and `sell` rows contribute to the aggregate.** Other classes appear in the full transaction list but not in the headline metrics.

### Cluster-buy detection

For each `buy` row `i`, look at all `buy` rows within the next 30 days (exclusive of `i` itself). If the set of distinct `insiderName` values across `i` and those subsequent rows has size ≥ 2, emit `i.transactionDate` as a cluster start. Deduplicate overlapping clusters (keep earliest start). The final `hasClusterBuy` is `clusterBuyDates.length > 0`.

The 30-day window is the convention used by most insider-tracking research (e.g., Lakonishok-Lee 2001).

## Service Layer

`lib/services/insiders.ts`:

```ts
class InsidersService {
  constructor(deps: { db: ServiceDb; fdProvider: FdInsidersProvider });

  async getList(ticker: string, limit = 100): Promise<InsiderTrade[]>;
  async getAggregate(ticker: string, windowDays = 90): Promise<InsiderAggregate>;
  async refresh(ticker: string): Promise<InsiderRefreshSummary>;
}
```

`refresh()` calls FD, upserts via `.onConflictDoNothing()`, records `refresh_runs` row with `kind: 'insiders'`. On FD failure, records `ok=false` and rethrows.

`getAggregate()` reads rows from DB and delegates to `computeInsiderAggregate()` from the pure layer.

## API Routes

```
GET  /api/tickers/[symbol]/insiders   → { transactions: InsiderTrade[]; aggregate: InsiderAggregate }
POST /api/tickers/[symbol]/insiders   → trigger refresh, returns summary
```

Both gated by `requireUserId()`. POST is rate-limited 10/min/user via the existing Redis pattern (key: `ratelimit:insiders-refresh:<userId>`).

Validation: ticker must match `/^[A-Z][A-Z.]{0,5}$/`, company row must exist.

## UI

### Overview-page card (`<InsiderCard>`)

```
┌────────────────────────────────────────────┐
│ Insider activity                           │
├────────────────────────────────────────────┤
│ 90-day net           +12,450 sh           │
│                      ≈ $3.5M              │
│                                            │
│ 5 buyers · 2 sellers                       │
│ ⚡ Cluster buy detected                    │
│ Last trade:          2026-05-08            │
│                                            │
│              See full list →                │
└────────────────────────────────────────────┘
```

Color cues: net positive → green tint, net negative → red tint. Cluster-buy badge (⚡) only when `hasClusterBuy === true`.

Empty states:
- No transactions in window → "No recent insider activity"
- DB has zero rows for ticker → "No insider data fetched yet. Visit the Insiders tab to refresh."

### `/insiders` tab page

```
┌───────────────────────────────────────────────────────────────────┐
│  AAPL · Insider Activity                  [Refresh] button        │
│                                                                   │
│  90-day summary                                                   │
│  ─────────────────────────────────────────────────────────────── │
│  Net shares      +12,450        ($3.5M)                           │
│  Open-market buys      5 transactions across 3 insiders           │
│  Open-market sells     2 transactions across 2 insiders           │
│  Largest buy           John Smith (CFO) · 2026-04-12 · $1.2M      │
│  Largest sell          Jane Doe (Director) · 2026-03-21 · $890K   │
│                                                                   │
│  ⚡ Cluster buy detected (2026-04-10 → 2026-04-18)                 │
│     CFO, COO, and SVP-Eng bought within 8 days                    │
│                                                                   │
├───────────────────────────────────────────────────────────────────┤
│  All transactions               [filter: All ▾]                   │
│  ─────────────────────────────────────────────────────────────── │
│  ● BUY    2026-04-18   Tim Smith (COO)          2,400 @ $283   $679K │
│  ● BUY    2026-04-15   John Doe (SVP-Eng)        500 @ $280   $140K │
│  ● BUY    2026-04-12   John Smith (CFO)        4,200 @ $278  $1.2M │
│  ● SELL   2026-03-21   Jane Doe (Director)     3,100 @ $287   $890K │
│  ◆ AWARD  2026-02-15   Tim Cook (CEO)         100,000 @ —     — │
│  ⬢ EXERCISE 2026-02-15 Tim Cook (CEO)          80,000 @ $130  $10.4M │
└───────────────────────────────────────────────────────────────────┘
```

Glyph + color per classification:
- ● green = BUY (open-market purchase)
- ● red = SELL (open-market sale)
- ◆ gray = AWARD (compensation)
- ⬢ amber = EXERCISE (option exercise — mixed signal)
- ○ gray = OTHER (gift, conversion, etc.)

Filter dropdown:
- All
- Buys & sells only (default for the actionable view)
- Buys only
- Sells only
- Excludes compensation (shows BUY + SELL + EXERCISE + OTHER, hides AWARD)

Transaction list sorted by `transactionDate DESC`, paginated 50 per page. Refresh button identical UX to the News tab.

### File structure

| File | Action | Responsibility |
|---|---|---|
| `lib/db/schema.ts` | Modify | Add `insiderTrades` table |
| `lib/db/migrations/<auto>.sql` | Create (drizzle-kit) | DDL |
| `lib/db/migrations/9993_rls_insider_trades.sql` | Create | RLS policy |
| `lib/providers/types.ts` | Modify | Add `InsiderTradeMeta` |
| `lib/providers/financial-datasets.ts` | Modify | Add `insiderTrades()` |
| `lib/providers/__fixtures__/fd-insider-trades-aapl.json` | Create | Sample FD response |
| `lib/compute/insider-aggregate.ts` | Create | Pure `computeInsiderAggregate` |
| `lib/services/insiders.ts` | Create | `InsidersService` |
| `app/api/tickers/[symbol]/insiders/route.ts` | Create | GET + POST |
| `scripts/try-insiders.ts` | Create | `pnpm try-insiders <TICKER>` |
| `app/(app)/stock/[ticker]/_components/insider-card.tsx` | Create | Overview card |
| `app/(app)/stock/[ticker]/page.tsx` | Modify | Slot the card + call `loadInsiders` |
| `app/(app)/stock/[ticker]/insiders/page.tsx` | Create | Server component |
| `app/(app)/stock/[ticker]/insiders/_components/insiders-view.tsx` | Create | Client wrapper + refresh + filter |
| `app/(app)/stock/[ticker]/insiders/_components/insider-aggregate-panel.tsx` | Create | Summary block + cluster callout |
| `app/(app)/stock/[ticker]/insiders/_components/insider-transaction-row.tsx` | Create | Single-row component |
| `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx` | Modify | Add `'insiders'` tab |
| `tests/compute/insider-aggregate.test.ts` | Create | 5-6 pure-function unit tests |
| `tests/providers/financial-datasets.test.ts` | Modify | Add `insiderTrades()` tests |
| `tests/integration/insiders-service.test.ts` | Create | Refresh / getList / getAggregate |
| `tests/integration/api-tickers-insiders.test.ts` | Create | GET + POST |
| `tests/integration/insider-trades-rls.test.ts` | Create | RLS smoke |

## Testing Matrix

| Layer | Test | Asserts |
|---|---|---|
| `computeInsiderAggregate` | All-buy fixture | netShares > 0, buyCount matches, uniqueBuyers, no cluster when 1 buyer |
| | All-sell fixture | netShares < 0, sellCount matches |
| | 3 distinct buyers in 20 days | `hasClusterBuy = true`, at least 1 cluster date |
| | Compensation only (awards + exercises) | netShares = 0, no cluster |
| | Window filter — transactions older than `windowDays` excluded | Only in-window rows counted |
| | Largest buy / largest sell extraction | Returns the highest-value buy and sell respectively, by `transactionValue` |
| `FinancialDatasetsProvider.insiderTrades` | Unit, mocked HTTP | Returns array, handles missing field, error mapping |
| `InsidersService.refresh` | Integration | Dedupe on second call, refresh_runs row, summary counts correct |
| `InsidersService.getList` | Integration | Sorted by transaction_date DESC, limit honored |
| `InsidersService.getAggregate` | Integration | Returns same numbers as pure compute on same fixture |
| GET route | Integration | Auth required, returns `{transactions, aggregate}` |
| POST route | Integration | Auth, rate limit, summary returned |
| RLS smoke | `makeTestUserDb` | Authenticated SELECT works, INSERT denied |

## Cost Analysis

| Operation | Frequency | Cost |
|---|---|---|
| FD `/insider-trades/` fetch | Per refresh, user-triggered | Free (counts against FD quota) |
| DB writes | Per refresh, ~10-500 rows | Negligible |
| Storage | ~500 bytes/row × ~500 rows/ticker/year | Negligible |

**No LLM, no embeddings, no recurring cost beyond FD quota.**

## Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| `transaction_type` strings vary slightly (e.g., "Sale" vs "Open market sale") | Medium | Classification is `includes()` based, lowercased; unknown strings fall through to `'other'` and don't break the aggregate |
| FD truncates at 500 transactions, ticker has more | Low | 500 is plenty for 90-day signal; older transactions matter less. Could expand limit if needed. |
| Multiple identical transactions on same day from same person | Low | Composite unique key may collapse legitimate identical-on-same-day trades; acceptable for v1 (rare and not signal-changing) |
| Insider title is sometimes null (board directors with no formal title) | High | UI displays "(Director)" when `is_board_director && !title`, otherwise the title or empty |
| Cluster detection false positives with many small buys | Low | The buy must be open-market (excludes 10b5-1 plan sales misclassified as buys, etc.); cluster requires distinct names |
| Sells overshadow buys visually | Medium | Headline numbers separate buys and sells; cluster callout only fires on BUYS; UI defaults filter to "Buys & sells only" |
| RLS regression on new table | Medium | Apply RLS via direct `_apply.ts` to BOTH branches (never drizzle-kit push); verify with `_check.ts` |

## Success Criteria

1. Visiting `/stock/AAPL` shows an "Insider activity" card with 90-day net, buyer/seller counts, last trade date, and cluster-buy badge if applicable.
2. `/stock/AAPL/insiders` shows aggregate panel + transaction list with glyph-classified rows + working filter dropdown.
3. Clicking **Refresh** completes in under 10s, surfaces a toast, new transactions (if any) appear.
4. Same for NVDA / MSFT / GOOGL / JD / TSLA.
5. All 6 unit tests on `computeInsiderAggregate` pass; CI green.
6. RLS verified: authenticated SELECT works, anon SELECT denied.
