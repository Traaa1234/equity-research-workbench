import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, newUserId, resetDb } from '../helpers/test-db';
import { companies } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('/api/notes/[ticker]', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  let testUserId: string;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });

  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    testUserId = newUserId();
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => testUserId,
      UnauthorizedError: class extends Error {}
    }));
  });

  it('GET returns empty string when no note exists', async () => {
    const { GET } = await import('@/app/api/notes/[ticker]/route');
    const res = await GET(new Request('http://localhost/api/notes/AAPL'), {
      params: { ticker: 'AAPL' }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.body).toBe('');
  });

  it('PUT then GET round-trips the note body', async () => {
    const { PUT, GET } = await import('@/app/api/notes/[ticker]/route');
    const putRes = await PUT(new Request('http://localhost/api/notes/AAPL', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '# AAPL thesis\n\nGreat company.' })
    }), { params: { ticker: 'AAPL' } });
    expect(putRes.status).toBe(204);

    const getRes = await GET(new Request('http://localhost/api/notes/AAPL'), {
      params: { ticker: 'AAPL' }
    });
    const body = await getRes.json();
    expect(body.body).toBe('# AAPL thesis\n\nGreat company.');
  });

  it('PUT 400s on oversized body', async () => {
    const { PUT } = await import('@/app/api/notes/[ticker]/route');
    const huge = 'a'.repeat(60_000);
    const res = await PUT(new Request('http://localhost/api/notes/AAPL', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: huge })
    }), { params: { ticker: 'AAPL' } });
    expect(res.status).toBe(400);
  });
});
