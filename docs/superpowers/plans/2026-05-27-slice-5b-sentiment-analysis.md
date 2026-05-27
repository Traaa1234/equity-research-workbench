# Slice 5B: News & Sentiment Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/stock/[ticker]/news` tab listing recent articles for the ticker with title-only sentiment scoring (bullish/neutral/bearish) and an aggregate bar. User-triggered refresh — no cron.

**Architecture:** New `news_articles` table backed by FD's `/news` endpoint and Qwen's `sentimentBatch` method. `NewsService` orchestrates: dedupe by URL, batch-score only NULL-sentiment rows, idempotent refresh. Server component reads from DB; refresh button POSTs to a dedicated endpoint.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Drizzle ORM, Postgres/Neon, Vitest, OpenAI SDK (Qwen), Tailwind/shadcn.

**Spec:** `docs/superpowers/specs/2026-05-27-slice-5b-sentiment-analysis-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `lib/db/schema.ts` | Modify | Add `newsArticles` table |
| `lib/db/migrations/<auto>.sql` | Create (drizzle-kit generate) | DDL for newsArticles |
| `lib/db/migrations/9994_rls_news_articles.sql` | Create | RLS policy for authenticated SELECT |
| `lib/providers/types.ts` | Modify | Add `NewsArticleMeta`, `SentimentLabel`, `SentimentScore`, extend `QwenProvider` |
| `lib/providers/financial-datasets.ts` | Modify | Add `news(ticker, limit)` method |
| `lib/providers/qwen.ts` | Modify | Add `sentimentBatch({ titles, ticker?, model?, promptVersion? })` method |
| `lib/providers/__fixtures__/fd-news-aapl.json` | Create | FD news response fixture |
| `lib/providers/__fixtures__/qwen-sentiment-response.json` | Create | Qwen sentiment response fixture |
| `lib/services/news.ts` | Create | `NewsService` with `getList`, `getAggregate`, `refresh` |
| `app/api/tickers/[symbol]/news/route.ts` | Create | GET (list+aggregate) + POST (refresh) |
| `scripts/try-news.ts` | Create | `pnpm try-news <ticker>` smoke script |
| `app/(app)/stock/[ticker]/news/page.tsx` | Create | Server component |
| `app/(app)/stock/[ticker]/news/_components/news-view.tsx` | Create | Client wrapper with refresh button |
| `app/(app)/stock/[ticker]/news/_components/sentiment-aggregate-bar.tsx` | Create | Stacked sentiment bar |
| `app/(app)/stock/[ticker]/news/_components/article-row.tsx` | Create | Single article row |
| `app/(app)/stock/[ticker]/page.tsx` | Modify | Add News to tab nav |
| `app/(app)/stock/[ticker]/financials/page.tsx` | Modify | Add News to tab nav |
| `app/(app)/stock/[ticker]/technical/page.tsx` | Modify | Add News to tab nav |
| `app/(app)/stock/[ticker]/filings/page.tsx` | Modify | Add News to tab nav |
| `app/(app)/stock/[ticker]/ask/page.tsx` | Modify | Add News to tab nav |
| `tests/providers/financial-datasets.test.ts` | Modify | Add `news()` tests |
| `tests/providers/qwen.test.ts` | Modify | Add `sentimentBatch()` tests |
| `tests/integration/news-service.test.ts` | Create | NewsService integration |
| `tests/integration/api-tickers-news.test.ts` | Create | API route integration |
| `tests/integration/news-articles-rls.test.ts` | Create | RLS smoke |
| `package.json` | Modify | Add `try-news` script |

---

## Task 1: Schema — `news_articles` table + RLS

**Files:**
- Modify: `lib/db/schema.ts` (add `newsArticles` definition)
- Generate: `lib/db/migrations/<auto>.sql` via `drizzle-kit generate`
- Create: `lib/db/migrations/9994_rls_news_articles.sql`

**CRITICAL: do NOT use `drizzle-kit push --force`** — apply via `_apply.ts` (lesson from Slice 2A T1.1).

- [ ] **Step 1.1: Add Drizzle table definition**

Edit `lib/db/schema.ts`. Append after the existing `qaHistory` table (the file already imports `numeric`, `text`, `timestamp`, `bigserial`, `index`, `uniqueIndex`):

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
    sentiment: text('sentiment'),                                       // 'bullish' | 'neutral' | 'bearish' | null
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

- [ ] **Step 1.2: Generate the Drizzle migration**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm exec drizzle-kit generate
```

Expected: a new migration file appears in `lib/db/migrations/` named like `0009_<random_word>.sql`. Open it; it should contain a `CREATE TABLE "news_articles"` statement plus two index creations. Note the exact filename for Step 1.4.

- [ ] **Step 1.3: Write the RLS migration**

Create `lib/db/migrations/9994_rls_news_articles.sql`:

```sql
-- RLS for Slice 5B: news_articles.
-- Same pattern as filings/filing_chunks: authenticated users read,
-- service role writes (BYPASSRLS).

ALTER TABLE public.news_articles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated read news_articles" ON public.news_articles;
CREATE POLICY "authenticated read news_articles"
  ON public.news_articles FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.news_articles TO authenticated;
```

- [ ] **Step 1.4: Apply both migrations to BOTH Neon branches**

Substitute `<auto-filename>` with the file Drizzle generated in Step 1.2.

```bash
pnpm exec tsx _apply.ts --target prod --file lib/db/migrations/<auto-filename>
pnpm exec tsx _apply.ts --target test --file lib/db/migrations/<auto-filename>
pnpm exec tsx _apply.ts --target prod --file lib/db/migrations/9994_rls_news_articles.sql
pnpm exec tsx _apply.ts --target test --file lib/db/migrations/9994_rls_news_articles.sql
```

All four should print `Applied ... OK`.

- [ ] **Step 1.5: Verify table + RLS on both branches**

Run the existing `_check.ts` (or write a small inline check):

```bash
pnpm exec tsx -e "
import { config } from 'dotenv'; config({ path: '.env.local' });
import postgres from 'postgres';
for (const [label, url] of [
  ['prod', process.env.DATABASE_URL_SERVICE_ROLE!],
  ['test', process.env.DATABASE_URL_TEST_SERVICE_ROLE!]
] as const) {
  const sql = postgres(url, { prepare: false, max: 1 });
  const cols = await sql\`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'news_articles' ORDER BY ordinal_position\`;
  console.log(\`\\n\${label.toUpperCase()} news_articles columns:\`);
  for (const c of cols) console.log(\`  \${c.column_name}: \${c.data_type}\`);
  const pols = await sql\`SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'news_articles'\`;
  console.log(\`  policies: \${pols.length}\`);
  for (const p of pols) console.log(\`    \${p.policyname}\`);
  await sql.end();
}
"
```

Expected output on both prod and test: 10 columns listed (id, ticker, url, title, source, published_at, fetched_at, sentiment, confidence, scored_at, scoring_model, scoring_prompt_version) and 1 policy `authenticated read news_articles`.

- [ ] **Step 1.6: Verify drizzle-kit thinks schema is in sync**

```bash
pnpm exec drizzle-kit generate
```

Expected: `No schema changes, nothing to migrate 😴`. If a new migration appears, delete it.

- [ ] **Step 1.7: Commit**

```bash
git add lib/db/schema.ts lib/db/migrations/
git commit -m "feat(schema): news_articles table + RLS for slice 5b

Applied via _apply.ts to both prod + test Neon branches.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: FD provider — `news()` method

**Files:**
- Modify: `lib/providers/types.ts` (add `NewsArticleMeta`)
- Modify: `lib/providers/financial-datasets.ts` (add `news()` method)
- Create: `lib/providers/__fixtures__/fd-news-aapl.json`
- Modify: `tests/providers/financial-datasets.test.ts` (add `news()` tests)

- [ ] **Step 2.1: Add the `NewsArticleMeta` type to `lib/providers/types.ts`**

Append to the existing types file:

```ts
// News article metadata as returned by Financial Datasets /news endpoint.
// FD provides metadata only — no article body.
export interface NewsArticleMeta {
  ticker: string;
  title: string;
  source: string;
  date: string;   // ISO 8601 with timezone, e.g. "2026-05-27T11:53:25+00:00"
  url: string;
}
```

- [ ] **Step 2.2: Create the FD news fixture**

Create `lib/providers/__fixtures__/fd-news-aapl.json`:

```json
{
  "news": [
    {
      "ticker": "AAPL",
      "title": "Analysts Offer Insights on Technology Companies: Apple (AAPL), Marvell (MRVL) and F5, Inc. (FFIV)",
      "source": "The Globe and Mail",
      "date": "2026-05-27T11:53:25+00:00",
      "url": "https://www.theglobeandmail.com/example-1"
    },
    {
      "ticker": "AAPL",
      "title": "Verdence Capital Advisors LLC Lowers Position in Apple Inc.",
      "source": "MarketBeat",
      "date": "2026-05-27T11:14:56+00:00",
      "url": "https://www.marketbeat.com/example-2"
    },
    {
      "ticker": "AAPL",
      "title": "Beirne Wealth Consulting Services LLC Sells 6,254 Shares of Apple Inc.",
      "source": "MarketBeat",
      "date": "2026-05-27T07:42:32+00:00",
      "url": "https://www.marketbeat.com/example-3"
    }
  ]
}
```

- [ ] **Step 2.3: Write the failing test**

Append to `tests/providers/financial-datasets.test.ts` (inside the existing `describe('FinancialDatasetsProvider', ...)` block):

```ts
  describe('.news()', () => {
    it('returns NewsArticleMeta[] from the /news endpoint', async () => {
      const fix = loadFixture('fd-news-aapl.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProvider(fetchMock);

      const result = await provider.news('AAPL', 100);

      expect(fetchMock).toHaveBeenCalledOnce();
      const calledUrl = fetchMock.mock.calls[0]![0] as string;
      expect(calledUrl).toContain('/news?ticker=AAPL&limit=100');
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        ticker: 'AAPL',
        title: 'Analysts Offer Insights on Technology Companies: Apple (AAPL), Marvell (MRVL) and F5, Inc. (FFIV)',
        source: 'The Globe and Mail',
        date: '2026-05-27T11:53:25+00:00',
        url: 'https://www.theglobeandmail.com/example-1'
      });
    });

    it('returns empty array when API returns no news', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ news: [] }));
      const provider = makeProvider(fetchMock);
      const result = await provider.news('UNKNOWN', 100);
      expect(result).toEqual([]);
    });

    it('handles missing news field defensively', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
      const provider = makeProvider(fetchMock);
      const result = await provider.news('AAPL', 100);
      expect(result).toEqual([]);
    });

    it('maps 404 to NotFoundError', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
      const provider = makeProvider(fetchMock);
      await expect(provider.news('AAPL', 100)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('maps 429 to RateLimitError', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
      const provider = makeProvider(fetchMock);
      await expect(provider.news('AAPL', 100)).rejects.toBeInstanceOf(RateLimitError);
    });
  });
```

- [ ] **Step 2.4: Run the test — confirm 5 fail**

```bash
pnpm test -- tests/providers/financial-datasets.test.ts
```

Expected: 5 new tests fail (undefined `news` method).

- [ ] **Step 2.5: Implement the `news()` method**

Add to `lib/providers/financial-datasets.ts`, alongside the other public methods (e.g., right after `earnings()` or at the end of the class):

```ts
  async news(ticker: string, limit: number): Promise<NewsArticleMeta[]> {
    const out = await this.request<{ news?: NewsArticleMeta[] }>(
      `/news?ticker=${encodeURIComponent(ticker.toUpperCase())}&limit=${limit}`
    );
    return out.news ?? [];
  }
```

At the top of `lib/providers/financial-datasets.ts`, extend the existing import from `'./types'` to include `NewsArticleMeta`. The existing import probably looks like:

```ts
import {
  // ... existing imports ...
} from './types';
```

Add `NewsArticleMeta` to that list.

- [ ] **Step 2.6: Run the test — confirm all pass**

```bash
pnpm test -- tests/providers/financial-datasets.test.ts
```

Expected: all tests pass (existing + 5 new).

- [ ] **Step 2.7: Commit**

```bash
git add lib/providers/types.ts lib/providers/financial-datasets.ts lib/providers/__fixtures__/fd-news-aapl.json tests/providers/financial-datasets.test.ts
git commit -m "feat(providers): FD news() method + fixture + 5 unit tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Qwen provider — `sentimentBatch()` method

**Files:**
- Modify: `lib/providers/types.ts` (add `SentimentLabel`, `SentimentScore`, extend `QwenProvider` interface)
- Modify: `lib/providers/qwen.ts` (add `sentimentBatch()` method)
- Create: `lib/providers/__fixtures__/qwen-sentiment-response.json`
- Modify: `tests/providers/qwen.test.ts` (add tests)

- [ ] **Step 3.1: Add types**

Append to `lib/providers/types.ts`:

```ts
export type SentimentLabel = 'bullish' | 'neutral' | 'bearish';

export interface SentimentScore {
  sentiment: SentimentLabel;
  confidence: number;   // clamped to [0, 1]
}

export interface SentimentBatchRequest {
  titles: string[];
  ticker?: string;
  model?: string;            // default 'qwen-turbo'
  promptVersion?: string;    // default 'v1'
}
```

Extend the existing `QwenProvider` interface to add the new method:

```ts
export interface QwenProvider {
  summarize(req: QwenSummarizeRequest): Promise<QwenSummarizeResult>;
  sentimentBatch(req: SentimentBatchRequest): Promise<SentimentScore[]>;
}
```

- [ ] **Step 3.2: Create the Qwen sentiment fixture**

Create `lib/providers/__fixtures__/qwen-sentiment-response.json` — this mimics an OpenAI-compatible chat completion response from DashScope, with the model returning a JSON array as the content:

```json
{
  "id": "chatcmpl-test",
  "object": "chat.completion",
  "created": 1779900000,
  "model": "qwen-turbo",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "[{\"sentiment\":\"bullish\",\"confidence\":0.82},{\"sentiment\":\"bearish\",\"confidence\":0.74},{\"sentiment\":\"neutral\",\"confidence\":0.55}]"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 150, "completion_tokens": 80, "total_tokens": 230 }
}
```

- [ ] **Step 3.3: Write the failing tests**

Append to `tests/providers/qwen.test.ts` (inside the existing `describe('QwenProviderImpl', ...)` block):

```ts
  describe('.sentimentBatch()', () => {
    it('parses Qwen JSON output into SentimentScore[]', async () => {
      const fix = loadFixture('qwen-sentiment-response.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProvider(fetchMock);

      const result = await provider.sentimentBatch({
        titles: ['Apple beats earnings', 'Apple suit dismissed', 'Apple announces meeting'],
        ticker: 'AAPL'
      });

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ sentiment: 'bullish', confidence: 0.82 });
      expect(result[1]).toEqual({ sentiment: 'bearish', confidence: 0.74 });
      expect(result[2]).toEqual({ sentiment: 'neutral', confidence: 0.55 });
    });

    it('returns all-neutral fallback on parse failure', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
        id: 'x', object: 'chat.completion', created: 1, model: 'qwen-turbo',
        choices: [{ index: 0, message: { role: 'assistant', content: 'this is not JSON' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      }));
      const provider = makeProvider(fetchMock);
      const result = await provider.sentimentBatch({ titles: ['a', 'b', 'c'] });
      expect(result).toEqual([
        { sentiment: 'neutral', confidence: 0 },
        { sentiment: 'neutral', confidence: 0 },
        { sentiment: 'neutral', confidence: 0 }
      ]);
    });

    it('clamps confidence to [0, 1]', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
        id: 'x', object: 'chat.completion', created: 1, model: 'qwen-turbo',
        choices: [{ index: 0, message: { role: 'assistant', content: '[{"sentiment":"bullish","confidence":1.5},{"sentiment":"bearish","confidence":-0.2}]' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }));
      const provider = makeProvider(fetchMock);
      const result = await provider.sentimentBatch({ titles: ['a', 'b'] });
      expect(result[0]!.confidence).toBe(1);
      expect(result[1]!.confidence).toBe(0);
    });

    it('returns all-neutral when response array length does not match titles length', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
        id: 'x', object: 'chat.completion', created: 1, model: 'qwen-turbo',
        choices: [{ index: 0, message: { role: 'assistant', content: '[{"sentiment":"bullish","confidence":0.5}]' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }));
      const provider = makeProvider(fetchMock);
      const result = await provider.sentimentBatch({ titles: ['a', 'b', 'c'] });
      expect(result).toHaveLength(3);
      expect(result.every(r => r.sentiment === 'neutral' && r.confidence === 0)).toBe(true);
    });

    it('normalizes invalid sentiment values to neutral', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
        id: 'x', object: 'chat.completion', created: 1, model: 'qwen-turbo',
        choices: [{ index: 0, message: { role: 'assistant', content: '[{"sentiment":"positive","confidence":0.8}]' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }));
      const provider = makeProvider(fetchMock);
      const result = await provider.sentimentBatch({ titles: ['a'] });
      expect(result[0]).toEqual({ sentiment: 'neutral', confidence: 0 });
    });
  });
```

- [ ] **Step 3.4: Run the test — confirm 5 fail**

```bash
pnpm test -- tests/providers/qwen.test.ts
```

Expected: 5 new tests fail (`sentimentBatch` not defined).

- [ ] **Step 3.5: Implement `sentimentBatch`**

At the top of `lib/providers/qwen.ts`, extend the existing import from `'./types'` to include `SentimentBatchRequest`, `SentimentScore`, `SentimentLabel`. Then add this method to the `QwenProviderImpl` class (alongside `summarize`):

```ts
  async sentimentBatch(req: SentimentBatchRequest): Promise<SentimentScore[]> {
    const model = req.model ?? 'qwen-turbo';
    const titles = req.titles;
    const n = titles.length;

    if (n === 0) return [];

    const systemPrompt = (
      'You classify stock-news headlines. For each headline, decide whether the most ' +
      'likely market reaction is `bullish`, `bearish`, or `neutral`, with a `confidence` ' +
      'between 0.0 and 1.0. Output ONLY a JSON array of objects, no prose. Each object: ' +
      '{"sentiment": "...", "confidence": 0.0-1.0}. The array MUST be the same length as ' +
      'the input and in the same order.'
    );

    const tickerLabel = req.ticker ? `$${req.ticker.toUpperCase()}` : 'a public company';
    const numbered = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');
    const userPrompt = `Classify these ${n} headlines about ${tickerLabel}:\n${numbered}`;

    const allNeutral = (): SentimentScore[] =>
      titles.map(() => ({ sentiment: 'neutral' as const, confidence: 0 }));

    let raw: string;
    try {
      const completion = await this.client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: Math.max(2000, n * 40)
      });
      raw = completion.choices[0]?.message?.content?.trim() ?? '';
      if (!raw) return allNeutral();
    } catch (err) {
      throw mapOpenAIError(err);
    }

    // Strip optional code fences (some models wrap JSON in ```json ... ```)
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return allNeutral();
    }

    if (!Array.isArray(parsed) || parsed.length !== n) {
      return allNeutral();
    }

    const VALID: SentimentLabel[] = ['bullish', 'neutral', 'bearish'];
    return parsed.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const obj = item as { sentiment?: unknown; confidence?: unknown };
        const sent = typeof obj.sentiment === 'string' && (VALID as string[]).includes(obj.sentiment)
          ? (obj.sentiment as SentimentLabel)
          : 'neutral';
        let conf = typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
          ? obj.confidence
          : 0;
        // Clamp; also reset confidence to 0 when sentiment was normalized to neutral
        if (sent === 'neutral' && typeof obj.sentiment === 'string' && obj.sentiment !== 'neutral') {
          conf = 0;
        }
        conf = Math.max(0, Math.min(1, conf));
        return { sentiment: sent, confidence: conf };
      }
      return { sentiment: 'neutral' as const, confidence: 0 };
    });
  }
```

- [ ] **Step 3.6: Run the test — confirm all pass**

```bash
pnpm test -- tests/providers/qwen.test.ts
```

Expected: all 5 new tests pass, existing tests still pass.

- [ ] **Step 3.7: Commit**

```bash
git add lib/providers/types.ts lib/providers/qwen.ts lib/providers/__fixtures__/qwen-sentiment-response.json tests/providers/qwen.test.ts
git commit -m "feat(providers): Qwen sentimentBatch() + fixture + 5 unit tests

Title-only sentiment classification. Single batched LLM call.
All-neutral fallback on any parse/shape failure.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `NewsService` + integration tests

**Files:**
- Create: `lib/services/news.ts`
- Create: `tests/integration/news-service.test.ts`

- [ ] **Step 4.1: Write the failing integration tests**

Create `tests/integration/news-service.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, newsArticles, refreshRuns } from '@/lib/db/schema';
import { NewsService } from '@/lib/services/news';
import type { NewsArticleMeta, SentimentScore } from '@/lib/providers/types';

config({ path: '.env.local' });

function mockFdProvider(news: NewsArticleMeta[]) {
  return {
    news: vi.fn().mockResolvedValue(news)
  };
}

function mockQwenProvider(scores: SentimentScore[]) {
  return {
    sentimentBatch: vi.fn().mockResolvedValue(scores)
  };
}

const SAMPLE_ARTICLES: NewsArticleMeta[] = [
  { ticker: 'AAPL', title: 'Apple beats earnings', source: 'CNBC', date: '2026-05-26T12:00:00+00:00', url: 'https://example.com/a' },
  { ticker: 'AAPL', title: 'Apple downgraded by analyst', source: 'MarketBeat', date: '2026-05-25T15:00:00+00:00', url: 'https://example.com/b' },
  { ticker: 'AAPL', title: 'Apple announces shareholder meeting', source: 'PR', date: '2026-05-24T09:00:00+00:00', url: 'https://example.com/c' }
];

const SAMPLE_SCORES: SentimentScore[] = [
  { sentiment: 'bullish', confidence: 0.85 },
  { sentiment: 'bearish', confidence: 0.78 },
  { sentiment: 'neutral', confidence: 0.6 }
];

describe('NewsService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.', cik: null });
  });

  it('refresh: fetches, dedupes by URL, scores via Qwen, writes refresh_run', async () => {
    const fd = mockFdProvider(SAMPLE_ARTICLES);
    const qwen = mockQwenProvider(SAMPLE_SCORES);
    const svc = new NewsService({ db: dbH.db, fdProvider: fd as any, qwenProvider: qwen as any });

    const summary = await svc.refresh('AAPL');

    expect(summary.fetched).toBe(3);
    expect(summary.newArticles).toBe(3);
    expect(summary.scored).toBe(3);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);

    const rows = await dbH.db.select().from(newsArticles).where(eq(newsArticles.ticker, 'AAPL'));
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.sentiment !== null)).toBe(true);

    const runs = await dbH.db.select().from(refreshRuns).where(eq(refreshRuns.ticker, 'AAPL'));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(true);
    expect(runs[0]!.kind).toBe('news');
  });

  it('refresh: idempotent — second call dedupes by URL, no duplicates', async () => {
    const fd = mockFdProvider(SAMPLE_ARTICLES);
    const qwen = mockQwenProvider(SAMPLE_SCORES);
    const svc = new NewsService({ db: dbH.db, fdProvider: fd as any, qwenProvider: qwen as any });

    await svc.refresh('AAPL');
    const second = await svc.refresh('AAPL');

    expect(second.fetched).toBe(3);
    expect(second.newArticles).toBe(0);     // dedupe by URL
    expect(second.scored).toBe(0);          // nothing new to score

    const rows = await dbH.db.select().from(newsArticles).where(eq(newsArticles.ticker, 'AAPL'));
    expect(rows).toHaveLength(3);            // still 3, no dupes
  });

  it('refresh: only scores rows with sentiment IS NULL', async () => {
    const fd = mockFdProvider(SAMPLE_ARTICLES);
    const qwen = mockQwenProvider(SAMPLE_SCORES);
    const svc = new NewsService({ db: dbH.db, fdProvider: fd as any, qwenProvider: qwen as any });

    // First refresh — all 3 get scored
    await svc.refresh('AAPL');
    expect(qwen.sentimentBatch).toHaveBeenCalledTimes(1);

    // Reset the Qwen mock call counter; add one more article via FD
    qwen.sentimentBatch.mockClear();
    const moreNews: NewsArticleMeta[] = [
      ...SAMPLE_ARTICLES,
      { ticker: 'AAPL', title: 'New headline', source: 'WSJ', date: '2026-05-27T10:00:00+00:00', url: 'https://example.com/d' }
    ];
    fd.news.mockResolvedValueOnce(moreNews);
    qwen.sentimentBatch.mockResolvedValueOnce([{ sentiment: 'bullish', confidence: 0.7 }]);

    const summary = await svc.refresh('AAPL');
    expect(summary.newArticles).toBe(1);
    expect(summary.scored).toBe(1);
    // Qwen called with only the new title, not all 4
    expect(qwen.sentimentBatch).toHaveBeenCalledOnce();
    const callArg = qwen.sentimentBatch.mock.calls[0]![0];
    expect(callArg.titles).toEqual(['New headline']);
  });

  it('refresh: records ok=false in refresh_runs when FD throws', async () => {
    const fd = { news: vi.fn().mockRejectedValue(new Error('FD down')) };
    const qwen = mockQwenProvider(SAMPLE_SCORES);
    const svc = new NewsService({ db: dbH.db, fdProvider: fd as any, qwenProvider: qwen as any });

    await expect(svc.refresh('AAPL')).rejects.toThrow();

    const runs = await dbH.db.select().from(refreshRuns).where(eq(refreshRuns.ticker, 'AAPL'));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(false);
    expect(runs[0]!.error).toContain('FD down');
  });

  it('getList: returns newest first, limit honored', async () => {
    const fd = mockFdProvider(SAMPLE_ARTICLES);
    const qwen = mockQwenProvider(SAMPLE_SCORES);
    const svc = new NewsService({ db: dbH.db, fdProvider: fd as any, qwenProvider: qwen as any });

    await svc.refresh('AAPL');
    const list = await svc.getList('AAPL', 2);

    expect(list).toHaveLength(2);
    expect(list[0]!.title).toBe('Apple beats earnings');        // newest (2026-05-26)
    expect(list[1]!.title).toBe('Apple downgraded by analyst'); // next (2026-05-25)
  });

  it('getAggregate: bins by sentiment + computes score', async () => {
    const fd = mockFdProvider(SAMPLE_ARTICLES);
    const qwen = mockQwenProvider(SAMPLE_SCORES);
    const svc = new NewsService({ db: dbH.db, fdProvider: fd as any, qwenProvider: qwen as any });

    await svc.refresh('AAPL');
    const agg = await svc.getAggregate('AAPL', 20);

    expect(agg.totalScored).toBe(3);
    expect(agg.bullish).toBe(1);
    expect(agg.neutral).toBe(1);
    expect(agg.bearish).toBe(1);
    // score = (1 - 1) / 3 = 0
    expect(agg.score).toBeCloseTo(0);
    expect(agg.lastRefresh).not.toBeNull();
  });

  it('getAggregate: returns zeros when no scored articles', async () => {
    const svc = new NewsService({
      db: dbH.db,
      fdProvider: { news: vi.fn() } as any,
      qwenProvider: { sentimentBatch: vi.fn() } as any
    });
    const agg = await svc.getAggregate('AAPL', 20);
    expect(agg.totalScored).toBe(0);
    expect(agg.bullish).toBe(0);
    expect(agg.neutral).toBe(0);
    expect(agg.bearish).toBe(0);
    expect(agg.score).toBe(0);
    expect(agg.lastRefresh).toBeNull();
  });
});
```

- [ ] **Step 4.2: Run the test — confirm all fail**

```bash
pnpm test:integration -- news-service
```

Expected: 7 new tests fail with `Cannot find module '@/lib/services/news'`.

- [ ] **Step 4.3: Implement `NewsService`**

Create `lib/services/news.ts`:

```ts
import { and, desc, eq, isNull } from 'drizzle-orm';
import { newsArticles, refreshRuns } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type {
  NewsArticleMeta,
  QwenProvider,
  SentimentLabel
} from '@/lib/providers/types';
import { logger } from '@/lib/logger';

const REFRESH_FETCH_LIMIT = 100;
const SCORING_PROMPT_VERSION = 'v1';
const SCORING_MODEL = 'qwen-turbo';

interface FdNewsProvider {
  news(ticker: string, limit: number): Promise<NewsArticleMeta[]>;
}

interface Deps {
  db: ServiceDb;
  fdProvider: FdNewsProvider;
  qwenProvider: QwenProvider;
}

export interface NewsArticle {
  id: string;
  ticker: string;
  url: string;
  title: string;
  source: string;
  publishedAt: Date;
  sentiment: SentimentLabel | null;
  confidence: number | null;
}

export interface NewsAggregate {
  totalScored: number;
  bullish: number;
  neutral: number;
  bearish: number;
  score: number;
  lastRefresh: Date | null;
}

export interface NewsRefreshSummary {
  ticker: string;
  fetched: number;
  newArticles: number;
  scored: number;
  durationMs: number;
}

export class NewsService {
  constructor(private readonly deps: Deps) {}

  async getList(ticker: string, limit = 50): Promise<NewsArticle[]> {
    const t = ticker.toUpperCase();
    const rows = await this.deps.db
      .select()
      .from(newsArticles)
      .where(eq(newsArticles.ticker, t))
      .orderBy(desc(newsArticles.publishedAt))
      .limit(limit);

    return rows.map((r) => ({
      id: String(r.id),
      ticker: r.ticker,
      url: r.url,
      title: r.title,
      source: r.source,
      publishedAt: r.publishedAt,
      sentiment: r.sentiment as SentimentLabel | null,
      confidence: r.confidence == null ? null : Number(r.confidence)
    }));
  }

  async getAggregate(ticker: string, lastN = 20): Promise<NewsAggregate> {
    const t = ticker.toUpperCase();
    const rows = await this.deps.db
      .select({
        sentiment: newsArticles.sentiment,
        fetchedAt: newsArticles.fetchedAt
      })
      .from(newsArticles)
      .where(eq(newsArticles.ticker, t))
      .orderBy(desc(newsArticles.publishedAt))
      .limit(lastN);

    let bullish = 0;
    let neutral = 0;
    let bearish = 0;
    let totalScored = 0;
    let lastRefresh: Date | null = null;

    for (const r of rows) {
      if (r.sentiment == null) continue;
      totalScored++;
      if (r.sentiment === 'bullish') bullish++;
      else if (r.sentiment === 'bearish') bearish++;
      else neutral++;
      if (lastRefresh === null || r.fetchedAt > lastRefresh) {
        lastRefresh = r.fetchedAt;
      }
    }

    const score = totalScored === 0 ? 0 : (bullish - bearish) / totalScored;
    return { totalScored, bullish, neutral, bearish, score, lastRefresh };
  }

  async refresh(ticker: string): Promise<NewsRefreshSummary> {
    const t = ticker.toUpperCase();
    const started = Date.now();
    const startedAt = new Date(started);

    let fetched = 0;
    let newArticles = 0;
    let scored = 0;

    try {
      // 1. Fetch from FD
      const articles = await this.deps.fdProvider.news(t, REFRESH_FETCH_LIMIT);
      fetched = articles.length;

      // 2. Upsert with dedupe by (ticker, url)
      if (articles.length > 0) {
        const beforeRows = await this.deps.db
          .select({ id: newsArticles.id })
          .from(newsArticles)
          .where(eq(newsArticles.ticker, t));
        const beforeCount = beforeRows.length;

        await this.deps.db
          .insert(newsArticles)
          .values(
            articles.map((a) => ({
              ticker: t,
              url: a.url,
              title: a.title,
              source: a.source,
              publishedAt: new Date(a.date)
            }))
          )
          .onConflictDoNothing();

        const afterRows = await this.deps.db
          .select({ id: newsArticles.id })
          .from(newsArticles)
          .where(eq(newsArticles.ticker, t));
        newArticles = afterRows.length - beforeCount;
      }

      // 3. Find unscored rows
      const unscored = await this.deps.db
        .select({ id: newsArticles.id, title: newsArticles.title })
        .from(newsArticles)
        .where(and(eq(newsArticles.ticker, t), isNull(newsArticles.sentiment)))
        .orderBy(desc(newsArticles.publishedAt))
        .limit(REFRESH_FETCH_LIMIT);

      // 4. Score in a single batch
      if (unscored.length > 0) {
        const scoresResult = await this.deps.qwenProvider.sentimentBatch({
          titles: unscored.map((u) => u.title),
          ticker: t,
          model: SCORING_MODEL,
          promptVersion: SCORING_PROMPT_VERSION
        });

        // 5. Update each row
        const scoredAt = new Date();
        for (let i = 0; i < unscored.length; i++) {
          const row = unscored[i]!;
          const score = scoresResult[i]!;
          await this.deps.db
            .update(newsArticles)
            .set({
              sentiment: score.sentiment,
              confidence: score.confidence.toFixed(3),
              scoredAt,
              scoringModel: SCORING_MODEL,
              scoringPromptVersion: SCORING_PROMPT_VERSION
            })
            .where(eq(newsArticles.id, row.id));
        }
        scored = unscored.length;
      }

      // 6. Record refresh_run
      await this.deps.db.insert(refreshRuns).values({
        ticker: t,
        kind: 'news',
        startedAt,
        completedAt: new Date(),
        ok: true,
        sourceUsed: 'financial_datasets+qwen'
      });

      return { ticker: t, fetched, newArticles, scored, durationMs: Date.now() - started };
    } catch (err) {
      await this.deps.db.insert(refreshRuns).values({
        ticker: t,
        kind: 'news',
        startedAt,
        completedAt: new Date(),
        ok: false,
        sourceUsed: 'financial_datasets+qwen',
        error: String(err).slice(0, 1000)
      });
      logger.warn({ ticker: t, err: String(err) }, 'news.refresh failed');
      throw err;
    }
  }
}
```

- [ ] **Step 4.4: Run the test — confirm all pass**

```bash
pnpm test:integration -- news-service
```

Expected: 7 tests pass.

- [ ] **Step 4.5: Commit**

```bash
git add lib/services/news.ts tests/integration/news-service.test.ts
git commit -m "feat(services): NewsService with refresh, getList, getAggregate

Dedupe by URL, batch-score only NULL-sentiment rows, idempotent.
Records one refresh_runs row per call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: API routes + try-news script + RLS smoke

**Files:**
- Create: `app/api/tickers/[symbol]/news/route.ts`
- Create: `scripts/try-news.ts`
- Modify: `package.json` (add `try-news` script)
- Create: `tests/integration/api-tickers-news.test.ts`
- Create: `tests/integration/news-articles-rls.test.ts`

- [ ] **Step 5.1: Write the route**

Create `app/api/tickers/[symbol]/news/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { QwenProviderImpl } from '@/lib/providers/qwen';
import { NewsService } from '@/lib/services/news';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const RATE_LIMIT_PER_MIN = 10;

interface RouteContext { params: { symbol: string }; }

let svc: NewsService | null = null;
function service(): NewsService {
  if (svc) return svc;
  const env = loadServerEnv();
  svc = new NewsService({
    db: getServiceDb(),
    fdProvider: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY }),
    qwenProvider: new QwenProviderImpl()
  });
  return svc;
}

async function rateLimit(userId: string): Promise<boolean> {
  const redis = getRedisCache();
  const key = `ratelimit:news-refresh:${userId}`;
  const cur = (await redis.get<number>(key)) ?? 0;
  if (cur >= RATE_LIMIT_PER_MIN) return false;
  await redis.set(key, cur + 1, 60);
  return true;
}

export async function GET(_req: Request, ctx: RouteContext) {
  try {
    await requireUserId();
    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid ticker: ${symbol}`);
    const svc_ = service();
    const [articles, aggregate] = await Promise.all([
      svc_.getList(symbol),
      svc_.getAggregate(symbol)
    ]);
    return ok({ articles, aggregate });
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/news GET' });
  }
}

export async function POST(_req: Request, ctx: RouteContext) {
  try {
    const userId = await requireUserId();
    if (!(await rateLimit(userId))) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': '60' } }
      );
    }
    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid ticker: ${symbol}`);
    const summary = await service().refresh(symbol);
    return ok(summary);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/news POST' });
  }
}
```

- [ ] **Step 5.2: Write the API integration test**

Create `tests/integration/api-tickers-news.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companies, newsArticles } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('/api/tickers/[symbol]/news', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => newUserId(),
      getCurrentUserId: async () => newUserId(),
      UnauthorizedError: class extends Error {}
    }));
    vi.doMock('@/lib/db/client', () => ({
      getServiceDb: () => dbH.db
    }));
    vi.doMock('@/lib/providers/financial-datasets', () => ({
      FinancialDatasetsProvider: class {
        news = vi.fn().mockResolvedValue([
          { ticker: 'AAPL', title: 'Test bullish headline', source: 'CNBC', date: '2026-05-26T12:00:00+00:00', url: 'https://example.com/a' }
        ]);
      }
    }));
    vi.doMock('@/lib/providers/qwen', () => ({
      QwenProviderImpl: class {
        sentimentBatch = vi.fn().mockResolvedValue([{ sentiment: 'bullish', confidence: 0.85 }]);
      }
    }));
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({
        get: async () => 0,
        set: async () => undefined
      })
    }));
  });

  it('GET returns empty list + zero aggregate when no articles', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/news/route');
    const res = await GET(new Request('http://test.local/api/tickers/AAPL/news'), { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.articles).toEqual([]);
    expect(body.aggregate.totalScored).toBe(0);
  });

  it('POST refresh inserts + scores articles, returns summary', async () => {
    const { POST } = await import('@/app/api/tickers/[symbol]/news/route');
    const res = await POST(new Request('http://test.local/api/tickers/AAPL/news', { method: 'POST' }), { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticker).toBe('AAPL');
    expect(body.fetched).toBe(1);
    expect(body.newArticles).toBe(1);
    expect(body.scored).toBe(1);
  });

  it('GET after POST returns the scored article', async () => {
    const { POST, GET } = await import('@/app/api/tickers/[symbol]/news/route');
    await POST(new Request('http://test.local/api/tickers/AAPL/news', { method: 'POST' }), { params: { symbol: 'AAPL' } });
    const res = await GET(new Request('http://test.local/api/tickers/AAPL/news'), { params: { symbol: 'AAPL' } });
    const body = await res.json();
    expect(body.articles).toHaveLength(1);
    expect(body.articles[0].sentiment).toBe('bullish');
    expect(body.aggregate.totalScored).toBe(1);
    expect(body.aggregate.bullish).toBe(1);
  });

  it('GET returns 400 for invalid ticker', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/news/route');
    const res = await GET(new Request('http://test.local/api/tickers/x/news'), { params: { symbol: 'lowercase' } });
    expect(res.status).toBe(400);
  });

  it('POST returns 429 when rate-limited', async () => {
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({
        get: async () => 999,    // already over the limit
        set: async () => undefined
      })
    }));
    vi.resetModules();
    const { POST } = await import('@/app/api/tickers/[symbol]/news/route');
    const res = await POST(new Request('http://test.local/api/tickers/AAPL/news', { method: 'POST' }), { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(429);
  });
});
```

- [ ] **Step 5.3: Write the RLS smoke test**

Match the project's existing RLS test pattern from `tests/integration/filing-summaries-rls.test.ts`, which uses `makeTestUserDb()` + `user.asUser(uid, tx => ...)` helpers.

Create `tests/integration/news-articles-rls.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, makeTestUserDb, newUserId, resetDb } from '../helpers/test-db';
import { companies, newsArticles } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('RLS: news_articles', () => {
  let svc: ReturnType<typeof makeTestServiceDb>;
  let user: ReturnType<typeof makeTestUserDb>;

  beforeAll(() => { svc = makeTestServiceDb(); user = makeTestUserDb(); });
  afterAll(async () => { await svc.close(); await user.close(); });

  beforeEach(async () => {
    await resetDb(svc.db);
    await svc.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await svc.db.insert(newsArticles).values({
      ticker: 'AAPL',
      url: 'https://example.com/a',
      title: 'Sample',
      source: 'Test',
      publishedAt: new Date('2026-05-27T12:00:00Z')
    });
  });

  it('authenticated role can SELECT news_articles', async () => {
    const uid = newUserId();
    const count = await user.asUser(uid, async (tx) => {
      const r = await tx.select().from(newsArticles);
      return r.length;
    });
    expect(count).toBe(1);
  });

  it('authenticated role cannot INSERT into news_articles', async () => {
    const uid = newUserId();
    await expect(
      user.asUser(uid, async (tx) => {
        await tx.insert(newsArticles).values({
          ticker: 'AAPL',
          url: 'https://example.com/x',
          title: 'X',
          source: 'X',
          publishedAt: new Date()
        });
      })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 5.4: Create the try-news script**

Create `scripts/try-news.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Smoke: pull news for a ticker, score via Qwen, print results.
 * Usage: pnpm try-news <TICKER>
 *
 * Writes to prod Neon (companies must already exist for the ticker).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { QwenProviderImpl } from '@/lib/providers/qwen';
import { NewsService } from '@/lib/services/news';
import { loadServerEnv } from '@/lib/env';

async function main() {
  const ticker = (process.argv[2] ?? '').toUpperCase();
  if (!/^[A-Z][A-Z.]{0,5}$/.test(ticker)) {
    console.error('Usage: pnpm try-news <TICKER>');
    process.exit(2);
  }

  const env = loadServerEnv();
  const db = getServiceDb();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const qwen = new QwenProviderImpl();
  const svc = new NewsService({ db, fdProvider: fd, qwenProvider: qwen });

  console.log(`Refreshing news for ${ticker}...`);
  const t0 = Date.now();
  const summary = await svc.refresh(ticker);
  console.log(`  fetched: ${summary.fetched}, new: ${summary.newArticles}, scored: ${summary.scored} (${Date.now() - t0}ms)`);

  console.log(`\nList (newest 10):`);
  const list = await svc.getList(ticker, 10);
  for (const a of list) {
    const badge = a.sentiment ? `[${a.sentiment.toUpperCase()} ${a.confidence?.toFixed(2)}]` : '[—]';
    console.log(`  ${a.publishedAt.toISOString().slice(0, 19)} ${badge.padEnd(20)} ${a.title.slice(0, 80)}`);
  }

  console.log(`\nAggregate (last 20):`);
  const agg = await svc.getAggregate(ticker, 20);
  console.log(`  bullish=${agg.bullish} neutral=${agg.neutral} bearish=${agg.bearish} score=${agg.score.toFixed(2)}`);

  process.exit(0);
}

main().catch((err) => {
  console.error('try-news failed:', err);
  process.exit(1);
});
```

- [ ] **Step 5.5: Add `try-news` script to package.json**

Edit `package.json`. In the `scripts` block, add a `try-news` entry alongside the existing `try-filings`, `try-summarize`, `try-search`, `try-ask`, `reparse` entries:

```json
"try-news": "tsx scripts/try-news.ts"
```

- [ ] **Step 5.6: Run all the new tests**

```bash
pnpm test:integration -- news
```

Expected: all 7 NewsService tests + 5 API tests + 2 RLS tests pass.

- [ ] **Step 5.7: Commit**

```bash
git add app/api/tickers/[symbol]/news/route.ts \
        scripts/try-news.ts \
        package.json \
        tests/integration/api-tickers-news.test.ts \
        tests/integration/news-articles-rls.test.ts
git commit -m "feat(api): news GET + POST routes + try-news smoke + RLS test

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: UI components — aggregate bar, article row, news view

**Files:**
- Create: `app/(app)/stock/[ticker]/news/_components/sentiment-aggregate-bar.tsx`
- Create: `app/(app)/stock/[ticker]/news/_components/article-row.tsx`
- Create: `app/(app)/stock/[ticker]/news/_components/news-view.tsx`

- [ ] **Step 6.1: Create the aggregate bar component**

Create `app/(app)/stock/[ticker]/news/_components/sentiment-aggregate-bar.tsx`:

```tsx
interface Props {
  bullish: number;
  neutral: number;
  bearish: number;
  totalScored: number;
  score: number;
  lastRefresh: Date | null;
}

export function SentimentAggregateBar({ bullish, neutral, bearish, totalScored, score, lastRefresh }: Props) {
  if (totalScored === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No scored articles yet.
      </div>
    );
  }

  const pctBullish = (bullish / totalScored) * 100;
  const pctNeutral = (neutral / totalScored) * 100;
  const pctBearish = (bearish / totalScored) * 100;
  const scoreDisplay = score >= 0 ? `+${score.toFixed(2)}` : score.toFixed(2);

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">
        Aggregate (last {totalScored} {totalScored === 1 ? 'article' : 'articles'})
      </div>
      <div className="flex h-3 w-full rounded overflow-hidden bg-muted">
        <div className="bg-green-600" style={{ width: `${pctBullish}%` }} title={`Bullish ${bullish}`} />
        <div className="bg-muted-foreground/30" style={{ width: `${pctNeutral}%` }} title={`Neutral ${neutral}`} />
        <div className="bg-red-600" style={{ width: `${pctBearish}%` }} title={`Bearish ${bearish}`} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <span><span className="text-green-600 font-medium">Bullish</span> {bullish}</span>
        <span><span className="text-muted-foreground font-medium">Neutral</span> {neutral}</span>
        <span><span className="text-red-600 font-medium">Bearish</span> {bearish}</span>
        <span>Score: <span className="font-mono">{scoreDisplay}</span></span>
        {lastRefresh && (
          <span>Last refresh: <span className="font-mono">{lastRefresh.toISOString().slice(0, 19).replace('T', ' ')} UTC</span></span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6.2: Create the article row component**

Create `app/(app)/stock/[ticker]/news/_components/article-row.tsx`:

```tsx
import type { SentimentLabel } from '@/lib/providers/types';

interface Article {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: Date;
  sentiment: SentimentLabel | null;
  confidence: number | null;
}

const BADGE_STYLES: Record<SentimentLabel, string> = {
  bullish: 'text-green-600',
  bearish: 'text-red-600',
  neutral: 'text-muted-foreground'
};

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export function ArticleRow({ article }: { article: Article }) {
  return (
    <li className="border-b border-border py-3 last:border-0">
      <div className="flex items-baseline gap-3 text-xs">
        {article.sentiment ? (
          <span className={`font-medium ${BADGE_STYLES[article.sentiment]}`}>
            ● {article.sentiment.toUpperCase()}
            {article.confidence != null && (
              <span className="font-mono ml-1 tabular-nums">({article.confidence.toFixed(2)})</span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground">● UNSCORED</span>
        )}
        <span className="font-mono text-muted-foreground tabular-nums">{fmtDate(article.publishedAt)}</span>
      </div>
      <a
        href={article.url}
        target="_blank"
        rel="noreferrer"
        className="block mt-1 text-sm hover:underline"
      >
        {article.title}
      </a>
      <div className="text-xs text-muted-foreground mt-0.5">{article.source}</div>
    </li>
  );
}
```

- [ ] **Step 6.3: Create the news view (client wrapper with refresh button)**

Create `app/(app)/stock/[ticker]/news/_components/news-view.tsx`:

```tsx
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { SentimentAggregateBar } from './sentiment-aggregate-bar';
import { ArticleRow } from './article-row';
import type { SentimentLabel } from '@/lib/providers/types';

interface Article {
  id: string;
  ticker: string;
  url: string;
  title: string;
  source: string;
  publishedAt: string;       // serialized
  sentiment: SentimentLabel | null;
  confidence: number | null;
}

interface Aggregate {
  totalScored: number;
  bullish: number;
  neutral: number;
  bearish: number;
  score: number;
  lastRefresh: string | null;  // serialized
}

interface Props {
  ticker: string;
  articles: Article[];
  aggregate: Aggregate;
}

export function NewsView({ ticker, articles, aggregate }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    setLastSummary(null);
    setRefreshing(true);
    try {
      const res = await fetch(`/api/tickers/${ticker}/news`, { method: 'POST' });
      if (!res.ok) {
        if (res.status === 429) {
          setError('Refreshing too quickly — try again in a minute.');
        } else {
          const body = await res.json().catch(() => ({}));
          setError((body as { error?: string }).error ?? `Refresh failed (HTTP ${res.status})`);
        }
        return;
      }
      const summary = (await res.json()) as { fetched: number; newArticles: number; scored: number };
      setLastSummary(`Fetched ${summary.fetched} · ${summary.newArticles} new · ${summary.scored} scored`);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setRefreshing(false);
    }
  }

  const aggregateProps = {
    bullish: aggregate.bullish,
    neutral: aggregate.neutral,
    bearish: aggregate.bearish,
    totalScored: aggregate.totalScored,
    score: aggregate.score,
    lastRefresh: aggregate.lastRefresh ? new Date(aggregate.lastRefresh) : null
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <SentimentAggregateBar {...aggregateProps} />
        <Button onClick={refresh} disabled={refreshing || isPending}>
          {refreshing ? 'Refreshing…' : 'Refresh news'}
        </Button>
      </div>

      {lastSummary && (
        <div className="text-xs text-muted-foreground">{lastSummary}</div>
      )}
      {error && (
        <div className="text-xs text-red-600">{error}</div>
      )}

      <div>
        <h3 className="text-sm font-medium mb-2">Recent articles</h3>
        {articles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No news fetched yet. Click <strong>Refresh news</strong> to pull recent articles.
          </p>
        ) : (
          <ul className="space-y-0">
            {articles.map((a) => (
              <ArticleRow
                key={a.id}
                article={{
                  id: a.id,
                  title: a.title,
                  url: a.url,
                  source: a.source,
                  publishedAt: new Date(a.publishedAt),
                  sentiment: a.sentiment,
                  confidence: a.confidence
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6.4: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 6.5: Commit**

```bash
git add "app/(app)/stock/[ticker]/news/_components/"
git commit -m "feat(news): SentimentAggregateBar + ArticleRow + NewsView

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: News page + tab nav update

**Files:**
- Create: `app/(app)/stock/[ticker]/news/page.tsx`
- Modify: `app/(app)/stock/[ticker]/page.tsx`
- Modify: `app/(app)/stock/[ticker]/financials/page.tsx`
- Modify: `app/(app)/stock/[ticker]/technical/page.tsx`
- Modify: `app/(app)/stock/[ticker]/filings/page.tsx`
- Modify: `app/(app)/stock/[ticker]/ask/page.tsx`

- [ ] **Step 7.1: Create the news page server component**

Create `app/(app)/stock/[ticker]/news/page.tsx`:

```tsx
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { QwenProviderImpl } from '@/lib/providers/qwen';
import { NewsService } from '@/lib/services/news';
import { loadServerEnv } from '@/lib/env';
import { NewsView } from './_components/news-view';

interface PageProps {
  params: { ticker: string };
}

export default async function NewsPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  const env = loadServerEnv();
  const svc = new NewsService({
    db: getServiceDb(),
    fdProvider: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY }),
    qwenProvider: new QwenProviderImpl()
  });

  const [articles, aggregate] = await Promise.all([
    svc.getList(ticker, 50),
    svc.getAggregate(ticker, 20)
  ]);

  // Serialize Date fields for client component props
  const serializedArticles = articles.map((a) => ({
    id: a.id,
    ticker: a.ticker,
    url: a.url,
    title: a.title,
    source: a.source,
    publishedAt: a.publishedAt.toISOString(),
    sentiment: a.sentiment,
    confidence: a.confidence
  }));
  const serializedAggregate = {
    totalScored: aggregate.totalScored,
    bullish: aggregate.bullish,
    neutral: aggregate.neutral,
    bearish: aggregate.bearish,
    score: aggregate.score,
    lastRefresh: aggregate.lastRefresh ? aggregate.lastRefresh.toISOString() : null
  };

  return (
    <div className="container py-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{ticker}</h1>
        <Tabs value="news" className="hidden sm:block">
          <TabsList>
            <TabsTrigger value="overview" asChild>
              <Link href={`/stock/${ticker}`}>Overview</Link>
            </TabsTrigger>
            <TabsTrigger value="financials" asChild>
              <Link href={`/stock/${ticker}/financials`}>Financials</Link>
            </TabsTrigger>
            <TabsTrigger value="technical" asChild>
              <Link href={`/stock/${ticker}/technical`}>Technical</Link>
            </TabsTrigger>
            <TabsTrigger value="news" asChild>
              <Link href={`/stock/${ticker}/news`}>News</Link>
            </TabsTrigger>
            <TabsTrigger value="filings" asChild>
              <Link href={`/stock/${ticker}/filings`}>Filings</Link>
            </TabsTrigger>
            <TabsTrigger value="ask" asChild>
              <Link href={`/stock/${ticker}/ask`}>Ask</Link>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <Card>
        <CardHeader><CardTitle>News &amp; Sentiment</CardTitle></CardHeader>
        <CardContent>
          <NewsView ticker={ticker} articles={serializedArticles} aggregate={serializedAggregate} />
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 7.2: Add "News" trigger to the 5 existing dashboard pages**

For each of these files:
- `app/(app)/stock/[ticker]/page.tsx`
- `app/(app)/stock/[ticker]/financials/page.tsx`
- `app/(app)/stock/[ticker]/technical/page.tsx`
- `app/(app)/stock/[ticker]/filings/page.tsx`
- `app/(app)/stock/[ticker]/ask/page.tsx`

Find the existing `<TabsList>` block (search for `Technical</Link>`). The "News" trigger goes BETWEEN "Technical" and "Filings". Insert this immediately after the closing `</TabsTrigger>` for technical:

If the file uses multi-line format:
```tsx
            <TabsTrigger value="news" asChild>
              <Link href={`/stock/${ticker}/news`}>News</Link>
            </TabsTrigger>
```

If the file uses single-line format:
```tsx
            <TabsTrigger value="news" asChild><Link href={`/stock/${ticker}/news`}>News</Link></TabsTrigger>
```

Match each file's existing formatting. After this step, every dashboard page should show 6 tabs: Overview · Financials · Technical · News · Filings · Ask.

- [ ] **Step 7.3: Typecheck + lint + tests**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all clean.

- [ ] **Step 7.4: Commit**

```bash
git add "app/(app)/stock/[ticker]/news/page.tsx" \
        "app/(app)/stock/[ticker]/page.tsx" \
        "app/(app)/stock/[ticker]/financials/page.tsx" \
        "app/(app)/stock/[ticker]/technical/page.tsx" \
        "app/(app)/stock/[ticker]/filings/page.tsx" \
        "app/(app)/stock/[ticker]/ask/page.tsx"
git commit -m "feat(news): /news page + Technical tab nav update in 5 pages

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Push + CI + Vercel + smoke

**Files:** None modified; rollout task.

- [ ] **Step 8.1: Push**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git push origin master
```

- [ ] **Step 8.2: Get CI run ID**

```bash
gh run list --limit 1 --json status,databaseId,headSha
```

- [ ] **Step 8.3: Watch CI**

```bash
gh run watch <run-id> --exit-status
```

Expected: exits 0, all jobs green.

- [ ] **Step 8.4: Populate news for AAPL via the smoke script**

This calls FD + Qwen against prod Neon. Cost ~$0.0005 in Qwen tokens.

```bash
pnpm try-news AAPL
```

Expected output ends with something like:
```
Refreshing news for AAPL...
  fetched: 100, new: 100, scored: 100 (4200ms)

List (newest 10):
  2026-05-27 11:53:25 [BULLISH 0.82]  Analysts Offer Insights on Technology Companies: Apple (AAPL)...
  2026-05-27 11:14:56 [BEARISH 0.74]  Verdence Capital Advisors LLC Lowers Position in Apple Inc.
  ...

Aggregate (last 20):
  bullish=12 neutral=6 bearish=2 score=0.50
```

- [ ] **Step 8.5: Repeat for NVDA, MSFT, GOOGL, JD**

```bash
pnpm try-news NVDA
pnpm try-news MSFT
pnpm try-news GOOGL
pnpm try-news JD
```

Each should succeed with a non-empty list + aggregate.

- [ ] **Step 8.6: Browser smoke on production**

Wait ~30s for Vercel deploy. Then visit:

1. https://equity-research-workbench-mauve.vercel.app/stock/AAPL/news
2. https://equity-research-workbench-mauve.vercel.app/stock/NVDA/news
3. https://equity-research-workbench-mauve.vercel.app/stock/MSFT/news
4. https://equity-research-workbench-mauve.vercel.app/stock/GOOGL/news
5. https://equity-research-workbench-mauve.vercel.app/stock/JD/news

For each, expect:
- Header strip with the stacked sentiment bar + bin counts + score + last refresh timestamp
- Recent articles list, newest first, each with sentiment badge + confidence + clickable title
- "Refresh news" button visible (don't actually click — costs more Qwen tokens; click once if you want to test the live path)
- Tab nav across all stock pages now shows: Overview · Financials · Technical · News · Filings · Ask

If everything renders, slice 5B is shipped.

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `news_articles` table + indexes | T1 |
| RLS for authenticated SELECT | T1 |
| Drizzle schema matches DB | T1 |
| `FinancialDatasetsProvider.news()` | T2 |
| `NewsArticleMeta` type | T2 |
| FD news fixture | T2 |
| `QwenProvider.sentimentBatch()` | T3 |
| `SentimentLabel`/`SentimentScore` types | T3 |
| Prompt v1 locked in the implementation | T3 |
| All-neutral fallback on parse failure | T3 |
| Confidence clamped to [0,1] | T3 |
| Length-mismatch defends | T3 |
| `NewsService.refresh` with dedupe by URL | T4 |
| `NewsService.refresh` scores only NULL-sentiment rows | T4 |
| `NewsService.refresh` records refresh_runs | T4 |
| `NewsService.getList` newest first | T4 |
| `NewsService.getAggregate` formula | T4 |
| GET /api/tickers/[symbol]/news | T5 |
| POST /api/tickers/[symbol]/news with rate limit | T5 |
| RLS smoke test | T5 |
| `pnpm try-news <ticker>` smoke script | T5 |
| `<SentimentAggregateBar>` stacked bar | T6 |
| `<ArticleRow>` with badge + link | T6 |
| `<NewsView>` with refresh button + states | T6 |
| `/stock/[ticker]/news` page | T7 |
| Tab nav updated in 5 existing pages | T7 |
| Push, CI, Vercel, populate, browser smoke | T8 |

All requirements have a task. No gaps.
