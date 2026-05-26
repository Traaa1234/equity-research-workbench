import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companies, filings, filingChunks, filingSummaries } from '@/lib/db/schema';
import { CURRENT_MODEL, CURRENT_PROMPT_VERSION } from '@/lib/services/summaries';

config({ path: '.env.local' });

const ACCESSION = '0000320193-24-000123';

async function seedFilingWithChunks(db: any) {
  await db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
  await db.insert(filings).values({
    accessionNo: ACCESSION, ticker: 'AAPL', cik: '0000320193',
    formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
  });
  await db.insert(filingChunks).values({
    filingId: ACCESSION, sectionKey: 'item_1_business',
    sectionTitle: 'Business', text: 'Apple makes phones.', charCount: 19
  });
}

describe('/api/tickers/[symbol]/filings/[accession]/summary', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => newUserId(),
      getCurrentUserId: async () => newUserId(),
      UnauthorizedError: class extends Error {}
    }));
    vi.doMock('@/lib/providers/qwen', () => ({
      QwenProviderImpl: class {
        async summarize() {
          return { text: '## What they do\nApple makes phones.\n\n## Bottom line\nServices growth.', inputTokens: 1000, outputTokens: 200 };
        }
      }
    }));
  });

  it('GET cache hit returns existing summary', async () => {
    await seedFilingWithChunks(dbH.db);
    await dbH.db.insert(filingSummaries).values({
      filingId: ACCESSION,
      summaryText: 'cached briefing',
      model: CURRENT_MODEL,
      promptVersion: CURRENT_PROMPT_VERSION,
      inputTokens: 100,
      outputTokens: 50
    });
    const { GET } = await import('@/app/api/tickers/[symbol]/filings/[accession]/summary/route');
    const res = await GET(new Request(`http://localhost/api/tickers/AAPL/filings/${ACCESSION}/summary`), {
      params: { symbol: 'AAPL', accession: ACCESSION }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summaryText).toBe('cached briefing');
    expect(body.inputTokens).toBe(100);
  });

  it('GET cache miss generates via provider mock', async () => {
    await seedFilingWithChunks(dbH.db);
    const { GET } = await import('@/app/api/tickers/[symbol]/filings/[accession]/summary/route');
    const res = await GET(new Request(`http://localhost/api/tickers/AAPL/filings/${ACCESSION}/summary`), {
      params: { symbol: 'AAPL', accession: ACCESSION }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summaryText).toContain('Apple makes phones');
    expect(body.model).toBe(CURRENT_MODEL);
  });

  it('POST?regenerate=1 always re-runs', async () => {
    await seedFilingWithChunks(dbH.db);
    await dbH.db.insert(filingSummaries).values({
      filingId: ACCESSION,
      summaryText: 'stale cached',
      model: CURRENT_MODEL,
      promptVersion: CURRENT_PROMPT_VERSION
    });
    const { POST } = await import('@/app/api/tickers/[symbol]/filings/[accession]/summary/route');
    const res = await POST(
      new Request(`http://localhost/api/tickers/AAPL/filings/${ACCESSION}/summary?regenerate=1`, { method: 'POST' }),
      { params: { symbol: 'AAPL', accession: ACCESSION } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summaryText).toContain('Apple makes phones'); // from the mock provider
  });

  it('POST without regenerate=1 returns 400', async () => {
    const { POST } = await import('@/app/api/tickers/[symbol]/filings/[accession]/summary/route');
    const res = await POST(
      new Request(`http://localhost/api/tickers/AAPL/filings/${ACCESSION}/summary`, { method: 'POST' }),
      { params: { symbol: 'AAPL', accession: ACCESSION } }
    );
    expect(res.status).toBe(400);
  });

  it('GET invalid ticker returns 400', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/filings/[accession]/summary/route');
    const res = await GET(new Request('http://localhost/api/tickers/bogus-1/filings/x/summary'), {
      params: { symbol: 'bogus-1', accession: 'x' }
    });
    expect(res.status).toBe(400);
  });

  it('GET unknown filing returns 400 (ValidationError from service)', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/filings/[accession]/summary/route');
    const res = await GET(
      new Request(`http://localhost/api/tickers/AAPL/filings/9999999999-99-999999/summary`),
      { params: { symbol: 'AAPL', accession: '9999999999-99-999999' } }
    );
    expect(res.status).toBe(400);
  });
});
