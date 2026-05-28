import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, makeTestUserDb, newUserId, resetDb } from '../helpers/test-db';
import { companies, institutionalHoldings } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('RLS: institutional_holdings', () => {
  let svc: ReturnType<typeof makeTestServiceDb>;
  let user: ReturnType<typeof makeTestUserDb>;

  beforeAll(() => { svc = makeTestServiceDb(); user = makeTestUserDb(); });
  afterAll(async () => { await svc.close(); await user.close(); });

  beforeEach(async () => {
    await resetDb(svc.db);
    await svc.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await svc.db.insert(institutionalHoldings).values({
      ticker: 'AAPL',
      investorId: '0001067983',
      investorName: 'BERKSHIRE HATHAWAY INC',
      reportPeriod: '2026-03-31',
      shares: '905560000',
      filingDate: '2026-05-14'
    });
  });

  it('authenticated role can SELECT institutional_holdings', async () => {
    const uid = newUserId();
    const count = await user.asUser(uid, async (tx) => {
      const r = await tx.select().from(institutionalHoldings);
      return r.length;
    });
    expect(count).toBe(1);
  });

  it('authenticated role cannot INSERT into institutional_holdings', async () => {
    const uid = newUserId();
    await expect(
      user.asUser(uid, async (tx) => {
        await tx.insert(institutionalHoldings).values({
          ticker: 'AAPL',
          investorId: 'EVIL',
          investorName: 'EVIL FUND',
          reportPeriod: '2026-03-31',
          shares: '1000',
          filingDate: '2026-05-15'
        });
      })
    ).rejects.toThrow();
  });
});
