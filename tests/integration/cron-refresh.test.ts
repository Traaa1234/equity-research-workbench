import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies } from '@/lib/db/schema';
import { _resetEnvCache } from '@/lib/env';

config({ path: '.env.local' });

describe('GET /api/cron/refresh', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple', isSeed: true });
    // Ensure a known CRON_SECRET so tests are deterministic.
    process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-secret-at-least-16-chars';
    _resetEnvCache();
  });

  it('401s without Authorization header', async () => {
    const { GET } = await import('@/app/api/cron/refresh/route');
    const res = await GET(new Request('http://localhost/api/cron/refresh?kind=snapshot'));
    expect(res.status).toBe(401);
  });

  it('400s on missing kind param', async () => {
    const { GET } = await import('@/app/api/cron/refresh/route');
    const res = await GET(new Request('http://localhost/api/cron/refresh', {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }
    }));
    expect(res.status).toBe(400);
  });

  it('400s on invalid kind', async () => {
    const { GET } = await import('@/app/api/cron/refresh/route');
    const res = await GET(new Request('http://localhost/api/cron/refresh?kind=bogus', {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }
    }));
    expect(res.status).toBe(400);
  });
});
