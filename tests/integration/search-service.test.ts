import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companies, filings, filingChunks, chunkEmbeddings, watchlist } from '@/lib/db/schema';
import { SearchService, CURRENT_EMBED_MODEL } from '@/lib/services/search';
import { ValidationError } from '@/lib/providers/types';

config({ path: '.env.local' });

function mockProvider(queryVector?: number[]) {
  return {
    embed: vi.fn().mockImplementation(async () => ({
      vectors: [queryVector ?? Array(1024).fill(0.5)],
      inputTokens: 10
    }))
  };
}

async function seedSearchableFiling(db: any, ticker: string, vectorValues: number[]) {
  await db.insert(companies).values({ ticker, name: `${ticker} Corp` }).onConflictDoNothing();
  const accession = `0000${ticker.slice(0, 4).padEnd(4, '0').toUpperCase()}-24-000001`;
  await db.insert(filings).values({
    accessionNo: accession, ticker, cik: '0000000001',
    formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
  });
  await db.insert(filingChunks).values({
    filingId: accession, sectionKey: 'item_1a_risk_factors',
    sectionTitle: 'Risk Factors', text: `${ticker} faces risks`, charCount: 20
  });
  await db.insert(chunkEmbeddings).values({
    filingId: accession, sectionKey: 'item_1a_risk_factors', subChunkIndex: 0,
    text: `${ticker} faces risks`, embedding: vectorValues, model: CURRENT_EMBED_MODEL,
    charOffsetStart: 0, charOffsetEnd: 20
  });
  return accession;
}

describe('SearchService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  let userId: string;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    userId = newUserId();
  });

  it('searchAcrossWatchlist: empty watchlist returns empty results', async () => {
    const provider = mockProvider();
    const svc = new SearchService({ db: dbH.db, provider: provider as any });
    const results = await svc.searchAcrossWatchlist({ userId, query: 'tariff exposure' });
    expect(results).toEqual([]);
  });

  it('searchAcrossWatchlist: returns ranked results from watchlist filings', async () => {
    const closeVec = Array(1024).fill(0.5);
    const farVec = Array(1024).fill(0).map((_, i) => (i < 10 ? 1.0 : 0));
    await seedSearchableFiling(dbH.db, 'AAPL', closeVec);
    await seedSearchableFiling(dbH.db, 'JD', farVec);
    await dbH.db.insert(watchlist).values([
      { userId, ticker: 'AAPL' },
      { userId, ticker: 'JD' }
    ]);

    const provider = mockProvider(closeVec);
    const svc = new SearchService({ db: dbH.db, provider: provider as any });
    const results = await svc.searchAcrossWatchlist({ userId, query: 'risk' });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.ticker).toBe('AAPL');
  });

  it('searchAcrossWatchlist: results from non-watchlist tickers are excluded', async () => {
    const vec = Array(1024).fill(0.5);
    await seedSearchableFiling(dbH.db, 'AAPL', vec);
    await seedSearchableFiling(dbH.db, 'NIO', vec);
    await dbH.db.insert(watchlist).values({ userId, ticker: 'AAPL' });

    const provider = mockProvider(vec);
    const svc = new SearchService({ db: dbH.db, provider: provider as any });
    const results = await svc.searchAcrossWatchlist({ userId, query: 'risk' });

    expect(results.every((r) => r.ticker === 'AAPL')).toBe(true);
  });

  it('searchAcrossWatchlist: form_types filter applies', async () => {
    const vec = Array(1024).fill(0.5);
    await seedSearchableFiling(dbH.db, 'AAPL', vec);
    await dbH.db.insert(filings).values({
      accessionNo: '0000AAPL-24-000002', ticker: 'AAPL', cik: '0000000001',
      formType: '10-Q', filingDate: '2024-08-02', primaryDocUrl: 'https://x'
    });
    await dbH.db.insert(filingChunks).values({
      filingId: '0000AAPL-24-000002', sectionKey: 'part1_item2_mdna',
      sectionTitle: 'MD&A', text: 'Quarterly results', charCount: 17
    });
    await dbH.db.insert(chunkEmbeddings).values({
      filingId: '0000AAPL-24-000002', sectionKey: 'part1_item2_mdna', subChunkIndex: 0,
      text: 'Quarterly results', embedding: vec, model: CURRENT_EMBED_MODEL,
      charOffsetStart: 0, charOffsetEnd: 17
    });
    await dbH.db.insert(watchlist).values({ userId, ticker: 'AAPL' });

    const provider = mockProvider(vec);
    const svc = new SearchService({ db: dbH.db, provider: provider as any });

    const tenKonly = await svc.searchAcrossWatchlist({ userId, query: 'risk', formTypes: ['10-K'] });
    expect(tenKonly.every((r) => r.formType === '10-K')).toBe(true);

    const tenQonly = await svc.searchAcrossWatchlist({ userId, query: 'risk', formTypes: ['10-Q'] });
    expect(tenQonly.every((r) => r.formType === '10-Q')).toBe(true);
  });

  it('searchAcrossWatchlist: respects limit parameter', async () => {
    const vec = Array(1024).fill(0.5);
    for (let i = 0; i < 5; i++) {
      const ticker = `T${i}`.padEnd(4, 'X');
      await seedSearchableFiling(dbH.db, ticker, vec);
      await dbH.db.insert(watchlist).values({ userId, ticker });
    }

    const provider = mockProvider(vec);
    const svc = new SearchService({ db: dbH.db, provider: provider as any });
    const results = await svc.searchAcrossWatchlist({ userId, query: 'risk', limit: 2 });
    expect(results).toHaveLength(2);
  });

  it('searchAcrossWatchlist: rejects oversized query', async () => {
    const provider = mockProvider();
    const svc = new SearchService({ db: dbH.db, provider: provider as any });
    await expect(
      svc.searchAcrossWatchlist({ userId, query: 'x'.repeat(1000) })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
