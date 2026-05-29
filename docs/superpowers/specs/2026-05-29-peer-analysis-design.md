# Peer Analysis — Design Spec

**Date:** 2026-05-29
**Status:** Approved by user; ready for implementation plan.

## Goal

Given any ticker the user is looking at, surface its 5 most-comparable peers
(semantic + size-band) in a side-by-side metrics table on a new
`/stock/[TICKER]/peers` tab. This builds on the Discovery slice — peers are a
natural follow-on use of the description embeddings we just seeded.

## Non-goals

- User curation of the peer list (deferred to a follow-up slice).
- Cross-country peer sets when target has good same-country options.
- Time-series peer comparison ("what were peers' P/Es a year ago?").
- Saving peer sets as comparison "boards."
- Peer P/E charts / scatter plots beyond the table.
- Quant screener (rules-based filtering of the broad universe) — separate slice.

## Architecture

Two existing ticker universes coexist in the codebase:

- `companies_universe` (broad, ~6,500 rows) — has description embeddings + name +
  country + market cap. Used to find candidates.
- `companies` + `snapshots` + `fundamentals` (deep, per-user watchlist) — has
  P/E, EV/EBITDA, ROE, fundamentals lineitems. Used to render metric columns.

The peer flow bridges them:

```
GET /api/stock/[ticker]/peers?k=5
   │
   ▼
PeersService.getPeers(targetTicker, k=5)
   │
   ├──► 1. lookupTarget()           — companies_universe row (embedding, country, mcap)
   │
   ├──► 2. findCandidates()         — vector cosine + size band + same country
   │                                   with fallback chain (no_country → no_size → global)
   │
   ├──► 3. ensureDeepData(peers)    — promote-on-demand into `companies`, fetch
   │                                   snapshot + fundamentals if missing or stale (>24h)
   │
   └──► 4. joinMetrics()            — single SQL: target + K peers with metrics joined

Returns PeersResult { target, peers, fallback, k }
```

**Key insight:** the SQL candidate query is fast (~50ms over 6,500 rows via HNSW).
The slow step is `ensureDeepData()` — up to K parallel yfinance subprocess calls
on first visit, ~10s wall-clock. Subsequent visits hit `companies` directly and
return in ~500ms.

## Peer-Candidate Query

```sql
SELECT
  ticker, name, country, market_cap, sector, industry,
  1 - (description_embedding <=> $1::vector) AS similarity
FROM companies_universe
WHERE description_embedding IS NOT NULL
  AND ticker != $2                                    -- exclude target
  AND country = $3                                    -- same country as target
  AND market_cap BETWEEN $4 * 0.3 AND $4 * 3.0        -- 0.3x..3x size band
ORDER BY description_embedding <=> $1::vector         -- cosine ascending
LIMIT $5;                                              -- K = 5
```

Inputs from the target row: `embedding`, `country`, `market_cap`.

### Fallback chain

If the strict query yields < K rows, relax one filter at a time:

1. **strict** — all filters active (default)
2. **no_country** — drop country filter (still semantic + size)
3. **no_size** — drop size band (still semantic + same country)
4. **global** — drop both (pure semantic, top-K globally)

The first level to return ≥ K rows wins. The response records which level
succeeded (`fallback: 'strict' | 'no_country' | 'no_size' | 'global'`) so the
UI can footnote "Showing global peers; not enough same-country matches."

### Edge cases

- **Target not in `companies_universe`** (obscure ADR the seeder missed):
  return `{ peers: [], fallback: 'target_missing' }`. UI shows a hint to wait
  for next seeder run.
- **Target has no `description_embedding`** (seeder failed to enrich): same as
  above — `fallback: 'target_missing'`. No embedding means no semantic
  neighbors possible.

## Promote-on-Demand Ingest

`PeersService.ensureDeepData(peerTickers)` ensures each peer has fresh
`snapshots` + `fundamentals` rows.

- Reuses the **existing add-ticker pipeline** (the same path the Add Ticker
  dialog already uses): insert into `companies` if absent, call yfinance for
  `.info()` + snapshot fields → upsert `snapshots`, call yfinance for
  income/balance/cashflow → upsert `fundamentals`.
- **Idempotency:** skip yfinance if `companies.last_refreshed_at` is within 24h.
- **Parallelism:** up to K peer ingests fire in parallel via
  `Promise.allSettled`. yfinance subprocess handles ~5 concurrent calls without
  rate-limiting in our existing refresh runner.
- **Per-peer timeout:** 30s. Slow peer doesn't block others.
- **Partial failure:** if one peer's ingest throws (delisted, malformed `.info`,
  network blip), it's logged and the row appears in the response with
  `dataStatus: 'unavailable'` (no snapshot row exists). Other peers render. Request never fails as a
  whole due to one peer.
- **Promoted as ordinary tickers**, not seed tickers (`is_seed = false`). They
  appear in autocomplete and can be added to a watchlist with one click. The
  existing nightly refresh cron keeps them fresh.

**First-load target:** ≤ 15s wall-clock for cold cache (5 fresh peers × ~3s
yfinance each, parallel). Subsequent loads: < 500ms.

## Schema

**No new tables required.** Everything is computable from existing schema:

- `companies_universe` — candidate list
- `companies` + `snapshots` + `fundamentals` — metric columns after ingest
- Quality scores (existing storage from Quality slice) — F-score column

A `peer_set_cache` table is explicitly **deferred** — the SQL candidate query
runs in <100ms on 6,500 rows via HNSW, so it isn't the bottleneck. Add caching
only if profiling shows it's needed.

**RLS:** neither `companies_universe` nor `companies` are user-scoped, so no
new policies are needed. Existing Stack Auth + service-role bypass continues
to work the same way.

## Service + API

### `PeersService` (`lib/services/peers.ts`)

```ts
class PeersService {
  constructor(private deps: {
    db: ServiceDb;
    yfinanceProvider: YFinanceProvider;
    snapshotService: SnapshotService;        // existing — ingest path
    fundamentalsService: FinancialsService;  // existing — ingest path
    qualityService: QualityService;          // existing — F-score
  }) {}

  async getPeers(targetTicker: string, k = 5): Promise<PeersResult> {
    // 1. lookupTarget — companies_universe row
    // 2. findCandidates with fallback chain
    // 3. ensureDeepData for all peers in parallel
    // 4. joinMetrics — single SQL returning target + peer rows
  }
}
```

### Types

```ts
interface PeerRow {
  ticker: string;
  name: string;
  country: string | null;
  sector: string | null;
  marketCap: number | null;
  pe: number | null;
  evEbitda: number | null;
  revGrowthYoy: number | null;     // computed from fundamentals
  grossMargin: number | null;       // computed from fundamentals
  roe: number | null;               // computed from fundamentals
  fScore: number | null;            // from quality service
  similarity: number | null;        // null for the target row
  dataStatus: 'available' | 'unavailable';   // 'unavailable' = no snapshot row exists (ingest failed and no prior data)
}

interface PeersResult {
  target: PeerRow;
  peers: PeerRow[];                 // length ≤ K
  fallback: 'strict' | 'no_country' | 'no_size' | 'global' | 'target_missing';
  k: number;
}
```

### API: `GET /api/stock/[ticker]/peers?k=5`

- Standard Next.js route handler under `app/api/stock/[ticker]/peers/route.ts`.
- Auth: Stack Auth + user lookup (consistent with other per-ticker routes).
- Validates `ticker` (uppercase, regex `^[A-Z][A-Z.]{0,5}$`), `k` (default 5,
  max 10, min 1).
- Returns `PeersResult` JSON.
- Cache headers: `Cache-Control: private, max-age=300` (5 min — peer set + metrics
  are stable for short windows).

**No new provider methods.** Reuses existing `YFinanceProvider.info()` +
`.statements()` via the existing snapshot/fundamentals services.

## UI

### Route: `app/(app)/stock/[ticker]/peers/page.tsx`

New "Peers" tab on the ticker dashboard, slotted alongside the existing tabs.

### Desktop layout

```
[Tab nav: Overview | Financials | ... | Peers | ... | Ask]
─────────────────────────────────────────────────
[Target row, slightly emphasized]
NVDA   NVIDIA Corp  US  $3.2T  62.4x  48.2x  +85%  74%  102%  9 ★

[Divider, then K peer rows ordered by similarity]
AMD    Advanced Micro  US  $245B  38.1x  31.4x  +24%  51%  16%  6 ★   89%
AVGO   Broadcom        US  $890B  72.3x  29.8x  +42%  63%  31%  7 ★   86%
...
─────────────────────────────────────────────────
[Footer: "5 peers semantically similar to NVDA, market cap 0.3x–3x, US-listed.
 Showing strict matches."]
```

Columns: **Ticker · Name · Country · Market cap · P/E · EV/EBITDA · Rev growth
YoY · Gross margin · ROE · F-score · Similarity %**

- **Ticker** links to that peer's Overview tab (peers become navigable).
- **Quartile shading** — each metric column color-coded by quartile rank within
  the peer set (green = best, red = worst, neutral for middle). Higher-is-better
  metrics (rev growth, ROE, F-score, margin) vs lower-is-better (P/E, EV/EBITDA)
  are inverted accordingly.
- **Similarity column** — only shown for peer rows, not the target.
- **Unavailable cells** — render "—" with a `title` tooltip explaining why.

### Loading strategy: server-component Suspense streaming

Same pattern as the Watchlist Roll-up slice. The page is a server component:

1. Does the SQL candidate query (~50ms) — peer ticker list is known immediately.
2. Renders the table shell + one `<Suspense>`-wrapped row per peer ticker.
3. Each peer-row server component does its own `ensureDeepData(peer)` +
   metric join. As each row's promise resolves, Next.js streams the rendered
   HTML for that row to the client.

User sees the table skeleton instantly, then individual rows fill in as their
yfinance ingest completes. No client-side fetch orchestration needed — the
JSON API exists separately (for tests and potential external use), but the
page itself uses pure server-component streaming.

### Mobile

Stacks vertically. Each peer becomes a card with rows of `metric: value` pairs,
same quartile color treatment. Pattern from `WatchlistRow.mobile.tsx`.

### Empty / error states

- **Target not in universe:** "We don't have description data for NVDA yet.
  [Refresh universe] button — or wait for tomorrow's sync."
- **Fewer than K peers:** render what we have, footer notes the fallback chain.

### Components

1. `peers-table.tsx` (server) — shell with header + body; dispatches one
   Suspense-wrapped `<PeerRow>` per peer ticker
2. `peer-row.tsx` (server) — does its own ingest + metric fetch; renders cells
3. `peer-row-skeleton.tsx` (server) — fallback shown while `<PeerRow>` is loading
4. `peer-cell.tsx` (server) — pure rendering: value + quartile color class
5. `peer-row.mobile.tsx` (server) — mobile card variant of `<PeerRow>`
6. `peers-empty.tsx` (server) — empty / error states (target missing, no peers)
7. `quartile-helpers.ts` (pure) — rank metrics within peer set, return color class

## Testing

### Unit tests (pure functions, vitest)

1. **`quartile-helpers.ts`:**
   - Higher-is-better metrics (rev growth, ROE, F-score, margin) → top quartile = green
   - Lower-is-better metrics (P/E, EV/EBITDA when positive) → bottom quartile = green
   - All-null column → no coloring
   - Single row → no quartile distinction
   - Ties handled deterministically (first occurrence wins boundary)

2. **`peer-fallback-chain.ts`** (extracted from `findCandidates`):
   - Returns 'strict' when ≥ K rows match all filters
   - Returns 'no_country' when same-country < K
   - Returns 'no_size' when relaxing country still gives < K
   - Returns 'global' when no_size still gives < K
   - Returns 'target_missing' when target absent

### Integration tests (test Neon branch, vitest integration config)

3. **`PeersService.getPeers`:**
   - Happy path: target with sufficient strict peers → target + 5 peer rows with metrics joined
   - Promote-on-demand: peer missing from `companies` → inserted, snapshot fetched (mocked yfinance), then included
   - Idempotency: peer with `last_refreshed_at` < 24h → no yfinance call
   - Partial failure: one peer's yfinance throws → that row has `dataStatus: 'unavailable'`, others render
   - Fallback chain: insufficient strict matches → returns via no_country fallback, with `fallback: 'no_country'` in response
   - Target missing from universe → returns `{ peers: [], fallback: 'target_missing' }`

4. **`GET /api/stock/[ticker]/peers` route:**
   - 200 with valid ticker + K
   - 400 with invalid ticker format
   - 400 with K > 10 or K < 1
   - 401 when no auth
   - 5-min cache header present
   - JSON shape matches `PeersResult`

### E2E test (Playwright, one happy-path)

5. Authenticated user navigates to a watchlist ticker → clicks Peers tab →
   sees skeleton briefly → 5 peer rows render with quartile coloring →
   clicking a peer ticker navigates to that ticker's Overview.

## Error Handling

- **yfinance subprocess timeout (>30s per peer):** row marks
  `dataStatus: 'unavailable'` (no snapshot row exists). Log warning. Other peers unaffected.
- **DB connection failure mid-request:** standard 500 with retry hint.
  Server-component shell still renders, error boundary catches.
- **Vector query returns 0 rows after all fallbacks:** valid response with
  `peers: []` and `fallback: 'target_missing'`. UI shows helpful empty state.
- **Concurrent requests during ingest** (user hits refresh twice): snapshot
  upsert is idempotent on `(ticker)` primary key. yfinance gets hit twice —
  acceptable cost.
- **Target ticker case mismatch:** route normalizes to uppercase before lookup.
  URL `peers/nvda` and `peers/NVDA` resolve to the same target.

## Out of scope for v1 (explicit)

- User curation of peer list
- Cross-country peer sets when same-country has good options
- Time-series peer comparison
- Saving peer sets as comparison "boards"
- Peer P/E charts / scatter plots
