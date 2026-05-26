import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, filings, filingChunks, filingSummaries } from '@/lib/db/schema';
import { FilingsService } from '@/lib/services/filings';
import { SummariesService, CURRENT_MODEL, CURRENT_PROMPT_VERSION } from '@/lib/services/summaries';
import { ValidationError } from '@/lib/providers/types';

config({ path: '.env.local' });

function mockQwen(textOrError: string | Error = 'mocked summary text long enough') {
  return {
    summarize: vi.fn().mockImplementation(async () => {
      if (textOrError instanceof Error) throw textOrError;
      return { text: textOrError, inputTokens: 1000, outputTokens: 200 };
    })
  };
}

const ACCESSION = '0000320193-24-000123';

async function seedFilingWithChunks(db: any) {
  await db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
  await db.insert(filings).values({
    accessionNo: ACCESSION, ticker: 'AAPL', cik: '0000320193',
    formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
  });
  await db.insert(filingChunks).values([
    { filingId: ACCESSION, sectionKey: 'item_1_business', sectionTitle: 'Business', text: 'Apple does things.', charCount: 18 },
    { filingId: ACCESSION, sectionKey: 'item_7_mdna', sectionTitle: 'MD&A', text: 'Revenue was up.', charCount: 15 }
  ]);
}

describe('SummariesService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => { await resetDb(dbH.db); });

  it('getOrGenerate: cache miss → calls provider, persists, returns', async () => {
    await seedFilingWithChunks(dbH.db);
    const provider = mockQwen('## What they do\nApple makes phones.\n\n## Bottom line\nServices growth.');
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new SummariesService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.getOrGenerate(ACCESSION);

    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(result.summaryText).toContain('Apple makes phones');
    expect(result.model).toBe(CURRENT_MODEL);
    expect(result.promptVersion).toBe(CURRENT_PROMPT_VERSION);
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(200);

    const rows = await dbH.db.select().from(filingSummaries).where(eq(filingSummaries.filingId, ACCESSION));
    expect(rows).toHaveLength(1);
  });

  it('getOrGenerate: cache hit → does not call provider', async () => {
    await seedFilingWithChunks(dbH.db);
    await dbH.db.insert(filingSummaries).values({
      filingId: ACCESSION,
      summaryText: 'cached summary that is long enough',
      model: CURRENT_MODEL,
      promptVersion: CURRENT_PROMPT_VERSION,
      inputTokens: 999,
      outputTokens: 100
    });
    const provider = mockQwen('SHOULD NOT BE RETURNED');
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new SummariesService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.getOrGenerate(ACCESSION);

    expect(provider.summarize).not.toHaveBeenCalled();
    expect(result.summaryText).toBe('cached summary that is long enough');
    expect(result.inputTokens).toBe(999);
  });

  it('getOrGenerate: stale model triggers regeneration', async () => {
    await seedFilingWithChunks(dbH.db);
    await dbH.db.insert(filingSummaries).values({
      filingId: ACCESSION,
      summaryText: 'stale summary',
      model: 'old-model-name',
      promptVersion: CURRENT_PROMPT_VERSION
    });
    const provider = mockQwen('## fresh summary text long enough\n');
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new SummariesService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.getOrGenerate(ACCESSION);

    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(result.summaryText).toContain('fresh summary');
    expect(result.model).toBe(CURRENT_MODEL);
  });

  it('getOrGenerate: stale prompt_version triggers regeneration', async () => {
    await seedFilingWithChunks(dbH.db);
    await dbH.db.insert(filingSummaries).values({
      filingId: ACCESSION,
      summaryText: 'stale summary',
      model: CURRENT_MODEL,
      promptVersion: 'v0'
    });
    const provider = mockQwen('## fresh prompt version output long enough\n');
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new SummariesService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.getOrGenerate(ACCESSION);

    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(result.promptVersion).toBe(CURRENT_PROMPT_VERSION);
  });

  it('regenerate: always re-runs even when cache is fresh', async () => {
    await seedFilingWithChunks(dbH.db);
    await dbH.db.insert(filingSummaries).values({
      filingId: ACCESSION,
      summaryText: 'fresh cached summary',
      model: CURRENT_MODEL,
      promptVersion: CURRENT_PROMPT_VERSION
    });
    const provider = mockQwen('## regenerated output that is long enough\n');
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new SummariesService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.regenerate(ACCESSION);

    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(result.summaryText).toContain('regenerated output');
  });

  it('getOrGenerate: filing with no chunks throws ValidationError', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    await dbH.db.insert(filings).values({
      accessionNo: ACCESSION, ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
    });
    // No chunks inserted.
    const provider = mockQwen('should not be called');
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new SummariesService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    await expect(svc.getOrGenerate(ACCESSION)).rejects.toBeInstanceOf(ValidationError);
    expect(provider.summarize).not.toHaveBeenCalled();
  });
});
