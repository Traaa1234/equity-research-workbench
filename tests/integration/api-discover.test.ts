import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companiesUniverse } from '@/lib/db/schema';

config({ path: '.env.local' });

function vec(): number[] {
  const v = new Array(1024).fill(0);
  v[0] = 1;
  return v;
}

describe('POST /api/discover', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.execute(sql`TRUNCATE TABLE companies_universe`);
    await dbH.db.insert(companiesUniverse).values({
      ticker: 'AAA', name: 'Alpha',
      country: 'US', exchange: 'NYSE', sector: 'Technology',
      description: 'a', descriptionEmbedding: vec(), sources: ['nyse']
    });
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => newUserId(),
      getCurrentUserId: async () => newUserId(),
      UnauthorizedError: class extends Error {}
    }));
    vi.doMock('@/lib/db/client', () => ({ getServiceDb: () => dbH.db }));
    vi.doMock('@/lib/providers/qwen', () => ({
      QwenProviderImpl: class {
        summarize = vi.fn().mockResolvedValue({
          text: JSON.stringify({
            country: null, sector: 'Technology', industry: null,
            exchanges: [], conceptText: 'tech',
            marketCapMin: null, marketCapMax: null
          }),
          inputTokens: 50, outputTokens: 20
        });
        sentimentBatch = vi.fn();
      }
    }));
    vi.doMock('@/lib/providers/embeddings', () => ({
      EmbeddingsProviderImpl: class {
        embed = vi.fn().mockResolvedValue({ vectors: [vec()], inputTokens: 5 });
      }
    }));
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({ get: async () => 0, set: async () => undefined })
    }));
  });

  it('POST happy path: returns parsed + results', async () => {
    const { POST } = await import('@/app/api/discover/route');
    const res = await POST(new Request('http://test.local/api/discover', {
      method: 'POST',
      body: JSON.stringify({ query: 'tech', limit: 10 }),
      headers: { 'content-type': 'application/json' }
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parsed.sector).toBe('Technology');
    expect(body.results).toHaveLength(1);
    expect(body.results[0].ticker).toBe('AAA');
  });

  it('POST returns 400 on empty query', async () => {
    const { POST } = await import('@/app/api/discover/route');
    const res = await POST(new Request('http://test.local/api/discover', {
      method: 'POST',
      body: JSON.stringify({ query: '' }),
      headers: { 'content-type': 'application/json' }
    }));
    expect(res.status).toBe(400);
  });

  it('POST returns 429 when rate-limited', async () => {
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({ get: async () => 999, set: async () => undefined })
    }));
    vi.resetModules();
    const { POST } = await import('@/app/api/discover/route');
    const res = await POST(new Request('http://test.local/api/discover', {
      method: 'POST',
      body: JSON.stringify({ query: 'tech' }),
      headers: { 'content-type': 'application/json' }
    }));
    expect(res.status).toBe(429);
  });
});
