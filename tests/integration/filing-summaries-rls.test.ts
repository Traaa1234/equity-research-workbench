import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, makeTestUserDb, newUserId, resetDb } from '../helpers/test-db';
import { companies, filings, filingSummaries } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('RLS: filing_summaries', () => {
  let svc: ReturnType<typeof makeTestServiceDb>;
  let user: ReturnType<typeof makeTestUserDb>;

  beforeAll(() => { svc = makeTestServiceDb(); user = makeTestUserDb(); });
  afterAll(async () => { await svc.close(); await user.close(); });

  beforeEach(async () => {
    await resetDb(svc.db);
    await svc.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await svc.db.insert(filings).values({
      accessionNo: '0000320193-24-000123', ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
    });
    await svc.db.insert(filingSummaries).values({
      filingId: '0000320193-24-000123',
      summaryText: 'cached briefing',
      model: 'qwen-plus',
      promptVersion: 'v1'
    });
  });

  it('authenticated role can SELECT filing_summaries', async () => {
    const uid = newUserId();
    const count = await user.asUser(uid, async (tx) => {
      const r = await tx.select().from(filingSummaries);
      return r.length;
    });
    expect(count).toBe(1);
  });

  it('authenticated role cannot INSERT into filing_summaries', async () => {
    const uid = newUserId();
    await expect(
      user.asUser(uid, async (tx) =>
        tx.insert(filingSummaries).values({
          filingId: '0000320193-24-000123',
          summaryText: 'x',
          model: 'qwen-plus',
          promptVersion: 'v2'
        })
      )
    ).rejects.toThrow();
  });
});
