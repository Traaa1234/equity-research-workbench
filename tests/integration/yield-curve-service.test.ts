import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { YieldCurveService } from '@/lib/services/yield-curve';
import type { FredProvider } from '@/lib/providers/fred';

config({ path: '.env.local' });

const yieldsById: Record<string, number> = { DGS3MO: 4.3, DGS6MO: 4.2, DGS1: 4.0, DGS2: 3.85, DGS5: 3.9, DGS7: 4.0, DGS10: 4.1, DGS20: 4.45, DGS30: 4.5 };
const fakeFred = { fetchSeries: async (id: string) => [{ date: '2025-06-01', value: yieldsById[id]! - 0.1 }, { date: '2026-06-01', value: yieldsById[id]! }] } as unknown as FredProvider;

describe('YieldCurveService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => { await dbH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`); });

  it('refreshAll upserts the 9 maturities', async () => {
    const svc = new YieldCurveService({ db: dbH.db, fred: fakeFred, fredDelayMs: 0 });
    const r = await svc.refreshAll('daily');
    expect(r.ok).toBe(9);
    expect(r.failed).toBe(0);
  });
  it('getCurve returns 9 maturities + 3 spreads + a read', async () => {
    const svc = new YieldCurveService({ db: dbH.db, fred: fakeFred, fredDelayMs: 0 });
    await svc.refreshAll('daily');
    const c = await svc.getCurve();
    expect(c.maturities).toHaveLength(9);
    expect(c.spreads).toHaveLength(3);
    expect(c.read.shape).toBe('PARTIALLY_INVERTED');
    expect(c.maturities.find((m) => m.seriesId === 'DGS10')!.current).toBeCloseTo(4.1);
  });
  it('getMaturityDetail throws for an unknown series', async () => {
    const svc = new YieldCurveService({ db: dbH.db, fred: fakeFred, fredDelayMs: 0 });
    await expect(svc.getMaturityDetail('NOPE')).rejects.toThrow();
  });
});
