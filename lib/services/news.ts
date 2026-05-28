import { and, desc, eq, isNull } from 'drizzle-orm';
import { newsArticles, refreshRuns } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type {
  NewsArticleMeta,
  QwenProvider,
  SentimentLabel
} from '@/lib/providers/types';
import { logger } from '@/lib/logger';

// FD's /news endpoint hard-caps at limit=10. Confirmed by probing the live API.
// (The MCP version of FD wraps a different path that accepts higher limits, but
// the direct HTTP API used here is capped at 10.)
const REFRESH_FETCH_LIMIT = 10;
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
