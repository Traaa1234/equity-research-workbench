// tests/integration/api-sectors.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { SectorRotationService } from '@/lib/services/sector-rotation';
import { NotFoundError } from '@/lib/providers/types';
import type { YFinanceProvider } from '@/lib/providers/yfinance';

config({ path: '.env.local' });

function fakePriceSeries(base: number) {
  return Array.from({ length: 7 }, (_, i) => ({
    date: `2026-06-0${i + 1}`,
    open: null, high: null, low: null,
    close: base + i, adjClose: null, volume: null,
  }));
}

const fakeYf = {
  pricesBatch: async (symbols: string[]) =>
    Object.fromEntries(symbols.map((s, i) => [s, fakePriceSeries(100 + i)])),
} as unknown as YFinanceProvider;

describe('sectors API shape', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await dbH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`);
  });

  it('getSectors returns SectorData with 11 rows', async () => {
    const svc = new SectorRotationService({ db: dbH.db, yf: fakeYf });
    await svc.refreshAll('daily');
    const data = await svc.getSectors();
    expect(data).toHaveProperty('sectors');
    expect(data).toHaveProperty('asOf');
    expect(data).toHaveProperty('stale');
    expect(data.sectors).toHaveLength(11);
  });

  it('getSeriesHistory returns history array for XLK', async () => {
    const svc = new SectorRotationService({ db: dbH.db, yf: fakeYf });
    await svc.refreshAll('daily');
    const detail = await svc.getSeriesHistory('XLK', '1y');
    expect(detail.seriesId).toBe('XLK');
    expect(detail.label).toBe('Technology');
    expect(Array.isArray(detail.history)).toBe(true);
    expect(detail.history.length).toBeGreaterThan(0);
    expect(detail.history[0]).toHaveProperty('date');
    expect(detail.history[0]).toHaveProperty('value');
  });

  it('getSeriesHistory throws NotFoundError for SPY (benchmark, not a display sector)', async () => {
    const svc = new SectorRotationService({ db: dbH.db });
    await expect(svc.getSeriesHistory('SPY', '1y')).rejects.toThrow(NotFoundError);
  });
});
