import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, filings, filingChunks } from '@/lib/db/schema';
import { FilingsService } from '@/lib/services/filings';

config({ path: '.env.local' });

function mockProvider(opts: {
  cik?: string;
  filings?: Array<{ accessionNo: string; formType: string; filingDate: string; periodEnd: string | null; primaryDocUrl: string }>;
  sections?: Array<{
    section_key: string;
    section_title: string;
    text: string;
    char_offset_start: number;
    char_offset_end: number;
    tables?: Array<{ id: number; rows: string[][]; colspans: number[][]; head_row_count: number }>;
  }>;
}) {
  return {
    resolveCik: vi.fn().mockResolvedValue(opts.cik ?? '0000320193'),
    listFilings: vi.fn().mockResolvedValue({ cik: opts.cik ?? '0000320193', filings: opts.filings ?? [] }),
    fetchFiling: vi.fn().mockResolvedValue({
      formType: '10-K',
      primaryDocUrl: 'https://x',
      sections: (opts.sections ?? []).map((s) => ({ ...s, tables: s.tables ?? [] })),
      totalChars: 1000
    })
  };
}

describe('FilingsService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.', cik: null });
  });

  it('getList: empty case returns needsIngest=true', async () => {
    const svc = new FilingsService({ db: dbH.db, provider: mockProvider({}) as any });
    const res = await svc.getList('AAPL');
    expect(res.filings).toEqual([]);
    expect(res.needsIngest).toBe(true);
  });

  it('getList: populated case returns the filings sorted desc', async () => {
    await dbH.db.insert(filings).values([
      { accessionNo: '0000320193-24-000080', ticker: 'AAPL', cik: '0000320193', formType: '10-Q', filingDate: '2024-08-02', periodEnd: '2024-06-29', primaryDocUrl: 'https://x/2' },
      { accessionNo: '0000320193-24-000123', ticker: 'AAPL', cik: '0000320193', formType: '10-K', filingDate: '2024-11-01', periodEnd: '2024-09-28', primaryDocUrl: 'https://x/1' }
    ]);
    const svc = new FilingsService({ db: dbH.db, provider: mockProvider({}) as any });
    const res = await svc.getList('AAPL');
    expect(res.filings).toHaveLength(2);
    expect(res.filings[0]!.accessionNo).toBe('0000320193-24-000123'); // newest first
    expect(res.needsIngest).toBe(false);
  });

  it('ingest: resolves CIK, lists, fetches, persists chunks', async () => {
    const provider = mockProvider({
      cik: '0000320193',
      filings: [{
        accessionNo: '0000320193-24-000123',
        formType: '10-K',
        filingDate: '2024-11-01',
        periodEnd: '2024-09-28',
        primaryDocUrl: 'https://x/1'
      }],
      sections: [
        { section_key: 'item_1_business', section_title: 'Business', text: 'Apple does things.', char_offset_start: 0, char_offset_end: 18 }
      ]
    });
    const svc = new FilingsService({ db: dbH.db, provider: provider as any });
    const summary = await svc.ingest('AAPL');
    expect(summary.count).toBe(1);
    expect(provider.resolveCik).toHaveBeenCalledWith('AAPL');

    const f = await dbH.db.select().from(filings).where(eq(filings.ticker, 'AAPL'));
    expect(f).toHaveLength(1);
    expect(f[0]!.parsedAt).not.toBeNull();

    const c = await dbH.db.select().from(filingChunks);
    expect(c).toHaveLength(1);
    expect(c[0]!.sectionKey).toBe('item_1_business');

    const company = await dbH.db.select().from(companies).where(eq(companies.ticker, 'AAPL'));
    expect(company[0]!.cik).toBe('0000320193');
  });

  it('writes section.tables JSONB on ingest and reads it back via getAllSectionTexts', async () => {
    const provider = mockProvider({
      cik: '0000320193',
      filings: [{
        accessionNo: '0000320193-26-000001',
        formType: '10-Q',
        filingDate: '2026-01-01',
        periodEnd: '2026-01-01',
        primaryDocUrl: 'https://x/q1'
      }],
      sections: [
        {
          section_key: 'part1_item1_financial_statements',
          section_title: 'Financial Statements',
          text: 'Item 1. Financial Statements\n\n<<TABLE_0>>\n\nEnd.',
          char_offset_start: 0,
          char_offset_end: 47,
          tables: [
            {
              id: 0,
              rows: [['Product', 'Revenue'], ['Phones', '$100']],
              colspans: [[1, 1], [1, 1]],
              head_row_count: 1
            }
          ]
        }
      ]
    });

    const svc = new FilingsService({ db: dbH.db, provider: provider as any });
    await svc.ingest('AAPL');

    const sections = await svc.getAllSectionTexts('0000320193-26-000001');
    expect(sections).toHaveLength(1);
    expect(sections[0]!.tables).toEqual([
      {
        id: 0,
        rows: [['Product', 'Revenue'], ['Phones', '$100']],
        colspans: [[1, 1], [1, 1]],
        head_row_count: 1
      }
    ]);
  });

  it('ingest: skips resolveCik when company.cik already set', async () => {
    await dbH.db.update(companies).set({ cik: '0000320193' }).where(eq(companies.ticker, 'AAPL'));
    const provider = mockProvider({ filings: [] });
    const svc = new FilingsService({ db: dbH.db, provider: provider as any });
    await svc.ingest('AAPL');
    expect(provider.resolveCik).not.toHaveBeenCalled();
    expect(provider.listFilings).toHaveBeenCalledWith('0000320193', ['10-K', '10-Q'], 5);
  });

  it('getSectionText returns the chunk text', async () => {
    await dbH.db.insert(filings).values({
      accessionNo: '0000320193-24-000123', ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
    });
    await dbH.db.insert(filingChunks).values({
      filingId: '0000320193-24-000123', sectionKey: 'item_1_business',
      sectionTitle: 'Business', text: 'Apple does things.', charCount: 18
    });
    const svc = new FilingsService({ db: dbH.db, provider: mockProvider({}) as any });
    const text = await svc.getSectionText('0000320193-24-000123', 'item_1_business');
    expect(text).toBe('Apple does things.');
  });

  it('getSectionText returns null for missing section', async () => {
    const svc = new FilingsService({ db: dbH.db, provider: mockProvider({}) as any });
    const text = await svc.getSectionText('nope', 'nope');
    expect(text).toBeNull();
  });

  it('getFiling returns metadata + section list (no text)', async () => {
    await dbH.db.insert(filings).values({
      accessionNo: '0000320193-24-000123', ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
    });
    await dbH.db.insert(filingChunks).values([
      { filingId: '0000320193-24-000123', sectionKey: 'item_1_business', sectionTitle: 'Business', text: 'a', charCount: 1 },
      { filingId: '0000320193-24-000123', sectionKey: 'item_1a_risk_factors', sectionTitle: 'Risk Factors', text: 'b', charCount: 1 }
    ]);
    const svc = new FilingsService({ db: dbH.db, provider: mockProvider({}) as any });
    const res = await svc.getFiling('AAPL', '0000320193-24-000123');
    expect(res).not.toBeNull();
    expect(res!.filing.accessionNo).toBe('0000320193-24-000123');
    expect(res!.sections).toHaveLength(2);
    expect((res!.sections[0] as any).text).toBeUndefined();
  });

  it('getAllSectionTexts returns chunks ordered by id', async () => {
    await dbH.db.insert(filings).values({
      accessionNo: '0000320193-24-000123', ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
    });
    await dbH.db.insert(filingChunks).values([
      { filingId: '0000320193-24-000123', sectionKey: 'item_1_business', sectionTitle: 'Business', text: 'A', charCount: 1 },
      { filingId: '0000320193-24-000123', sectionKey: 'item_7_mdna', sectionTitle: 'MD&A', text: 'B', charCount: 1 },
      { filingId: '0000320193-24-000123', sectionKey: 'item_1a_risk_factors', sectionTitle: 'Risk Factors', text: 'C', charCount: 1 }
    ]);
    const svc = new FilingsService({ db: dbH.db, provider: mockProvider({}) as any });
    const sections = await svc.getAllSectionTexts('0000320193-24-000123');
    expect(sections).toHaveLength(3);
    expect(sections[0]!.sectionKey).toBe('item_1_business');
    expect(sections[1]!.sectionKey).toBe('item_7_mdna');
    expect(sections[2]!.sectionKey).toBe('item_1a_risk_factors');
    expect(sections[0]!.text).toBe('A');
  });

  it('getAllSectionTexts returns empty array for missing filing', async () => {
    const svc = new FilingsService({ db: dbH.db, provider: mockProvider({}) as any });
    const sections = await svc.getAllSectionTexts('nope');
    expect(sections).toEqual([]);
  });

  it('ingest: calls embeddingsService.embedFiling when supplied', async () => {
    const provider = mockProvider({
      cik: '0000320193',
      filings: [{
        accessionNo: '0000320193-24-000123',
        formType: '10-K',
        filingDate: '2024-11-01',
        periodEnd: '2024-09-28',
        primaryDocUrl: 'https://x/1'
      }],
      sections: [
        { section_key: 'item_1_business', section_title: 'Business', text: 'Apple does things.', char_offset_start: 0, char_offset_end: 18 }
      ]
    });
    const embedFiling = vi.fn().mockResolvedValue({ filingId: '0000320193-24-000123', count: 5, durationMs: 100 });
    const embeddingsService = { embedFiling } as any;
    const svc = new FilingsService({ db: dbH.db, provider: provider as any, embeddingsService });

    await svc.ingest('AAPL');

    expect(embedFiling).toHaveBeenCalledWith('0000320193-24-000123');
  });

  it('ingest: embedding failure does NOT block ingestion', async () => {
    const provider = mockProvider({
      cik: '0000320193',
      filings: [{
        accessionNo: '0000320193-24-000123',
        formType: '10-K',
        filingDate: '2024-11-01',
        periodEnd: '2024-09-28',
        primaryDocUrl: 'https://x/1'
      }],
      sections: [
        { section_key: 'item_1_business', section_title: 'Business', text: 'Apple does things.', char_offset_start: 0, char_offset_end: 18 }
      ]
    });
    const embedFiling = vi.fn().mockRejectedValue(new Error('DashScope unavailable'));
    const embeddingsService = { embedFiling } as any;
    const svc = new FilingsService({ db: dbH.db, provider: provider as any, embeddingsService });

    const summary = await svc.ingest('AAPL');

    expect(summary.succeeded).toBe(1);
    expect(embedFiling).toHaveBeenCalled();
  });
});
