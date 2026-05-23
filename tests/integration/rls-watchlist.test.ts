import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, makeTestUserDb, newUserId, resetDb } from '../helpers/test-db';
import { companies, watchlist } from '@/lib/db/schema';

// Load .env.local into process.env for tests.
config({ path: '.env.local' });

describe('RLS: watchlist isolation', () => {
  let svc: ReturnType<typeof makeTestServiceDb>;
  let user: ReturnType<typeof makeTestUserDb>;

  beforeAll(() => {
    svc = makeTestServiceDb();
    user = makeTestUserDb();
  });

  afterAll(async () => {
    await svc.close();
    await user.close();
  });

  beforeEach(async () => {
    await resetDb(svc.db);
    // Seed one ticker so the FK on watchlist.ticker is satisfied.
    await svc.db.insert(companies).values({
      ticker: 'AAPL',
      name: 'Apple Inc.',
      isSeed: true
    });
  });

  it('user A cannot read user B watchlist rows', async () => {
    const alice = newUserId();
    const bob = newUserId();

    // Service role (bypasses RLS) inserts Alice's row.
    await svc.db.insert(watchlist).values({ userId: alice, ticker: 'AAPL' });

    // Bob's user-scoped session queries — RLS must filter Alice's row out.
    const rows = await user.asUser(bob, async (tx) =>
      tx.select().from(watchlist)
    );
    expect(rows).toEqual([]);
  });

  it('user A can read their own watchlist rows', async () => {
    const alice = newUserId();
    await svc.db.insert(watchlist).values({ userId: alice, ticker: 'AAPL' });

    const rows = await user.asUser(alice, async (tx) =>
      tx.select({ ticker: watchlist.ticker }).from(watchlist)
    );
    expect(rows).toEqual([{ ticker: 'AAPL' }]);
  });

  it('user A cannot insert a row with another user id', async () => {
    const alice = newUserId();
    const bob = newUserId();

    // RLS WITH CHECK clause should reject this insert.
    await expect(
      user.asUser(alice, async (tx) =>
        tx.insert(watchlist).values({ userId: bob, ticker: 'AAPL' })
      )
    ).rejects.toThrow();
  });
});
