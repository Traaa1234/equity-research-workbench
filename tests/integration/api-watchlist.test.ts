import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq, and } from 'drizzle-orm';
import { makeTestServiceDb, newUserId, resetDb } from '../helpers/test-db';
import { companies, watchlist } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('/api/watchlist', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  let testUserId: string;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });

  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values([
      { ticker: 'AAPL', name: 'Apple' },
      { ticker: 'MSFT', name: 'Microsoft' }
    ]);
    testUserId = newUserId();
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => testUserId,
      getCurrentUserId: async () => testUserId,
      UnauthorizedError: class extends Error {}
    }));
  });

  it('GET returns the user watchlist', async () => {
    await dbH.db.insert(watchlist).values({ userId: testUserId, ticker: 'AAPL' });
    const { GET } = await import('@/app/api/watchlist/route');
    const res = await GET(new Request('http://localhost/api/watchlist'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([{ ticker: 'AAPL' }]);
  });

  it('POST adds a ticker', async () => {
    const { POST } = await import('@/app/api/watchlist/route');
    const res = await POST(new Request('http://localhost/api/watchlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticker: 'AAPL' })
    }));
    expect(res.status).toBe(201);
    const rows = await dbH.db.select().from(watchlist).where(and(eq(watchlist.userId, testUserId), eq(watchlist.ticker, 'AAPL')));
    expect(rows).toHaveLength(1);
  });

  it('POST is idempotent (no error on duplicate)', async () => {
    const { POST } = await import('@/app/api/watchlist/route');
    const make = () => new Request('http://localhost/api/watchlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticker: 'AAPL' })
    });
    await POST(make());
    const res = await POST(make());
    expect(res.status).toBe(201);
  });
});
