import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, makeTestUserDb, newUserId, resetDb } from '../helpers/test-db';
import { companies, filings, chunkEmbeddings } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('RLS: chunk_embeddings', () => {
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
    await svc.db.insert(chunkEmbeddings).values({
      filingId: '0000320193-24-000123',
      sectionKey: 'item_1_business',
      subChunkIndex: 0,
      text: 'Apple does things.',
      embedding: Array(1024).fill(0.5),
      model: 'text-embedding-v3',
      charOffsetStart: 0,
      charOffsetEnd: 18
    });
  });

  it('authenticated role can SELECT chunk_embeddings', async () => {
    const uid = newUserId();
    const count = await user.asUser(uid, async (tx) => {
      const r = await tx.select().from(chunkEmbeddings);
      return r.length;
    });
    expect(count).toBe(1);
  });

  it('authenticated role cannot INSERT into chunk_embeddings', async () => {
    const uid = newUserId();
    await expect(
      user.asUser(uid, async (tx) =>
        tx.insert(chunkEmbeddings).values({
          filingId: '0000320193-24-000123',
          sectionKey: 'item_1_business',
          subChunkIndex: 1,
          text: 'x',
          embedding: Array(1024).fill(0.1),
          model: 'text-embedding-v3'
        })
      )
    ).rejects.toThrow();
  });
});
