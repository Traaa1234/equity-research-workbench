import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, prices as pricesTable } from '@/lib/db/schema';
import { PricesService } from '@/lib/services/prices';
import { RateLimitError, NotFoundError } from '@/lib/providers/types';

config({ path: '.env.local' });

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK' as const; }),
    del: vi.fn(async () => 1),
    _store: store
  };
}

const aaplPrices = [
  { date: '2025-05-23', open: 188, high: 190.5, low: 187.2, close: 189.4, adjClose: 189.4, volume: 50000000 },
  { date: '2025-05-26', open: 189.4, high: 191, low: 188.8, close: 190.6, adjClose: 190.6, volume: 48000000 }
];

describe('PricesService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
  });

  it('refresh: persists prices, populates Redis', async () => {
    const fd = {
      name: 'financial_datasets',
      prices: vi.fn().mockResolvedValue(aaplPrices)
    };
    const redis = fakeRedis();
    const svc = new PricesService({ db: dbH.db, primary: fd as any, fallback: { name: 'yfinance', prices: vi.fn() } as any, redis: redis as any });

    const rows = await svc.refresh('AAPL', '1Y');
    expect(rows).toHaveLength(2);

    const dbRows = await dbH.db.select().from(pricesTable).where(eq(pricesTable.ticker, 'AAPL'));
    expect(dbRows).toHaveLength(2);
    expect(redis._store.has('ticker:prices:AAPL:1Y')).toBe(true);
  });

  it('refresh: falls back to yfinance on RateLimitError', async () => {
    const fd = { name: 'financial_datasets', prices: vi.fn().mockRejectedValue(new RateLimitError('429')) };
    const yf = { name: 'yfinance', prices: vi.fn().mockResolvedValue(aaplPrices) };
    const svc = new PricesService({ db: dbH.db, primary: fd as any, fallback: yf as any, redis: fakeRedis() as any });

    const rows = await svc.refresh('AAPL', '1Y');
    expect(rows).toHaveLength(2);
    expect(yf.prices).toHaveBeenCalled();

    const dbRows = await dbH.db.select().from(pricesTable);
    expect(dbRows[0]!.source).toBe('yfinance');
  });

  it('refresh: does not fall back on NotFoundError', async () => {
    const fd = { name: 'financial_datasets', prices: vi.fn().mockRejectedValue(new NotFoundError('nope')) };
    const yf = { name: 'yfinance', prices: vi.fn() };
    const svc = new PricesService({ db: dbH.db, primary: fd as any, fallback: yf as any, redis: fakeRedis() as any });

    await expect(svc.refresh('AAPL', '1Y')).rejects.toBeInstanceOf(NotFoundError);
    expect(yf.prices).not.toHaveBeenCalled();
  });

  it('get: returns cached payload from Redis without provider', async () => {
    const fd = { name: 'financial_datasets', prices: vi.fn() };
    const redis = fakeRedis();
    redis._store.set('ticker:prices:AAPL:1Y', JSON.stringify(aaplPrices));
    const svc = new PricesService({ db: dbH.db, primary: fd as any, fallback: { name: 'yfinance', prices: vi.fn() } as any, redis: redis as any });

    const result = await svc.get('AAPL', '1Y');
    expect(result).toHaveLength(2);
    expect(fd.prices).not.toHaveBeenCalled();
  });
});
