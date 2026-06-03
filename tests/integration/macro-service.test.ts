import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { macroFreshness } from '@/lib/db/schema';
import { MacroService } from '@/lib/services/macro';
import type { FredProvider } from '@/lib/providers/fred';
import type { YFinanceProvider } from '@/lib/providers/yfinance';

config({ path: '.env.local' });

const fakeFred = {
  fetchSeries: async (id: string) => {
    if (id === 'T10Y2Y') return [{ date: '2026-05-29', value: 0.1 }, { date: '2026-06-01', value: -0.5 }]; // inverted
    return [{ date: '2026-06-01', value: 1 }];
  },
} as unknown as FredProvider;
const fakeYf = {
  prices: async () => [{ date: '2026-06-01', open: null, high: null, low: null, close: 15.8, adjClose: null, volume: null }],
} as unknown as YFinanceProvider;

describe('MacroService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await dbH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`);
  });

  it('refreshAll upserts series + freshness for all 13 tiles', async () => {
    const svc = new MacroService({ db: dbH.db, fred: fakeFred, yf: fakeYf });
    const summary = await svc.refreshAll('daily');
    expect(summary.attempted).toBe(13);
    expect(summary.ok).toBe(13);
    const fresh = await dbH.db.select().from(macroFreshness);
    expect(fresh.length).toBe(13);
  });

  it('getBoard returns grouped tiles + a weather verdict', async () => {
    const svc = new MacroService({ db: dbH.db, fred: fakeFred, yf: fakeYf });
    await svc.refreshAll('daily');
    const board = await svc.getBoard();
    expect(board.groups.length).toBe(6);
    const twos = board.groups.flatMap((g) => g.tiles).find((t) => t.seriesId === 'T10Y2Y');
    expect(twos!.badge).toBe('INVERTED');
    expect(twos!.level).toBe(-1);
    expect(['SUNNY', 'FAIR', 'MIXED', 'CLOUDY', 'STORMY']).toContain(board.weather.label);
  });

  it('getSeriesDetail throws for an unknown series', async () => {
    const svc = new MacroService({ db: dbH.db, fred: fakeFred, yf: fakeYf });
    await expect(svc.getSeriesDetail('NOPE', '3y')).rejects.toThrow();
  });
});
