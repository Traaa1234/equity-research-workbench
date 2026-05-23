import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, snapshots } from '@/lib/db/schema';
import { SnapshotService } from '@/lib/services/snapshot';
import { RateLimitError, NotFoundError, SnapshotData } from '@/lib/providers/types';

config({ path: '.env.local' });

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK' as const;
    }),
    del: vi.fn(async (k: string) => {
      store.delete(k);
      return 1;
    }),
    _store: store
  };
}

function aaplSnapshot(): SnapshotData {
  return {
    ticker: 'AAPL',
    price: 195.4,
    marketCap: 3.1e12,
    week52High: 220.5,
    week52Low: 165,
    pe: 28.5,
    ps: 7.8,
    pb: 45.2,
    evEbitda: 22.1,
    peg: 2.4,
    asOf: new Date('2026-05-23T20:00:00Z')
  };
}

describe('SnapshotService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => {
    dbH = makeTestServiceDb();
  });
  afterAll(async () => {
    await dbH.close();
  });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
  });

  it('refresh: writes to Redis and Postgres, returns data', async () => {
    const fd = {
      name: 'financial_datasets',
      snapshot: vi.fn().mockResolvedValue(aaplSnapshot())
    };
    const yf = { name: 'yfinance', snapshot: vi.fn() };
    const redis = fakeRedis();
    const svc = new SnapshotService({
      db: dbH.db,
      primary: fd as any,
      fallback: yf as any,
      redis: redis as any
    });

    const result = await svc.refresh('AAPL');
    expect(result.ticker).toBe('AAPL');
    expect(fd.snapshot).toHaveBeenCalled();
    expect(yf.snapshot).not.toHaveBeenCalled();

    const rows = await dbH.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.ticker, 'AAPL'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('financial_datasets');
    expect(redis._store.has('ticker:snapshot:AAPL')).toBe(true);
  });

  it('refresh: falls back to yfinance on RateLimitError', async () => {
    const fd = {
      name: 'financial_datasets',
      snapshot: vi.fn().mockRejectedValue(new RateLimitError('429'))
    };
    const yf = {
      name: 'yfinance',
      snapshot: vi.fn().mockResolvedValue(aaplSnapshot())
    };
    const redis = fakeRedis();
    const svc = new SnapshotService({
      db: dbH.db,
      primary: fd as any,
      fallback: yf as any,
      redis: redis as any
    });

    const result = await svc.refresh('AAPL');
    expect(result.ticker).toBe('AAPL');
    expect(yf.snapshot).toHaveBeenCalled();

    const rows = await dbH.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.ticker, 'AAPL'));
    expect(rows[0]!.source).toBe('yfinance');
  });

  it('refresh: does not fall back on NotFoundError', async () => {
    const fd = {
      name: 'financial_datasets',
      snapshot: vi.fn().mockRejectedValue(new NotFoundError('nope'))
    };
    const yf = { name: 'yfinance', snapshot: vi.fn() };
    const svc = new SnapshotService({
      db: dbH.db,
      primary: fd as any,
      fallback: yf as any,
      redis: fakeRedis() as any
    });

    await expect(svc.refresh('XXXX')).rejects.toBeInstanceOf(NotFoundError);
    expect(yf.snapshot).not.toHaveBeenCalled();
  });

  it('get: returns Redis hit without DB or provider', async () => {
    const fd = { name: 'financial_datasets', snapshot: vi.fn() };
    const redis = fakeRedis();
    redis._store.set(
      'ticker:snapshot:AAPL',
      JSON.stringify({
        ticker: 'AAPL',
        price: 195.4,
        marketCap: 3.1e12,
        week52High: 220.5,
        week52Low: 165,
        pe: 28.5,
        ps: 7.8,
        pb: 45.2,
        evEbitda: 22.1,
        peg: 2.4,
        asOf: '2026-05-23T20:00:00Z'
      })
    );
    const svc = new SnapshotService({
      db: dbH.db,
      primary: fd as any,
      fallback: { name: 'yfinance', snapshot: vi.fn() } as any,
      redis: redis as any
    });

    const result = await svc.get('AAPL');
    expect(result!.ticker).toBe('AAPL');
    expect(fd.snapshot).not.toHaveBeenCalled();
  });

  it('get: returns Postgres hit when Redis cold, populates Redis', async () => {
    await dbH.db.insert(snapshots).values({
      ticker: 'AAPL',
      price: '195.40',
      marketCap: '3100000000000',
      week52High: '220.50',
      week52Low: '165.00',
      pe: '28.50',
      ps: '7.80',
      pb: '45.20',
      evEbitda: '22.10',
      peg: '2.40',
      asOf: new Date(),
      source: 'financial_datasets'
    });

    const fd = { name: 'financial_datasets', snapshot: vi.fn() };
    const redis = fakeRedis();
    const svc = new SnapshotService({
      db: dbH.db,
      primary: fd as any,
      fallback: { name: 'yfinance', snapshot: vi.fn() } as any,
      redis: redis as any
    });

    const result = await svc.get('AAPL');
    expect(result!.ticker).toBe('AAPL');
    expect(fd.snapshot).not.toHaveBeenCalled();
    expect(redis._store.has('ticker:snapshot:AAPL')).toBe(true);
  });

  it('get: cache cold + DB stale triggers refresh', async () => {
    // Use a 2-day-old fetched_at so the row is stale under both
    // in-market (1h) and off-market (24h) snapshot TTLs.
    await dbH.db.execute(sql`
      insert into snapshots (ticker, as_of, fetched_at, source)
      values ('AAPL', now() - interval '2 days', now() - interval '2 days', 'financial_datasets')
    `);

    const fd = {
      name: 'financial_datasets',
      snapshot: vi.fn().mockResolvedValue(aaplSnapshot())
    };
    const svc = new SnapshotService({
      db: dbH.db,
      primary: fd as any,
      fallback: { name: 'yfinance', snapshot: vi.fn() } as any,
      redis: fakeRedis() as any
    });

    const result = await svc.get('AAPL');
    expect(result!.ticker).toBe('AAPL');
    expect(fd.snapshot).toHaveBeenCalled();
  });
});
