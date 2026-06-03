import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { MacroService } from '@/lib/services/macro';
import type { FredProvider } from '@/lib/providers/fred';
import type { YFinanceProvider } from '@/lib/providers/yfinance';

config({ path: '.env.local' });

const fakeFred = { fetchSeries: async () => [{ date: '2026-06-01', value: 1 }] } as unknown as FredProvider;
const fakeYf = { prices: async () => [{ date: '2026-06-01', open: null, high: null, low: null, close: 10, adjClose: null, volume: null }] } as unknown as YFinanceProvider;

describe('macro board shape', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => { await dbH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`); });

  it('produces weather + 6 groups + 13 tiles', async () => {
    const svc = new MacroService({ db: dbH.db, fred: fakeFred, yf: fakeYf, fredDelayMs: 0 });
    await svc.refreshAll('daily');
    const board = await svc.getBoard();
    expect(board.weather.label).toBeTypeOf('string');
    expect(board.groups).toHaveLength(6);
    expect(board.groups.flatMap((g) => g.tiles)).toHaveLength(13);
  });
});
