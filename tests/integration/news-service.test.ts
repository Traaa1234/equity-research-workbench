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
