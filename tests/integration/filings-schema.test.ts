import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, makeTestUserDb, newUserId, resetDb } from '../helpers/test-db';
import { companies, filings, filingChunks } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('RLS: filings + filing_chunks', () => {
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
    await svc.db.insert(filingChunks).values({
      filingId: '0000320193-24-000123', sectionKey: 'item_1_business',
      sectionTitle: 'Business', text: 'Apple does things.', charCount: 18
    });
  });

  it('authenticated role can SELECT filings + filing_chunks', async () => {
    const uid = newUserId();
    const result = await user.asUser(uid, async (tx) => {
      const f = await tx.select().from(filings);
      const c = await tx.select().from(filingChunks);
      return { fCount: f.length, cCount: c.length };
    });
    expect(result.fCount).toBe(1);
    expect(result.cCount).toBe(1);
  });

  it('authenticated role cannot INSERT into filings', async () => {
    const uid = newUserId();
    await expect(
      user.asUser(uid, async (tx) =>
        tx.insert(filings).values({
          accessionNo: 'X', ticker: 'AAPL', cik: 'X',
          formType: '10-K', filingDate: '2024-01-01', primaryDocUrl: 'https://x'
        })
      )
    ).rejects.toThrow();
  });

  it('authenticated role cannot INSERT into filing_chunks', async () => {
    const uid = newUserId();
    await expect(
      user.asUser(uid, async (tx) =>
        tx.insert(filingChunks).values({
          filingId: '0000320193-24-000123', sectionKey: 'x', sectionTitle: 'x', text: 'x', charCount: 1
        })
      )
    ).rejects.toThrow();
  });
});
