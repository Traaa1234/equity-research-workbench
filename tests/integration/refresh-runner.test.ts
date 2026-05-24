import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, newUserId, resetDb } from '../helpers/test-db';
import { companies, watchlist, refreshRuns } from '@/lib/db/schema';
import { runRefresh } from '@/lib/ingest/refresh-runner';

config({ path: '.env.local' });

describe('runRefresh', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });

  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values([
      { ticker: 'AAPL', name: 'Apple', isSeed: true },
      { ticker: 'MSFT', name: 'Microsoft', isSeed: false }
    ]);
    await dbH.db.insert(watchlist).values({ userId: newUserId(), ticker: 'MSFT' });
  });

  it('iterates over seed + watchlisted union and refreshes snapshots', async () => {
    const snapshotSvc = {
      refresh: vi.fn().mockResolvedValue({
        ticker: '', price: 100, marketCap: 1e9,
        week52High: null, week52Low: null,
        pe: null, ps: null, pb: null, evEbitda: null, peg: null,
        asOf: new Date()
      })
    };
    const out = await runRefresh({
      db: dbH.db,
      kind: 'snapshot',
      snapshotSvc: snapshotSvc as any,
      financialsSvc: { refresh: vi.fn() } as any,
      pricesSvc: { refresh: vi.fn() } as any
    });
    expect(out.attempted).toBe(2);
    expect(out.succeeded).toBe(2);
    expect(out.failed).toBe(0);
    expect(snapshotSvc.refresh).toHaveBeenCalledTimes(2);

    const runs = await dbH.db.select().from(refreshRuns);
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.kind === 'snapshot')).toBe(true);
    expect(runs.every((r) => r.ok === true)).toBe(true);
  });

  it('records ok=false + error when a ticker fails', async () => {
    const snapshotSvc = {
      refresh: vi
        .fn()
        .mockResolvedValueOnce({
          ticker: 'AAPL', price: 100, marketCap: 1e9,
          week52High: null, week52Low: null,
          pe: null, ps: null, pb: null, evEbitda: null, peg: null,
          asOf: new Date()
        })
        .mockRejectedValueOnce(new Error('boom'))
    };
    const out = await runRefresh({
      db: dbH.db,
      kind: 'snapshot',
      snapshotSvc: snapshotSvc as any,
      financialsSvc: { refresh: vi.fn() } as any,
      pricesSvc: { refresh: vi.fn() } as any
    });
    expect(out.attempted).toBe(2);
    expect(out.succeeded).toBe(1);
    expect(out.failed).toBe(1);

    const runs = await dbH.db.select().from(refreshRuns);
    const failed = runs.find((r) => r.ok === false);
    expect(failed?.error).toContain('boom');
  });

  it('kind=fundamentals refreshes all three statement types per ticker', async () => {
    const financialsSvc = {
      refresh: vi.fn().mockResolvedValue({
        ticker: '', statementType: 'income', periodType: 'annual', rows: []
      })
    };
    const out = await runRefresh({
      db: dbH.db,
      kind: 'fundamentals',
      snapshotSvc: { refresh: vi.fn() } as any,
      financialsSvc: financialsSvc as any,
      pricesSvc: { refresh: vi.fn() } as any
    });
    expect(financialsSvc.refresh).toHaveBeenCalledTimes(6); // 2 tickers x 3 statement types
    expect(out.attempted).toBe(6);
  });

  it('kind=prices refreshes 1Y per ticker', async () => {
    const pricesSvc = { refresh: vi.fn().mockResolvedValue([]) };
    const out = await runRefresh({
      db: dbH.db,
      kind: 'prices',
      snapshotSvc: { refresh: vi.fn() } as any,
      financialsSvc: { refresh: vi.fn() } as any,
      pricesSvc: pricesSvc as any
    });
    expect(pricesSvc.refresh).toHaveBeenCalledTimes(2);
    expect(pricesSvc.refresh).toHaveBeenCalledWith(expect.any(String), '1Y');
  });
});
