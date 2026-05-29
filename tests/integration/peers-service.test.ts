import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, companiesUniverse, snapshots } from '@/lib/db/schema';
import { PeersService } from '@/lib/services/peers';
import type { Provider } from '@/lib/providers/types';

config({ path: '.env.local' });

function vec(seed: 'A' | 'B' | 'C' | 'D'): number[] {
  const v = new Array(1024).fill(0);
  if (seed === 'A') v[0] = 1;
  if (seed === 'B') v[1] = 1;
  if (seed === 'C') v[2] = 1;
  if (seed === 'D') v[3] = 1;
  return v;
}

function mockProvider(overrides?: Partial<Provider>): Provider {
  return {
    name: 'mock' as any,
    company: vi.fn().mockResolvedValue({ ticker: 'X', name: 'X', cik: null, exchange: null, sector: null, industry: null }),
    snapshot: vi.fn().mockResolvedValue({
      ticker: 'X', price: 100, marketCap: 1e9, week52High: null, week52Low: null,
      pe: 20, ps: null, pb: null, evEbitda: 12, peg: null, asOf: new Date()
    }),
    statements: vi.fn().mockResolvedValue({ ticker: 'X', statementType: 'income', periodType: 'annual', rows: [] }),
    prices: vi.fn().mockResolvedValue({ ticker: 'X', range: '1Y', candles: [] }),
    insiderTrades: vi.fn(),
    news: vi.fn(),
    ...overrides
  } as unknown as Provider;
}

const mockRedis = {
  get: async () => null,
  set: async () => undefined,
  delete: async () => undefined
} as any;

describe('PeersService.getPeers', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });

  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.execute(sql`TRUNCATE TABLE companies_universe`);

    await dbH.db.insert(companiesUniverse).values([
      { ticker: 'TGT',  name: 'Target Inc',    country: 'US', exchange: 'NYSE', sector: 'Technology', description: 'target', descriptionEmbedding: vec('A'), marketCap: '500', sources: ['nyse'] },
      { ticker: 'PER1', name: 'Peer One',      country: 'US', exchange: 'NYSE', sector: 'Technology', description: 'p1',     descriptionEmbedding: vec('A'), marketCap: '300', sources: ['nyse'] },
      { ticker: 'PER2', name: 'Peer Two',      country: 'US', exchange: 'NYSE', sector: 'Technology', description: 'p2',     descriptionEmbedding: vec('A'), marketCap: '600', sources: ['nyse'] },
      { ticker: 'PER3', name: 'Peer Three',    country: 'US', exchange: 'NYSE', sector: 'Technology', description: 'p3',     descriptionEmbedding: vec('A'), marketCap: '400', sources: ['nyse'] },
      { ticker: 'PER4', name: 'Peer Four',     country: 'US', exchange: 'NYSE', sector: 'Technology', description: 'p4',     descriptionEmbedding: vec('A'), marketCap: '700', sources: ['nyse'] },
      { ticker: 'PER5', name: 'Peer Five',     country: 'US', exchange: 'NYSE', sector: 'Technology', description: 'p5',     descriptionEmbedding: vec('A'), marketCap: '450', sources: ['nyse'] },
      { ticker: 'WAY1', name: 'Wrong Country', country: 'BR', exchange: 'NYSE', sector: 'Technology', description: 'br',     descriptionEmbedding: vec('A'), marketCap: '500', sources: ['nyse'] },
      { ticker: 'WAY2', name: 'Wrong Size',    country: 'US', exchange: 'NYSE', sector: 'Technology', description: 'huge',   descriptionEmbedding: vec('A'), marketCap: '5000', sources: ['nyse'] }
    ]);
  });

  it('returns target + 5 peers when strict query yields enough', async () => {
    const yf = mockProvider();
    const svc = new PeersService({ db: dbH.db, primary: yf, fallback: yf, redis: mockRedis });
    const result = await svc.getPeers('TGT', 5);
    expect(result.target.ticker).toBe('TGT');
    expect(result.peers).toHaveLength(5);
    expect(result.fallback).toBe('strict');
    expect(result.peers.map((p) => p.ticker).sort()).toEqual(['PER1', 'PER2', 'PER3', 'PER4', 'PER5']);
    expect(result.peers.every((p) => p.similarity != null && p.similarity > 0.99)).toBe(true);
  });

  it('promotes missing peers into companies + snapshots tables', async () => {
    const yf = mockProvider();
    const svc = new PeersService({ db: dbH.db, primary: yf, fallback: yf, redis: mockRedis });
    await svc.getPeers('TGT', 5);

    const rows = await dbH.db.select().from(companies);
    expect(rows.map((r) => r.ticker).sort()).toEqual(['PER1', 'PER2', 'PER3', 'PER4', 'PER5', 'TGT']);
    const snaps = await dbH.db.select().from(snapshots);
    expect(snaps).toHaveLength(6);
  });

  it('skips yfinance for peers whose companies.last_refreshed_at is < 24h', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    await dbH.db.insert(companies).values([
      { ticker: 'TGT',  name: 'Target Inc', lastRefreshedAt: recent },
      { ticker: 'PER1', name: 'Peer One',   lastRefreshedAt: recent },
      { ticker: 'PER2', name: 'Peer Two',   lastRefreshedAt: recent },
      { ticker: 'PER3', name: 'Peer Three', lastRefreshedAt: recent },
      { ticker: 'PER4', name: 'Peer Four',  lastRefreshedAt: recent },
      { ticker: 'PER5', name: 'Peer Five',  lastRefreshedAt: recent }
    ]);
    const yf = mockProvider();
    const svc = new PeersService({ db: dbH.db, primary: yf, fallback: yf, redis: mockRedis });
    await svc.getPeers('TGT', 5);
    expect(yf.snapshot).not.toHaveBeenCalled();
  });

  it('partial failure: yfinance throws for one peer → that row marked unavailable, others render', async () => {
    const yf = mockProvider({
      snapshot: vi.fn().mockImplementation(async (t: string) => {
        if (t === 'PER3') throw new Error('delisted');
        return {
          ticker: t, price: 100, marketCap: 1e9, week52High: null, week52Low: null,
          pe: 20, ps: null, pb: null, evEbitda: 12, peg: null, asOf: new Date()
        };
      })
    });
    const svc = new PeersService({ db: dbH.db, primary: yf, fallback: yf, redis: mockRedis });
    const result = await svc.getPeers('TGT', 5);
    expect(result.peers).toHaveLength(5);
    const per3 = result.peers.find((p) => p.ticker === 'PER3');
    expect(per3?.dataStatus).toBe('unavailable');
    const others = result.peers.filter((p) => p.ticker !== 'PER3');
    expect(others.every((p) => p.dataStatus === 'available')).toBe(true);
  });

  it('falls back to no_country when strict yields < K', async () => {
    await dbH.db.execute(sql`DELETE FROM companies_universe WHERE ticker IN ('PER2','PER3','PER4','PER5')`);
    await dbH.db.insert(companiesUniverse).values([
      { ticker: 'BR1', name: 'BR One',  country: 'BR', exchange: 'NYSE', sector: 'Technology', description: 'br1', descriptionEmbedding: vec('A'), marketCap: '300', sources: ['nyse'] },
      { ticker: 'BR2', name: 'BR Two',  country: 'BR', exchange: 'NYSE', sector: 'Technology', description: 'br2', descriptionEmbedding: vec('A'), marketCap: '600', sources: ['nyse'] },
      { ticker: 'BR3', name: 'BR Three',country: 'BR', exchange: 'NYSE', sector: 'Technology', description: 'br3', descriptionEmbedding: vec('A'), marketCap: '400', sources: ['nyse'] },
      { ticker: 'BR4', name: 'BR Four', country: 'BR', exchange: 'NYSE', sector: 'Technology', description: 'br4', descriptionEmbedding: vec('A'), marketCap: '700', sources: ['nyse'] }
    ]);

    const yf = mockProvider();
    const svc = new PeersService({ db: dbH.db, primary: yf, fallback: yf, redis: mockRedis });
    const result = await svc.getPeers('TGT', 5);
    expect(result.fallback).toBe('no_country');
    expect(result.peers).toHaveLength(5);
    expect(result.peers.map((p) => p.ticker).sort()).toEqual(['BR1', 'BR2', 'BR3', 'BR4', 'PER1']);
  });

  it('returns target_missing when target absent from companies_universe', async () => {
    const yf = mockProvider();
    const svc = new PeersService({ db: dbH.db, primary: yf, fallback: yf, redis: mockRedis });
    const result = await svc.getPeers('NOSUCH', 5);
    expect(result.fallback).toBe('target_missing');
    expect(result.peers).toEqual([]);
    expect(result.target.ticker).toBe('NOSUCH');
    expect(result.target.dataStatus).toBe('unavailable');
  });
});
