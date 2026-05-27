import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, filings, filingChunks, chunkEmbeddings } from '@/lib/db/schema';
import { FilingsService } from '@/lib/services/filings';
import { EmbeddingsService, CURRENT_EMBED_MODEL } from '@/lib/services/embeddings';

config({ path: '.env.local' });

const ACCESSION = '0000320193-24-000123';

function mockProvider(vectorsToReturn?: number[][]) {
  return {
    embed: vi.fn().mockImplementation(async (req: { texts: string[] }) => {
      const vectors = vectorsToReturn ?? req.texts.map(() => Array(1024).fill(0).map((_, i) => i / 1024));
      return { vectors, inputTokens: req.texts.length * 100 };
    })
  };
}

async function seedFilingWithChunks(db: any) {
  await db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
  await db.insert(filings).values({
    accessionNo: ACCESSION, ticker: 'AAPL', cik: '0000320193',
    formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
  });
  await db.insert(filingChunks).values([
    { filingId: ACCESSION, sectionKey: 'item_1_business', sectionTitle: 'Business', text: 'Apple does many things.', charCount: 23 },
    { filingId: ACCESSION, sectionKey: 'item_7_mdna', sectionTitle: 'MD&A', text: 'Revenue increased materially.', charCount: 29 }
  ]);
}

describe('EmbeddingsService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => { await resetDb(dbH.db); });

  it('embedFiling: cache miss embeds + persists', async () => {
    await seedFilingWithChunks(dbH.db);
    const provider = mockProvider();
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new EmbeddingsService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.embedFiling(ACCESSION);

    expect(result.count).toBeGreaterThan(0);
    expect(provider.embed).toHaveBeenCalled();
    const rows = await dbH.db.select().from(chunkEmbeddings).where(eq(chunkEmbeddings.filingId, ACCESSION));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.model).toBe(CURRENT_EMBED_MODEL);
  });

  it('embedFiling: cache hit (already embedded with current model) is a no-op', async () => {
    await seedFilingWithChunks(dbH.db);
    await dbH.db.insert(chunkEmbeddings).values({
      filingId: ACCESSION,
      sectionKey: 'item_1_business',
      subChunkIndex: 0,
      text: 'Apple does many things.',
      embedding: Array(1024).fill(0.5),
      model: CURRENT_EMBED_MODEL,
      charOffsetStart: 0,
      charOffsetEnd: 23
    });
    const provider = mockProvider();
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new EmbeddingsService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.embedFiling(ACCESSION);

    expect(provider.embed).not.toHaveBeenCalled();
    expect(result.count).toBe(0);
  });

  it('embedFiling: re-embeds when only old-model rows exist', async () => {
    await seedFilingWithChunks(dbH.db);
    await dbH.db.insert(chunkEmbeddings).values({
      filingId: ACCESSION,
      sectionKey: 'item_1_business',
      subChunkIndex: 0,
      text: 'stale',
      embedding: Array(1024).fill(0),
      model: 'old-model-name',
      charOffsetStart: 0,
      charOffsetEnd: 5
    });
    const provider = mockProvider();
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new EmbeddingsService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.embedFiling(ACCESSION);

    expect(provider.embed).toHaveBeenCalled();
    expect(result.count).toBeGreaterThan(0);
  });

  it('embedFiling: filing with no chunks returns count 0 without calling provider', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    await dbH.db.insert(filings).values({
      accessionNo: ACCESSION, ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
    });
    const provider = mockProvider();
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new EmbeddingsService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.embedFiling(ACCESSION);

    expect(result.count).toBe(0);
    expect(provider.embed).not.toHaveBeenCalled();
  });

  it('embedFiling: partial-write recovery — at least one current-model row triggers no-op', async () => {
    await seedFilingWithChunks(dbH.db);
    await dbH.db.insert(chunkEmbeddings).values({
      filingId: ACCESSION,
      sectionKey: 'item_1_business',
      subChunkIndex: 0,
      text: 'pre-existing',
      embedding: Array(1024).fill(0.1),
      model: CURRENT_EMBED_MODEL,
      charOffsetStart: 0,
      charOffsetEnd: 12
    });
    const provider = mockProvider();
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new EmbeddingsService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.embedFiling(ACCESSION);
    expect(result.count).toBe(0);
  });

  it('embedFiling: substitutes table markers before embedding (no marker survives in chunk_embeddings.text)', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    await dbH.db.insert(filings).values({
      accessionNo: ACCESSION, ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
    });
    await dbH.db.insert(filingChunks).values({
      filingId: ACCESSION,
      sectionKey: 'part1_item1_financial_statements',
      sectionTitle: 'Financial Statements',
      text: 'Lead-in.\n\n<<TABLE_0>>\n\nTrailing.',
      charCount: 100,
      charOffsetStart: 0,
      charOffsetEnd: 100,
      tables: [
        {
          id: 0,
          rows: [['Product', 'Revenue'], ['Phones', '$100']],
          colspans: [[1, 1], [1, 1]],
          head_row_count: 1
        }
      ]
    });

    const provider = mockProvider();
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new EmbeddingsService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    await svc.embedFiling(ACCESSION);

    const rows = await dbH.db
      .select({ text: chunkEmbeddings.text })
      .from(chunkEmbeddings)
      .where(eq(chunkEmbeddings.filingId, ACCESSION));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.text).not.toContain('<<TABLE_');
      expect(r.text).toContain('Product | Revenue');
    }
  });

  it('embedFiling: writes a refresh_runs row on success', async () => {
    await seedFilingWithChunks(dbH.db);
    const provider = mockProvider();
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new EmbeddingsService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    await svc.embedFiling(ACCESSION);

    const { refreshRuns } = await import('@/lib/db/schema');
    const runs = await dbH.db.select().from(refreshRuns).where(eq(refreshRuns.kind, `embed:${ACCESSION}`));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(true);
    expect(runs[0]!.sourceUsed).toBe('dashscope_embed');
  });
});
