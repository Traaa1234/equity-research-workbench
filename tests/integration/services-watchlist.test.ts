import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, newUserId, resetDb } from '../helpers/test-db';
import { companies } from '@/lib/db/schema';
import { WatchlistService } from '@/lib/services/watchlist';

config({ path: '.env.local' });

describe('WatchlistService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values([
      { ticker: 'AAPL', name: 'Apple' },
      { ticker: 'MSFT', name: 'Microsoft' }
    ]);
  });

  it('add: inserts a row', async () => {
    const u = newUserId();
    const svc = new WatchlistService(dbH.db);
    await svc.add(u, 'AAPL');
    const list = await svc.list(u);
    expect(list).toEqual([{ ticker: 'AAPL' }]);
  });

  it('add: is idempotent', async () => {
    const u = newUserId();
    const svc = new WatchlistService(dbH.db);
    await svc.add(u, 'AAPL');
    await svc.add(u, 'AAPL');
    const list = await svc.list(u);
    expect(list).toHaveLength(1);
  });

  it('remove: deletes the row', async () => {
    const u = newUserId();
    const svc = new WatchlistService(dbH.db);
    await svc.add(u, 'AAPL');
    await svc.remove(u, 'AAPL');
    expect(await svc.list(u)).toEqual([]);
  });

  it('list: orders by addedAt desc', async () => {
    const u = newUserId();
    const svc = new WatchlistService(dbH.db);
    await svc.add(u, 'AAPL');
    await new Promise((r) => setTimeout(r, 50));
    await svc.add(u, 'MSFT');
    const list = await svc.list(u);
    expect(list.map((r) => r.ticker)).toEqual(['MSFT', 'AAPL']);
  });

  it('has: returns true only for rows the user owns', async () => {
    const a = newUserId();
    const b = newUserId();
    const svc = new WatchlistService(dbH.db);
    await svc.add(a, 'AAPL');
    expect(await svc.has(a, 'AAPL')).toBe(true);
    expect(await svc.has(b, 'AAPL')).toBe(false);
  });
});
