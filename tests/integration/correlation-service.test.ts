import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { macroSeries } from '@/lib/db/schema';
import { CorrelationService } from '@/lib/services/correlation';
import { corrSeriesIds } from '@/lib/compute/correlation-registry';

config({ path: '.env.local' });

describe('CorrelationService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => { await dbH.db.execute(sql`TRUNCATE TABLE macro_series, macro_freshness RESTART IDENTITY CASCADE`); });

  it('returns 7 assets, 3 windows, a symmetric matrix with diagonal 1', async () => {
    // Seed 15 overlapping daily rows for all 7 ids. The `(d % 4)` term gives every
    // series a NON-CONSTANT daily change (non-zero variance) — including the `diff`
    // assets — so no correlation cell is null from zero variance.
    const ids = corrSeriesIds();
    const rows: { seriesId: string; obsDate: string; value: string; source: string }[] = [];
    for (let d = 1; d <= 15; d++) {
      const date = `2026-01-${String(d).padStart(2, '0')}`;
      ids.forEach((id, k) => rows.push({ seriesId: id, obsDate: date, value: String(100 + (k + 1) * d + (d % 4)), source: 'fred' }));
    }
    await dbH.db.insert(macroSeries).values(rows);

    const out = await new CorrelationService({ db: dbH.db }).getMatrices();
    expect(out.assets).toHaveLength(7);
    expect(Object.keys(out.windows)).toEqual(['30', '60', '90']);
    const m = out.windows['60'];
    expect(m).toHaveLength(7);
    expect(m[0]![0]).toBe(1);
    expect(m[0]![1]).toBeCloseTo(m[1]![0]!);
    expect(out.asOf).toBe('2026-01-15');
  });
});
