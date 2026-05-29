import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companiesUniverse } from '@/lib/db/schema';
import { DiscoverService } from '@/lib/services/discover';
import type { QwenProvider, EmbeddingsProvider } from '@/lib/providers/types';

config({ path: '.env.local' });

function vec(seed: 'A' | 'B' | 'C'): number[] {
  const v = new Array(1024).fill(0);
  if (seed === 'A') v[0] = 1;
  if (seed === 'B') v[1] = 1;
  if (seed === 'C') v[2] = 1;
  return v;
}

function mockQwen(parsed: any): QwenProvider {
  return {
    summarize: vi.fn().mockResolvedValue({
      text: JSON.stringify(parsed), inputTokens: 100, outputTokens: 50
    }),
    sentimentBatch: vi.fn()
  };
}

function mockEmbeddings(vector: number[]): EmbeddingsProvider {
  return {
    embed: vi.fn().mockResolvedValue({ vectors: [vector], inputTokens: 5 })
  };
}

const mockRedis = { get: async () => null, set: async () => undefined } as any;

describe('DiscoverService.search', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    // resetDb doesn't include companies_universe (added after it was written) — truncate explicitly.
    await dbH.db.execute(sql`TRUNCATE TABLE companies_universe`);
    await dbH.db.insert(companiesUniverse).values([
      { ticker: 'AAA', name: 'Alpha US-A',  country: 'US', exchange: 'NYSE',   sector: 'Technology', description: 'a', descriptionEmbedding: vec('A'), sources: ['nyse'] },
      { ticker: 'BBB', name: 'Beta US-B',   country: 'US', exchange: 'NYSE',   sector: 'Technology', description: 'b', descriptionEmbedding: vec('B'), sources: ['nyse'] },
      { ticker: 'CCC', name: 'Cee BR-A',    country: 'BR', exchange: 'NYSE',   sector: 'Consumer Defensive', description: 'c', descriptionEmbedding: vec('A'), sources: ['nyse'] },
      { ticker: 'DDD', name: 'Dee BR-C',    country: 'BR', exchange: 'NYSE',   sector: 'Consumer Defensive', description: 'd', descriptionEmbedding: vec('C'), sources: ['nyse'] },
      { ticker: 'EEE', name: 'Ee CN-A',     country: 'CN', exchange: 'NASDAQ', sector: 'Technology', description: 'e', descriptionEmbedding: vec('A'), sources: ['nasdaq'] },
      { ticker: 'FFF', name: 'Eff no-desc', country: 'US', exchange: 'NYSE',   sector: 'Technology', description: null, descriptionEmbedding: null, sources: ['nyse'] }
    ]);
  });

  it('prefilters by country then ranks by similarity', async () => {
    const qwen = mockQwen({
      country: 'BR', sector: null, industry: null,
      exchanges: [], conceptText: 'concept A', marketCapMin: null, marketCapMax: null
    });
    const emb = mockEmbeddings(vec('A'));
    const svc = new DiscoverService({ db: dbH.db, qwenProvider: qwen, embeddingsProvider: emb, redis: mockRedis });

    const results = await svc.search('Brazilian concept A', 10);
    expect(results).toHaveLength(2);
    expect(results[0]!.ticker).toBe('CCC');
    expect(results[1]!.ticker).toBe('DDD');
    expect(results[0]!.similarity).toBeGreaterThan(results[1]!.similarity);
  });

  it('prefilters by sector + exchange and ranks by similarity', async () => {
    const qwen = mockQwen({
      country: null, sector: 'Technology', industry: null,
      exchanges: ['NYSE', 'NASDAQ'], conceptText: 'concept A',
      marketCapMin: null, marketCapMax: null
    });
    const emb = mockEmbeddings(vec('A'));
    const svc = new DiscoverService({ db: dbH.db, qwenProvider: qwen, embeddingsProvider: emb, redis: mockRedis });

    const results = await svc.search('tech', 10);
    expect(results.map((r) => r.ticker).sort()).toEqual(['AAA', 'BBB', 'EEE']);
    expect(results[0]!.similarity).toBeGreaterThan(0.99);
  });

  it('excludes rows with null description_embedding', async () => {
    const qwen = mockQwen({
      country: 'US', sector: null, industry: null,
      exchanges: [], conceptText: 'whatever',
      marketCapMin: null, marketCapMax: null
    });
    const emb = mockEmbeddings(vec('A'));
    const svc = new DiscoverService({ db: dbH.db, qwenProvider: qwen, embeddingsProvider: emb, redis: mockRedis });

    const results = await svc.search('whatever', 10);
    expect(results.map((r) => r.ticker)).not.toContain('FFF');
  });

  it('falls back to full-universe search when prefilter is empty', async () => {
    const qwen = mockQwen({
      country: 'JP',
      sector: null, industry: null,
      exchanges: [], conceptText: 'concept A',
      marketCapMin: null, marketCapMax: null
    });
    const emb = mockEmbeddings(vec('A'));
    const svc = new DiscoverService({ db: dbH.db, qwenProvider: qwen, embeddingsProvider: emb, redis: mockRedis });

    const results = await svc.search('Japanese concept A', 10);
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results[0]!.similarity).toBeGreaterThan(0.99);
  });

  it('honors limit', async () => {
    const qwen = mockQwen({
      country: null, sector: null, industry: null,
      exchanges: [], conceptText: 'anything',
      marketCapMin: null, marketCapMax: null
    });
    const emb = mockEmbeddings(vec('A'));
    const svc = new DiscoverService({ db: dbH.db, qwenProvider: qwen, embeddingsProvider: emb, redis: mockRedis });

    const results = await svc.search('anything', 2);
    expect(results).toHaveLength(2);
  });

  it('returns empty array when input is empty', async () => {
    const qwen = mockQwen({
      country: null, sector: null, industry: null,
      exchanges: [], conceptText: '',
      marketCapMin: null, marketCapMax: null
    });
    const emb = mockEmbeddings(vec('A'));
    const svc = new DiscoverService({ db: dbH.db, qwenProvider: qwen, embeddingsProvider: emb, redis: mockRedis });

    const results = await svc.search('', 10);
    expect(results).toEqual([]);
  });
});
