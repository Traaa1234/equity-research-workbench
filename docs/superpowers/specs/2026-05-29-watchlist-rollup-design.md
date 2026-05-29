# Watchlist Roll-up Dashboard — Design Spec

> **Status:** Design complete. Composes existing services; no new ingestion.
> **Date:** 2026-05-29
> **Owner:** Equity Research Workbench

---

## Goal

Turn `/watchlist` into the daily-driver morning view by adding a multi-signal table where each watchlisted ticker is one row with cells showing Snapshot, Technical, News, Insiders, and Filings status at a glance. Click any cell to deep-link into the relevant `/stock/[ticker]/<tab>` page.

## Non-goals

- **New data ingestion.** This slice composes the 5 backing services we already shipped (SnapshotService, PricesService, NewsService, InsidersService, FilingsService). No new schema, no new providers, no new API routes.
- **Quality + 13F columns.** Quality scores change quarterly; 13F is filed quarterly. Daily-action focus excludes them. Both remain accessible via the per-ticker `/stock/[ticker]/quality` and `/holdings` tabs.
- **Column-click-to-sort, per-column filters, customizable column visibility.** YAGNI for a 6-12 ticker watchlist.
- **Saved views, multiple watchlists, alerts.** Separate features.
- **Mobile-first polish.** The workbench is desktop-first; mobile falls back to a stacked card view.

## User value

Before this slice, checking on the watchlist meant clicking into each ticker individually. The roll-up gives a single-page answer to "what changed across my watchlist today?" — RSI alarms, news bursts, fresh insider activity, recent filings, all in one grid.

Each cell is a small chip that tells you whether the underlying signal is worth a closer look:
- **Snapshot** — price + day change %
- **Technical** — `OB` (RSI>70), `OS` (RSI<30), `GC` (golden cross within 10d), `DC` (death cross within 10d), or neutral
- **News** — `+N art  +S` (article count past 7 days, average sentiment)
- **Insiders** — `⚡ cluster`, `+N buys`, `-N sells`, or `· quiet`
- **Filings** — most recent form + days ago; amber dot if within 7 days

Each cell is a deep link. Click the snapshot → ticker overview; click the technical chip → `/stock/[ticker]/technical`; click the news cell → `/news`; etc.

## Architecture

```
                       ┌────────────────────────────┐
                       │   /watchlist (server)      │
                       │   - requireUserId()         │
                       │   - WatchlistService.list   │
                       │   - render tabs (existing)  │
                       └─────────────┬───────────────┘
                                     │
                       ┌─────────────▼───────────────┐
                       │  <WatchlistTable> (server)  │
                       │  for each ticker:            │
                       │    <Suspense fallback>      │
                       │      <WatchlistRow ticker/> │
                       │    </Suspense>              │
                       └─────────────┬───────────────┘
                                     │
                       ┌─────────────▼───────────────┐
                       │  <WatchlistRow ticker>      │
                       │  (server) composes 5 cells, │
                       │  each in its own <Suspense> │
                       └──────────────┬──────────────┘
                                      │
              ┌──────────┬──────────┬─┴────────┬──────────┬───────────┐
              │          │          │          │          │           │
       ┌──────▼──┐  ┌────▼────┐  ┌──▼────┐  ┌──▼────┐  ┌──▼────┐  (existing
       │Snapshot │  │Prices + │  │News   │  │Insider│  │Filings│   services
       │Cell     │  │technical│  │Cell   │  │sCell  │  │Cell   │   in DB)
       │         │  │Cell     │  │       │  │       │  │       │
       └─────────┘  └─────────┘  └───────┘  └───────┘  └───────┘
                          │          │          │          │
                          ▼          ▼          ▼          ▼
                ┌───────────────────────────────────────────┐
                │ lib/compute/watchlist-cells.ts            │
                │ Pure functions, one per signal:           │
                │  - snapshotToCell(snap)                   │
                │  - technicalToCell(tech)                  │
                │  - newsToCell(articles)                   │
                │  - insidersToCell(aggregate)              │
                │  - filingsToCell(filing)                  │
                │ Each returns Cell = { glyph, color,       │
                │   tooltip? }                              │
                └───────────────────────────────────────────┘
```

### What stays unchanged

- **All 5 backing services.** No method signature changes. The roll-up reads `SnapshotService.get(t)`, `PricesService.get(t, '6M')` → `computeTechnical(...)`, `NewsService.getList(t, days=7)`, `InsidersService.getAggregate(t, 90)`, `FilingsService.list(t, limit=1)`.
- **Existing `/watchlist` page features:** search bar, Ask panel, add-ticker dialog, watchlist-card view all stay accessible.

### What's new

- `lib/compute/watchlist-cells.ts` — 5 pure formatters (~150 LOC total).
- 5 cell server components in `app/(app)/watchlist/_components/cells/` — each ~20-30 LOC.
- `<WatchlistRow>` server component composing cells.
- `<WatchlistTable>` server component composing rows in `<Suspense>` boundaries.
- `<WatchlistRowSkeleton>` + `<CellSkeleton>` fallback components.
- Tab nav update: add `'rollup'` to `WatchlistTab` union; default the page to `?tab=rollup`.

## Cells

Each cell is a server component, takes a `ticker: string`, calls one existing service, applies a pure formatter from `watchlist-cells.ts`, renders a chip wrapped in `<Link>` to the relevant deep page.

### `<SnapshotCell ticker>`
- **Reads:** `SnapshotService.get(ticker)` (Redis-cached 1h TTL, Phase 1)
- **Renders:** `$290.45  +0.4%` — green if change > 0, red if < 0, muted if null
- **Deep link:** `/stock/${ticker}`
- **Empty state:** `—`

### `<TechnicalCell ticker>`
- **Reads:** `PricesService.get(ticker, '6M')` → `computeTechnical(prices)` (Slice 5A's existing pure compute)
- **Renders:** one of: `OB` (RSI>70, red), `OS` (RSI<30, green), `GC` (golden cross within 10d, green), `DC` (death cross within 10d, red), `●` (neutral, muted)
- **Tooltip:** `RSI 71 · MACD bullish` — actual numbers
- **Deep link:** `/stock/${ticker}/technical`
- **Empty state:** `—` if no prices

### `<NewsCell ticker>`
- **Reads:** `NewsService.getList(ticker, { days: 7 })` (Slice 5B)
- **Renders:** `+5 art  +0.3` — article count past 7 days + avg sentiment. Sentiment color: green ≥ 0.2, red ≤ -0.2, muted in between
- **Deep link:** `/stock/${ticker}/news`
- **Empty state:** `· quiet`

### `<InsidersCell ticker>`
- **Reads:** `InsidersService.getAggregate(ticker, 90)` (Insider Trades slice)
- **Renders:** priority order — `⚡ cluster` if `hasClusterBuy`, else `+N buys` if `netShares > 0`, else `-N sells` if `netShares < 0`, else `· quiet`
- **Color:** green for cluster/buys, red for sells, muted for quiet
- **Deep link:** `/stock/${ticker}/insiders`

### `<FilingsCell ticker>`
- **Reads:** `FilingsService.list(ticker, { limit: 1 })` (Slice 2A)
- **Renders:** `8-K · 3d` or `10-Q · 12d` — form type + days since filed. Amber dot prefix if within 7 days
- **Deep link:** `/stock/${ticker}/filings`
- **Empty state:** `—`

## Pure formatters

`lib/compute/watchlist-cells.ts`:

```ts
export interface Cell {
  glyph: string;
  color: 'green' | 'red' | 'amber' | 'muted' | 'default';
  tooltip?: string;
}

export function snapshotToCell(
  snap: { price: number | null; changePct: number | null } | null
): Cell;

export function technicalToCell(
  tech: { rsi: number | null; macdSignal: 'bullish'|'bearish'|'neutral'; recentCross: 'golden'|'death'|null }
): Cell;

export function newsToCell(
  articles: Array<{ sentiment: number | null }>
): Cell;

export function insidersToCell(
  agg: { hasClusterBuy: boolean; netShares: number; buyCount: number; sellCount: number } | null
): Cell;

export function filingsToCell(
  filing: { formType: string; filingDate: string } | null,
  asOf?: Date
): Cell;
```

All formatters handle null/empty inputs gracefully (return the `—` or `· quiet` Cell). No throws.

The `Cell.color` is intentionally a small union, not arbitrary Tailwind class names — keeps the cell components decoupled from styling. Color mapping happens in a single helper in `<WatchlistCell>` rendering.

## Table layout

```tsx
// app/(app)/watchlist/_components/watchlist-table.tsx
export async function WatchlistTable({ tickers }: { tickers: string[] }) {
  return (
    <div className="border border-border rounded">
      <header className="grid grid-cols-12 gap-3 px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border">
        <span className="col-span-2">Ticker</span>
        <span className="col-span-2 text-right">Snapshot</span>
        <span className="col-span-2 text-center">Tech</span>
        <span className="col-span-2 text-center">News</span>
        <span className="col-span-2 text-center">Insiders</span>
        <span className="col-span-2 text-center">Filings</span>
      </header>
      <ul>
        {tickers.map((t) => (
          <Suspense key={t} fallback={<WatchlistRowSkeleton ticker={t} />}>
            {/* @ts-expect-error Async Server Component */}
            <WatchlistRow ticker={t} />
          </Suspense>
        ))}
      </ul>
    </div>
  );
}
```

**Per-row Suspense boundary with `key={t}`** is critical — without the key, React reuses one boundary across all rows and they all wait for the slowest row.

**Per-cell Suspense boundary** inside each row — a slow news fetch doesn't block the snapshot rendering. Cells stream independently.

**Mobile fallback (< 1024px):** wrap the table in `hidden lg:block` and provide a stacked card variant `<WatchlistRowMobile>` rendered in `lg:hidden`. Each mobile card is one ticker with the 5 signals in a 2×3 mini-grid. Don't put heavy effort into mobile polish — the workbench is desktop-first.

## Sort/filter

Minimal. The watchlist is 6-12 tickers; full table interactivity is overkill.

- **Default sort:** alphabetical by ticker.
- **One "interesting first" toggle** as a `<select>` at the top: `Default · Has insider activity · Has news · Has cluster buy`. Passed as `?sort=` URL param. Server re-renders with the rows reordered.

No column-click-to-sort. No multi-column sort. No per-column filter.

The roll-up's job is "show me everything at a glance"; if the user wants drill-down, they click into the ticker.

## Tab integration

`<WatchlistTabs>` gains a third tab `Roll-up`. New `WatchlistTab` union:

```tsx
type WatchlistTab = 'rollup' | 'list' | 'search' | 'ask';
```

The page defaults to `?tab=rollup` (URL-driven). The existing `List` view (snapshot cards) remains accessible.

Tab order: Roll-up · List · Search · Ask.

## File structure

| File | Action |
|---|---|
| `lib/compute/watchlist-cells.ts` | Create — 5 pure formatters + `Cell` type |
| `tests/compute/watchlist-cells.test.ts` | Create — ~20 unit tests |
| `app/(app)/watchlist/_components/watchlist-table.tsx` | Create — table shell + per-row Suspense |
| `app/(app)/watchlist/_components/watchlist-row.tsx` | Create — row composing 5 cells in Suspense |
| `app/(app)/watchlist/_components/watchlist-row-skeleton.tsx` | Create — row-level fallback |
| `app/(app)/watchlist/_components/watchlist-row-mobile.tsx` | Create — mobile stacked card variant |
| `app/(app)/watchlist/_components/cells/snapshot-cell.tsx` | Create |
| `app/(app)/watchlist/_components/cells/technical-cell.tsx` | Create |
| `app/(app)/watchlist/_components/cells/news-cell.tsx` | Create |
| `app/(app)/watchlist/_components/cells/insiders-cell.tsx` | Create |
| `app/(app)/watchlist/_components/cells/filings-cell.tsx` | Create |
| `app/(app)/watchlist/_components/cells/cell-skeleton.tsx` | Create |
| `app/(app)/watchlist/_components/cells/cell-chip.tsx` | Create — shared `<CellChip color, glyph, href, tooltip />` rendering helper |
| `app/(app)/watchlist/_components/sort-toggle.tsx` | Create — client-component select for `?sort=` param |
| `app/(app)/watchlist/page.tsx` | Modify — handle `?tab=rollup`, default to it, render `<WatchlistTable>` |
| `app/(app)/watchlist/_components/watchlist-tabs.tsx` | Modify — add `'rollup'` tab |
| `tests/e2e/watchlist-rollup.spec.ts` | Create — 1 Playwright E2E test |

15 new files + 2 modifications. Largest is `watchlist-cells.ts` (~150 LOC).

## Testing matrix

| Layer | Test file | Coverage |
|---|---|---|
| Pure compute | `tests/compute/watchlist-cells.test.ts` | Each formatter's branches: positive/negative/null/edge cases. ~3-5 tests per formatter = ~20 unit tests. |
| Cell components | (skip) | Each cell is a 5-line wrapper around a service call + formatter. Formatter has unit tests; service has integration tests. Wrapper tests would over-test. |
| Page | `tests/e2e/watchlist-rollup.spec.ts` (Playwright) | One E2E: visit `/watchlist?tab=rollup`, assert table renders all watchlisted tickers, assert at least one cell per row has visible content, assert clicking ticker row navigates to `/stock/[ticker]`. 1 test. |

Net new: ~21 tests. Existing tests stay green (no services modified).

## Rollout

1. Implement, push, watch CI to green.
2. Browser smoke on Vercel:
   - `/watchlist` defaults to the Roll-up tab.
   - All 6 watchlisted tickers render as rows.
   - Each row has 5 cells with realistic content or graceful empty states (e.g. JD likely shows `· quiet` insiders and `—` filings).
   - Row hover highlights; clicking the ticker name navigates to `/stock/[ticker]`.
   - Cell clicks deep-link correctly (e.g. clicking the News cell goes to `/stock/AAPL/news`).
   - "Interesting first" sort toggle reorders rows via `?sort=` URL change.
3. Optional: take a screenshot for changelog/README.

## Risks and mitigations

- **Slow service stalls a row.** With per-cell Suspense, a slow technical compute won't block the snapshot. The page paints progressively. Worst case: one cell shows skeleton for ~2s.
- **Tickers with no data show empty cells.** Every formatter handles the null/empty case (`—` / `· quiet`). Tested.
- **Cron freshness mismatch.** Different services refresh on different cadences (snapshot hourly, news daily, insiders/13F manual). The roll-up shows whatever's in the DB now — staleness varies per cell. Acceptable; users understand the underlying cadence.
- **Suspense boundary key bug.** The `key={t}` on the per-row Suspense is critical. Without it, React reuses one boundary and all rows wait for the slowest. Explicitly called out in the implementation.
- **Mobile.** Stacked card fallback is a single `lg:hidden` swap. Won't be polished beyond functional.

## Success criteria

- `/watchlist` opens to the Roll-up tab by default.
- All watchlisted tickers visible as one row each with 5 cells filled.
- First content paints in < 1 second (snapshot cells from Redis); slowest cell paints in < 3 seconds.
- All deep links work and land on the correct tab.
- Tests pass (target ~21 new unit tests + 1 E2E, full existing suite green).
- Mobile width gracefully falls back to stacked cards (no horizontal scroll on a phone-sized viewport).
