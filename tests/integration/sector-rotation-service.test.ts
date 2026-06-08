import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { SectorRotationService } from '@/lib/services/sector-rotation';
import type { YFinanceProvider } from '@/lib/providers/yfinance';

config({ path: '.env.local' });

// 7 price points per symbol — enough to exercise 1D (1) and 1W (5) windows.
function fakePriceSeries(baseClose: number) {
  return Array.from({ length: 7 }, (_, i) => ({
    date: `2026-06-0${i + 1}`,
    open: null, high: null, low: null,
    close: baseClose + i,
    adjClose: null, volume: null,
  }));
}

const fakeYf = {
  pricesBatch: async (symbols: string[]) =>
    Object.fromEntries(
      symbols.map((sym, i) => [sym, fakePriceSeries(100 + i)]),
    ),
} as unknown as YFinanceProvider;

describe('SectorRotationService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await dbH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`);
  });

  it('refreshAll upserts all 12 symbols (11 sectors + SPY)', async () => {
    const svc = new SectorRotationService({ db: dbH.db, yf: fakeYf });
    const r = await svc.refreshAll('daily');
    expect(r.ok).toBe(12);
    expect(r.failed).toBe(0);
  });

  it('getSectors returns 11 display rows with the expected shape', async () => {
    const svc = new SectorRotationService({ db: dbH.db, yf: fakeYf });
    await svc.refreshAll('daily');
    const data = await svc.getSectors();
    expect(data.sectors).toHaveLength(11);
    expect(data.asOf).not.toBeNull();
    // No SPY in display rows
    expect(data.sectors.some((s) => s.seriesId === 'SPY')).toBe(false);
    // 1D return is computable with 7 points
    const first = data.sectors[0]!;
    expect(first.returns['1D']).not.toBeNull();
    expect(first.vsSpy['1D']).not.toBeNull();
    // 1Y (252 offset) is null — only 7 price points
    expect(first.returns['1Y']).toBeNull();
  });

  it('getSectors with no data: 11 rows, null prices, null asOf, stale=false', async () => {
    const svc = new SectorRotationService({ db: dbH.db });
    const data = await svc.getSectors();
    expect(data.sectors).toHaveLength(11);
    expect(data.sectors.every((s) => s.latestPrice === null)).toBe(true);
    expect(data.asOf).toBeNull();
    expect(data.stale).toBe(false);
  });

  it('getSeriesHistory throws for an unknown seriesId', async () => {
    const svc = new SectorRotationService({ db: dbH.db });
    await expect(svc.getSeriesHistory('UNKNOWN', '1y')).rejects.toThrow();
  });

  it('getSeriesHistory returns price history for a valid sector', async () => {
    const svc = new SectorRotationService({ db: dbH.db, yf: fakeYf });
    await svc.refreshAll('daily');
    const detail = await svc.getSeriesHistory('XLK', '1y');
    expect(detail.seriesId).toBe('XLK');
    expect(detail.label).toBe('Technology');
    expect(detail.history.length).toBeGreaterThan(0);
    expect(detail.history[0]).toHaveProperty('date');
    expect(detail.history[0]).toHaveProperty('value');
  });
});
