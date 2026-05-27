# Slice 5B — News & Sentiment Analysis

**Date:** 2026-05-27
**Status:** Design approved, plan pending
**Scope:** Slice 5B only (Slice 5A — technical analysis tab — already shipped).

## Goal

Add a `/stock/[ticker]/news` tab that lists recent news articles for the ticker, each scored for sentiment (bullish/neutral/bearish) using Qwen. Show an aggregate sentiment score over the last 20 articles. User triggers refresh manually via a button — no scheduled cron, no surprise LLM costs.

## Non-Goals

- Cron-based scheduled refresh (decided against — user controls when LLM cost is incurred)
- Article body scraping (FD news API returns metadata only)
- Multi-ticker / cross-watchlist news feed
- Historical sentiment time-series visualization
- Per-article notes, annotations, or user-curated tags
- Filtering by source / sentiment / date range (defer until real usage shows what filters matter)
- Auto-trading or alerts based on sentiment shifts

## Architecture

Three layers, all reusing existing project conventions:

```
┌─────────────────────────────────────────────────────────────────┐
│  Next.js server component at /stock/[ticker]/news/page.tsx       │
│    1. requireUserId()                                            │
│    2. NewsService.getList(ticker) + getAggregate(ticker)         │
│    3. Render <NewsView> with article list + aggregate bar        │
└─────────────────────────────────────────────────────────────────┘
                                                              │
                                                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  POST /api/tickers/[ticker]/news  (refresh endpoint, gated by   │
│  Stack Auth + Redis-backed rate limit 10/min/user)              │
│    1. NewsService.refresh(ticker)                                │
│       a. FinancialDatasetsProvider.news(ticker, limit=100)       │
│       b. Upsert rows into news_articles, dedupe by (ticker,url)  │
│       c. Query rows WHERE sentiment IS NULL                      │
│       d. Single Qwen sentimentBatch() call over those titles     │
│       e. UPDATE each row with sentiment/confidence/scored_at     │
│       f. Insert one refresh_runs row                             │
│    2. Return { fetched, newArticles, scored, durationMs }        │
└─────────────────────────────────────────────────────────────────┘
                                                              │
                                                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layers:                                                         │
│                                                                  │
│  lib/providers/financial-datasets.ts                             │
│    NEW method: news(ticker, limit) → NewsArticleMeta[]           │
│                                                                  │
│  lib/providers/qwen.ts                                           │
│    NEW: sentimentBatch({ titles, model?, promptVersion? })       │
│       → Array<{ sentiment, confidence }>                         │
│                                                                  │
│  lib/services/news.ts                                            │
│    NEW: NewsService { getList, getAggregate, refresh }           │
│                                                                  │
│  lib/db/schema.ts                                                │
│    NEW table: news_articles                                      │
└─────────────────────────────────────────────────────────────────┘
```

**Key invariants:**

- **No cron, no scheduled work.** All refreshes are user-initiated. Predictable cost.
- **Idempotent refresh.** Same article fetched twice (by URL) does not duplicate.
- **Already-scored articles are never re-scored automatically** in v1. The `scoring_prompt_version` column is stored alongside each score so a future manual re-score script can target stale-version rows when we update the prompt. Not in scope for this slice.
- **Sentiment is title-only.** FD does not expose article bodies.
- **Single batched LLM call per refresh.** All unscored titles for a ticker go into one Qwen prompt. ~50–100 titles = ~$0.0005 per call.
- **No new external dependencies.** FD HTTP endpoint exists at `/news`. Qwen provider already wired from Slice 2B.

## Data Model

**New table** `news_articles` (Drizzle schema):

```ts
export const newsArticles = pgTable(
  'news_articles',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    ticker: text('ticker')
      .notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    title: text('title').notNull(),
    source: text('source').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    // Nullable until scored
    sentiment: text('sentiment'),                                // 'bullish' | 'neutral' | 'bearish'
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    scoredAt: timestamp('scored_at', { withTimezone: true }),
    scoringModel: text('scoring_model'),
    scoringPromptVersion: text('scoring_prompt_version')
  },
  (t) => ({
    tickerUrlUniq: uniqueIndex('news_articles_ticker_url_uniq').on(t.ticker, t.url),
    tickerDateIdx: index('news_articles_ticker_date_idx').on(t.ticker, t.publishedAt.desc())
  })
);
```

**RLS** (`lib/db/migrations/9994_rls_news_articles.sql`):

```sql
ALTER TABLE public.news_articles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated read news_articles" ON public.news_articles;
CREATE POLICY "authenticated read news_articles"
  ON public.news_articles FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.news_articles TO authenticated;
```

Writes go through `getServiceDb()` which bypasses RLS — same pattern as `filings` / `filing_chunks` / `filing_summaries`.

## Provider Layer

**`FinancialDatasetsProvider.news`** — new method on the existing class:

```ts
async news(ticker: string, limit: number): Promise<NewsArticleMeta[]> {
  const out = await this.request<{ news: NewsArticleMeta[] }>(
    `/news?ticker=${encodeURIComponent(ticker)}&limit=${limit}`
  );
  return out.news ?? [];
}
```

Returns:

```ts
interface NewsArticleMeta {
  ticker: string;
  title: string;
  source: string;
  date: string;          // ISO 8601 with timezone, e.g. "2026-05-27T11:53:25+00:00"
  url: string;
}
```

Error handling matches existing FD methods: 404 → `NotFoundError`, 429 → `RateLimitError`, anything else → `UnknownProviderError`. Since yfinance has no news method, the service-level fallback chain does NOT cover news — if FD fails, the refresh fails. This is acceptable; news isn't on the critical path.

**`QwenProvider.sentimentBatch`** — new method:

```ts
async sentimentBatch(req: {
  titles: string[];
  ticker?: string;
  model?: string;           // default 'qwen-turbo'
  promptVersion?: string;   // default 'v1'
}): Promise<Array<{ sentiment: 'bullish' | 'neutral' | 'bearish'; confidence: number }>>;
```

**Prompt v1 (locked):**

System message:
> You classify stock-news headlines. For each headline, decide whether the most likely market reaction is `bullish`, `bearish`, or `neutral`, with a `confidence` between 0.0 and 1.0. Output ONLY a JSON array of objects, no prose. Each object: `{"sentiment": "...", "confidence": 0.0-1.0}`. The array must be the same length as the input and in the same order.

User message:
```
Classify these N headlines about ${ticker ?? 'a public company'}:
1. <title>
2. <title>
...
```

The Qwen response is parsed as JSON. On any parse failure, the method returns an array of `{ sentiment: 'neutral', confidence: 0 }` of the input length — never throws. Logged as a warning.

Confidence is bounded to `[0.0, 1.0]` after parse.

## NewsService

```ts
class NewsService {
  // Returns rows for a ticker, newest first, up to `limit`. Read-only.
  async getList(ticker: string, limit = 50): Promise<NewsArticle[]>;

  // Bin last N articles by sentiment. score = (bullish - bearish) / total.
  // Articles with sentiment IS NULL are excluded from the bins.
  async getAggregate(ticker: string, lastN = 20): Promise<NewsAggregate>;

  // Fetch from FD, dedupe, score unscored titles via Qwen, write to DB.
  async refresh(ticker: string): Promise<NewsRefreshSummary>;
}

interface NewsArticle {
  id: string;
  ticker: string;
  url: string;
  title: string;
  source: string;
  publishedAt: Date;
  sentiment: 'bullish' | 'neutral' | 'bearish' | null;
  confidence: number | null;
}

interface NewsAggregate {
  totalScored: number;       // articles in the aggregate (excludes nulls)
  bullish: number;
  neutral: number;
  bearish: number;
  score: number;             // (bullish - bearish) / totalScored, NaN-safe (0 when empty)
  lastRefresh: Date | null;  // max(fetchedAt) over scored rows
}

interface NewsRefreshSummary {
  ticker: string;
  fetched: number;           // total articles returned by FD
  newArticles: number;       // rows inserted (deduped)
  scored: number;            // rows newly scored this refresh
  durationMs: number;
}
```

**`refresh()` flow:**

1. `const fetched = await provider.news(ticker, 100)` — capped at 100/refresh
2. Map each into a Drizzle insert row; `.onConflictDoNothing()` (composite unique key `(ticker, url)`)
3. SELECT rows where `sentiment IS NULL` for this ticker, ordered by `published_at DESC`, limit 100
4. If non-empty: `qwen.sentimentBatch({ titles, ticker })` — single batch call
5. For each result, UPDATE the matching row with sentiment/confidence/scored_at/scoring_model/scoring_prompt_version
6. INSERT a `refresh_runs` row with `kind='news'`, `ok=true`, `source_used='financial_datasets+qwen'`
7. Return summary

Errors during refresh:
- FD call fails → catch, INSERT `refresh_runs` with `ok=false` + error, rethrow as `ProviderError`
- Qwen call fails → catch, log warning, leave rows with `sentiment IS NULL` (will be retried on next refresh), still INSERT `refresh_runs` with `ok=false`

## API Routes

```
GET  /api/tickers/[symbol]/news
  Auth required. Returns:
    { articles: NewsArticle[]; aggregate: NewsAggregate }

POST /api/tickers/[symbol]/news
  Auth required. Rate limit 10/min/user (Redis-backed, existing pattern).
  Body: empty.
  Triggers NewsService.refresh(symbol). Returns:
    NewsRefreshSummary
```

Validation: ticker must match `/^[A-Z][A-Z.]{0,5}$/`, company row must exist (404 otherwise).

## UI

**Page layout** at `/stock/[ticker]/news`:

```
┌──────────────────────────────────────────────────────────────────┐
│  AAPL · News & Sentiment                  [Refresh news] button   │
│                                                                  │
│  Aggregate (last 20 articles)                                    │
│  ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░  Bullish 12 · Neutral 6 · Bearish 2     │
│  Score: +0.50  ·  Last refresh: 2026-05-27 15:42 UTC             │
├──────────────────────────────────────────────────────────────────┤
│  Recent articles                                                 │
│                                                                  │
│  ● BULLISH (0.82)   2026-05-27 11:53                             │
│  Analysts Offer Insights on Technology Companies: Apple (AAPL)…  │
│  The Globe and Mail  ↗                                           │
│                                                                  │
│  ● BEARISH (0.74)   2026-05-27 11:14                             │
│  Verdence Capital Advisors LLC Lowers Position in Apple Inc.     │
│  MarketBeat  ↗                                                   │
│  …                                                               │
└──────────────────────────────────────────────────────────────────┘
```

**Empty state** (zero rows in DB): heading + "No news fetched yet. Click **Refresh news** to pull recent articles."

**Refresh button behavior:**
- Disabled during in-flight request, shows spinner
- On success: surfaces toast "Fetched N new articles, scored M titles", then re-fetches list + aggregate
- On rate-limit (429): toast "Refreshing too quickly — try again in a minute"
- On other failure: toast with error message

**Sentiment badge colors** (Tailwind):
- Bullish → green-600 (matches Slice 5A signal styling)
- Bearish → red-600
- Neutral → muted-foreground

**Tab nav update:** All 5 existing dashboard pages get a new `<TabsTrigger value="news">` between "Technical" and "Filings". The new news page also includes the full tab nav block.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `lib/db/schema.ts` | Modify | Add `newsArticles` table |
| `lib/db/migrations/0009_<random>.sql` | Create (via drizzle-kit) | DDL for newsArticles |
| `lib/db/migrations/9994_rls_news_articles.sql` | Create | RLS policy |
| `lib/providers/types.ts` | Modify | Add `NewsArticleMeta` + extend `QwenProvider` method signature |
| `lib/providers/financial-datasets.ts` | Modify | Add `news()` method |
| `lib/providers/qwen.ts` | Modify | Add `sentimentBatch()` method |
| `lib/services/news.ts` | Create | `NewsService` |
| `app/api/tickers/[symbol]/news/route.ts` | Create | GET + POST handlers |
| `scripts/try-news.ts` | Create | `pnpm try-news <ticker>` smoke script |
| `app/(app)/stock/[ticker]/news/page.tsx` | Create | Server component |
| `app/(app)/stock/[ticker]/news/_components/news-view.tsx` | Create | Client wrapper with refresh button |
| `app/(app)/stock/[ticker]/news/_components/sentiment-aggregate-bar.tsx` | Create | Stacked sentiment bar |
| `app/(app)/stock/[ticker]/news/_components/article-row.tsx` | Create | Single article row component |
| `app/(app)/stock/[ticker]/page.tsx` | Modify | Add News to tab nav |
| `app/(app)/stock/[ticker]/financials/page.tsx` | Modify | Same |
| `app/(app)/stock/[ticker]/technical/page.tsx` | Modify | Same |
| `app/(app)/stock/[ticker]/filings/page.tsx` | Modify | Same |
| `app/(app)/stock/[ticker]/ask/page.tsx` | Modify | Same |
| `tests/providers/financial-datasets.test.ts` | Modify | Add `news()` tests with FD response fixture |
| `tests/providers/qwen.test.ts` | Modify | Add `sentimentBatch()` tests with mocked OpenAI client |
| `tests/integration/news-service.test.ts` | Create | Integration tests for NewsService |
| `tests/integration/api-tickers-news.test.ts` | Create | Integration tests for GET + POST routes |
| `tests/integration/news-articles-rls.test.ts` | Create | RLS smoke (authenticated SELECT, anon denied) |
| `lib/providers/__fixtures__/fd-news-aapl.json` | Create | Sample FD news response (use what we sampled in brainstorm) |
| `lib/providers/__fixtures__/qwen-sentiment-response.json` | Create | Sample Qwen sentiment JSON response |

## Testing Matrix

| Layer | Test | Asserts |
|---|---|---|
| `FinancialDatasetsProvider.news` | Unit, mocked HTTP | Returns array, error mapping (404/429/402), correct query params |
| `QwenProvider.sentimentBatch` | Unit, mocked OpenAI client | Returns same-length array, parses JSON, bounds confidence to [0,1], all-neutral fallback on parse error |
| `NewsService.refresh` (integration) | Real DB, mocked providers | Dedupe by URL, only-NULL re-scored, refresh_runs recorded, summary counts correct |
| `NewsService.getList` (integration) | Real DB | Sorted by published_at DESC, limit honored |
| `NewsService.getAggregate` | Real DB | Correct bin counts, score formula, excludes nulls |
| `GET /api/tickers/[symbol]/news` | Integration | Auth required (401), valid ticker, returns `{ articles, aggregate }` shape |
| `POST /api/tickers/[symbol]/news` | Integration | Auth required, rate limited, summary returned |
| RLS smoke | Authenticated user can SELECT, anon cannot | Mirror of filings RLS test |

## Rollout (Plan Tasks)

1. **Schema** — Drizzle table + RLS migration + apply to both Neon branches via `_apply.ts`
2. **FD provider** — `news()` method + fixture + 3 unit tests
3. **Qwen provider** — `sentimentBatch()` method + fixture + 4 unit tests (success, parse fail, confidence bounds, batch size)
4. **NewsService** — `refresh` + `getList` + `getAggregate` with 6 integration tests
5. **API routes + try-news smoke + RLS smoke** — GET + POST + the smoke script + RLS test
6. **UI components** — `<SentimentAggregateBar>`, `<ArticleRow>`, `<NewsView>` with refresh state
7. **News page + tab nav** — Server component + add "News" tab to all 5 existing pages
8. **Push + CI + Vercel + browser smoke** — Run `pnpm try-news` to populate, then visit prod page

## Cost Analysis

| Operation | Frequency | Cost |
|---|---|---|
| FD news fetch | Per refresh, manual | Free (already paid for via FD subscription) |
| Qwen sentiment scoring | Per refresh, ~100 titles batched | ~$0.0005/refresh on `qwen-turbo` |
| Storage | Per article ~300 bytes | Negligible (10K articles = 3MB) |

**Expected annual cost:** if user refreshes news for 5 tickers once a week, that's ~250 refreshes × $0.0005 = $0.125/year. Even daily refreshes for 10 tickers would be ~$2/year. Effectively free.

## Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| FD returns malformed news payload | Low | `out.news ?? []` defensive fallback; existing FD error mapping covers non-JSON |
| Qwen returns malformed JSON | Medium | Parse via try/catch; all-neutral fallback; log warning |
| Confidence value out of bounds in Qwen output | Low | Clamp to [0, 1] after parse |
| Title contains injection-attempt characters | Low | Titles are JSON-escaped in the prompt; Qwen system prompt is fixed |
| News article URL changes between fetches (e.g., redirect chain) | Medium | Treated as a new article — acceptable for v1 |
| Slow Qwen response blocks the refresh request beyond 30s timeout | Low | If Qwen is slow or times out, the refresh records `ok=false` and unscored rows remain `sentiment IS NULL` for the next refresh to pick up. Vercel route default 30s timeout applies; we may need to set `maxDuration` on the route if observed latency creeps up |
| RLS regression on news_articles when applying schema | Medium | Apply RLS migration via direct `_apply.ts` to BOTH branches (never `drizzle-kit push --force`); verify with `_check.ts` |
| Rate-limit abuse via repeated POST clicks | Low | Existing 10/min/user limit via Redis covers this |

## Success Criteria

1. Visiting `/stock/AAPL/news` (after `pnpm try-news AAPL` once) shows ~50–100 articles, all with sentiment badges and confidence values.
2. Aggregate bar visually reflects the bin distribution.
3. Clicking **Refresh news** completes in under 10s, surfaces a toast, and any new articles appear in the list.
4. CI green: lint, typecheck, unit, integration, build.
5. NVDA / MSFT / GOOGL / JD all work identically.
6. RLS verified: anon SELECT denied, authenticated SELECT works.
