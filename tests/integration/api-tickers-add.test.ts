import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, newUserId, resetDb } from '../helpers/test-db';
import { getRedisCache } from '@/lib/cache/redis';

config({ path: '.env.local' });

describe('POST /api/tickers/add', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    vi.resetModules();
    // Stub the auth helper for tests; pre-set a userId per-test.
  });

  it('400s when symbol missing from body', async () => {
    const userId = newUserId();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => userId,
      getCurrentUserId: async () => userId,
      UnauthorizedError: class extends Error {}
    }));
    const { POST } = await import('@/app/api/tickers/add/route');
    const req = new Request('http://localhost/api/tickers/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('400s on invalid symbol format', async () => {
    const userId = newUserId();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => userId,
      UnauthorizedError: class extends Error {}
    }));
    const { POST } = await import('@/app/api/tickers/add/route');
    const req = new Request('http://localhost/api/tickers/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: 'lowercase' })
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('429s when over per-user rate limit', async () => {
    const userId = newUserId();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => userId,
      UnauthorizedError: class extends Error {}
    }));
    // Pre-load the rate-limit counter past the threshold.
    const redis = getRedisCache();
    await redis.set(`ratelimit:add-ticker:${userId}`, 100, 60);

    const { POST } = await import('@/app/api/tickers/add/route');
    const req = new Request('http://localhost/api/tickers/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: 'AAPL' })
    });
    const res = await POST(req);
    expect(res.status).toBe(429);

    await redis.del(`ratelimit:add-ticker:${userId}`);
  });
});
