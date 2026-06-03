import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { CountryScorecardService } from '@/lib/services/country-scorecard';
import { countryEtfs } from '@/lib/compute/country-registry';
import type { FredProvider } from '@/lib/providers/fred';
import type { YFinanceProvider } from '@/lib/providers/yfinance';

config({ path: '.env.local' });

const fakeFred = { fetchSeries: async (id: string) => [{ date: '2026-01-01', value: id.startsWith('USA') ? 102 : 99 }, { date: '2026-07-01', value: id.startsWith('USA') ? 104 : 98 }] } as unknown as FredProvider;
const fakeYf = {
  pricesBatch: async () => Object.fromEntries(
    countryEtfs().map((s, i) => [
      s,
      [
        { date: '2026-01-01', open: null, high: null, low: null, close: 100, adjClose: null, volume: null },
        { date: '2026-07-01', open: null, high: null, low: null, close: 100 + i, adjClose: null, volume: null },
      ],
    ])
  ),
} as unknown as YFinanceProvider;

describe('CountryScorecardService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => { await dbH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`); });

  it('refreshAll upserts country series + ETFs', async () => {
    const svc = new CountryScorecardService({ db: dbH.db, fred: fakeFred, yf: fakeYf, fredDelayMs: 0 });
    const r = await svc.refreshAll('daily');
    expect(r.fredFailed).toBe(0);
    expect(r.etfOk).toBe(16);
  });
  it('getScorecard returns 16 ranked rows', async () => {
    const svc = new CountryScorecardService({ db: dbH.db, fred: fakeFred, yf: fakeYf, fredDelayMs: 0 });
    await svc.refreshAll('daily');
    const board = await svc.getScorecard();
    expect(board.countries).toHaveLength(16);
    expect(board.countries[0]!.rank).toBe(1);
    expect(board.countries.every((c) => c.composite >= 0 && c.composite <= 100)).toBe(true);
  });
  it('getCountryDetail throws for unknown code', async () => {
    const svc = new CountryScorecardService({ db: dbH.db, fred: fakeFred, yf: fakeYf, fredDelayMs: 0 });
    await expect(svc.getCountryDetail('ZZ')).rejects.toThrow();
  });
});
