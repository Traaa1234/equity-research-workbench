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
