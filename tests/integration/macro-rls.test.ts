import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb, makeTestUserDb, newUserId } from '../helpers/test-db';
import { macroSeries } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('macro_series RLS', () => {
  let svcH: ReturnType<typeof makeTestServiceDb>;
  let userH: ReturnType<typeof makeTestUserDb>;
  beforeAll(() => { svcH = makeTestServiceDb(); userH = makeTestUserDb(); });
  afterAll(async () => { await svcH.close(); await userH.close(); });
  beforeEach(async () => {
    await svcH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`);
    await svcH.db.insert(macroSeries).values({ seriesId: 'VIX', obsDate: '2026-06-01', value: '15.8', source: 'yfinance' });
  });

  it('authenticated user can SELECT macro_series', async () => {
    const rows = await userH.asUser(newUserId(), async (tx) => tx.select().from(macroSeries));
    expect(rows).toHaveLength(1);
  });

  it('authenticated user cannot INSERT macro_series', async () => {
    let caught: unknown;
    try {
      await userH.asUser(newUserId(), async (tx) =>
        tx.insert(macroSeries).values({ seriesId: 'VIX', obsDate: '2026-06-02', value: '16.0', source: 'yfinance' })
      );
    } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    const msg = (caught as Error).message + String((caught as { cause?: unknown })?.cause ?? '');
    expect(msg).toMatch(/permission denied|policy/i);
  });
});
