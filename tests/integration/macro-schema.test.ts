import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { macroSeries, macroFreshness } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('macro schema', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await dbH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`);
  });

  it('upserts observations idempotently on (series_id, obs_date)', async () => {
    await dbH.db.insert(macroSeries).values({ seriesId: 'T10Y2Y', obsDate: '2026-06-01', value: '0.18', source: 'fred' });
    await dbH.db
      .insert(macroSeries)
      .values({ seriesId: 'T10Y2Y', obsDate: '2026-06-01', value: '0.22', source: 'fred' })
      .onConflictDoUpdate({ target: [macroSeries.seriesId, macroSeries.obsDate], set: { value: '0.22' } });
    const rows = await dbH.db.select().from(macroSeries);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.value)).toBeCloseTo(0.22);
  });

  it('stores a freshness row', async () => {
    await dbH.db.insert(macroFreshness).values({ seriesId: 'T10Y2Y', lastObsDate: '2026-06-01', status: 'ok' });
    const rows = await dbH.db.select().from(macroFreshness);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('ok');
    expect(rows[0]!.lastFetchedAt).toBeInstanceOf(Date);
  });
});
