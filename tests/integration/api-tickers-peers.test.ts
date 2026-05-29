import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companiesUniverse } from '@/lib/db/schema';

config({ path: '.env.local' });

vi.mock('@/lib/auth/current-user', () => ({
  requireUserId: vi.fn(),
  UnauthorizedError: class UnauthorizedError extends Error {}
}));
vi.mock('@/lib/db/client', () => ({
  getServiceDb: vi.fn()
}));
vi.mock('@/lib/cache/redis', () => ({
  getRedisCache: vi.fn(() => ({
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined
  }))
}));
vi.mock('@/lib/providers/yfinance', () => ({
  YFinanceProvider: vi.fn().mockImplementation(() => ({
    name: 'yfinance',
    company: vi.fn().mockResolvedValue({ ticker: 'X', name: 'X', cik: null, exchange: null, sector: null, industry: null }),
    snapshot: vi.fn().mockResolvedValue({ ticker: 'X', price: 100, marketCap: 1e9, week52High: null, week52Low: null, pe: 20, ps: null, pb: null, evEbitda: 12, peg: null, asOf: new Date() }),
    statements: vi.fn().mockResolvedValue({ ticker: 'X', statementType: 'income', periodType: 'annual', rows: [] }),
    prices: vi.fn().mockResolvedValue({ ticker: 'X', range: '1Y', candles: [] }),
    insiderTrades: vi.fn().mockResolvedValue([]),
    news: vi.fn().mockResolvedValue([])
  }))
}));
vi.mock('@/lib/providers/financial-datasets', () => ({
  FinancialDatasetsProvider: vi.fn().mockImplementation(() => ({
    name: 'financial_datasets',
    company: vi.fn().mockResolvedValue({ ticker: 'X', name: 'X', cik: null, exchange: null, sector: null, industry: null }),
    snapshot: vi.fn().mockResolvedValue({ ticker: 'X', price: 100, marketCap: 1e9, week52High: null, week52Low: null, pe: 20, ps: null, pb: null, evEbitda: 12, peg: null, asOf: new Date() }),
    statements: vi.fn().mockResolvedValue({ ticker: 'X', statementType: 'income', periodType: 'annual', rows: [] }),
    prices: vi.fn().mockResolvedValue({ ticker: 'X', range: '1Y', candles: [] }),
    insiderTrades: vi.fn().mockResolvedValue([]),
    news: vi.fn().mockResolvedValue([])
  }))
}));
vi.mock('@/lib/env', () => ({
  loadServerEnv: vi.fn(() => ({ FINANCIAL_DATASETS_API_KEY: 'test-key' }))
}));

import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { GET } from '@/app/api/tickers/[symbol]/peers/route';

function vec(): number[] {
  const v = new Array(1024).fill(0);
  v[0] = 1;
  return v;
}

describe('GET /api/tickers/[symbol]/peers', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => {
    dbH = makeTestServiceDb();
    vi.mocked(requireUserId).mockResolvedValue('00000000-0000-0000-0000-000000000001');
  });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    vi.mocked(getServiceDb).mockReturnValue(dbH.db as any);
    await resetDb(dbH.db);
    await dbH.db.execute(sql`TRUNCATE TABLE companies_universe`);
    await dbH.db.insert(companiesUniverse).values([
      { ticker: 'TGT',  name: 'Target',  country: 'US', sector: 'Tech', description: 't',  descriptionEmbedding: vec(), marketCap: '500', sources: ['nyse'] },
      { ticker: 'PER1', name: 'Peer 1',  country: 'US', sector: 'Tech', description: 'p1', descriptionEmbedding: vec(), marketCap: '300', sources: ['nyse'] },
      { ticker: 'PER2', name: 'Peer 2',  country: 'US', sector: 'Tech', description: 'p2', descriptionEmbedding: vec(), marketCap: '600', sources: ['nyse'] },
      { ticker: 'PER3', name: 'Peer 3',  country: 'US', sector: 'Tech', description: 'p3', descriptionEmbedding: vec(), marketCap: '400', sources: ['nyse'] },
      { ticker: 'PER4', name: 'Peer 4',  country: 'US', sector: 'Tech', description: 'p4', descriptionEmbedding: vec(), marketCap: '700', sources: ['nyse'] },
      { ticker: 'PER5', name: 'Peer 5',  country: 'US', sector: 'Tech', description: 'p5', descriptionEmbedding: vec(), marketCap: '450', sources: ['nyse'] }
    ]);
  });

  it('returns 200 with PeersResult JSON for a valid ticker', async () => {
    const req = new Request('http://localhost/api/tickers/TGT/peers?k=5');
    const res = await GET(req, { params: { symbol: 'TGT' } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.target.ticker).toBe('TGT');
    expect(Array.isArray(json.peers)).toBe(true);
    expect(json.fallback).toBe('strict');
    expect(json.k).toBe(5);
  });

  it('normalizes lowercase ticker to uppercase', async () => {
    const req = new Request('http://localhost/api/tickers/tgt/peers');
    const res = await GET(req, { params: { symbol: 'tgt' } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.target.ticker).toBe('TGT');
  });

  it('rejects invalid ticker with 400', async () => {
    const req = new Request('http://localhost/api/tickers/has-dash/peers');
    const res = await GET(req, { params: { symbol: 'has-dash' } });
    expect(res.status).toBe(400);
  });

  it('rejects k > 10 with 400', async () => {
    const req = new Request('http://localhost/api/tickers/TGT/peers?k=99');
    const res = await GET(req, { params: { symbol: 'TGT' } });
    expect(res.status).toBe(400);
  });

  it('rejects k < 1 with 400', async () => {
    const req = new Request('http://localhost/api/tickers/TGT/peers?k=0');
    const res = await GET(req, { params: { symbol: 'TGT' } });
    expect(res.status).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    const { UnauthorizedError } = await import('@/lib/auth/current-user');
    vi.mocked(requireUserId).mockRejectedValueOnce(new UnauthorizedError());
    const req = new Request('http://localhost/api/tickers/TGT/peers');
    const res = await GET(req, { params: { symbol: 'TGT' } });
    expect(res.status).toBe(401);
  });

  it('sets Cache-Control: private, max-age=300', async () => {
    const req = new Request('http://localhost/api/tickers/TGT/peers');
    const res = await GET(req, { params: { symbol: 'TGT' } });
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
  });
});
