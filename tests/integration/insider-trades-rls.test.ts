import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, makeTestUserDb, newUserId, resetDb } from '../helpers/test-db';
import { companies, insiderTrades } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('RLS: insider_trades', () => {
  let svc: ReturnType<typeof makeTestServiceDb>;
  let user: ReturnType<typeof makeTestUserDb>;

  beforeAll(() => { svc = makeTestServiceDb(); user = makeTestUserDb(); });
  afterAll(async () => { await svc.close(); await user.close(); });

  beforeEach(async () => {
    await resetDb(svc.db);
    await svc.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await svc.db.insert(insiderTrades).values({
      ticker: 'AAPL',
      insiderName: 'Alice',
      transactionDate: '2026-05-20',
      transactionType: 'Open market purchase',
      shares: '1000',
      filingDate: '2026-05-21'
    });
  });

  it('authenticated role can SELECT insider_trades', async () => {
    const uid = newUserId();
    const count = await user.asUser(uid, async (tx) => {
      const r = await tx.select().from(insiderTrades);
      return r.length;
    });
    expect(count).toBe(1);
  });

  it('authenticated role cannot INSERT into insider_trades', async () => {
    const uid = newUserId();
    await expect(
      user.asUser(uid, async (tx) => {
        await tx.insert(insiderTrades).values({
          ticker: 'AAPL',
          insiderName: 'Eve',
          transactionDate: '2026-05-22',
          transactionType: 'Open market sale',
          shares: '500',
          filingDate: '2026-05-22'
        });
      })
    ).rejects.toThrow();
  });
});
