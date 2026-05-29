import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb, makeTestUserDb, newUserId, resetDb } from '../helpers/test-db';
import { companiesUniverse } from '@/lib/db/schema';

config({ path: '.env.local' });

function vec(): number[] {
  const v = new Array(1024).fill(0);
  v[0] = 1;
  return v;
}

describe('RLS: companies_universe', () => {
  let svc: ReturnType<typeof makeTestServiceDb>;
  let user: ReturnType<typeof makeTestUserDb>;

  beforeAll(() => { svc = makeTestServiceDb(); user = makeTestUserDb(); });
  afterAll(async () => { await svc.close(); await user.close(); });

  beforeEach(async () => {
    await resetDb(svc.db);
    await svc.db.execute(sql`TRUNCATE TABLE companies_universe`);
    await svc.db.insert(companiesUniverse).values({
      ticker: 'AAA', name: 'Alpha', country: 'US', exchange: 'NYSE', sector: 'Tech',
      description: 'a', descriptionEmbedding: vec(), sources: ['nyse']
    });
  });

  it('authenticated role can SELECT companies_universe', async () => {
    const uid = newUserId();
    const count = await user.asUser(uid, async (tx) => {
      const r = await tx.select().from(companiesUniverse);
      return r.length;
    });
    expect(count).toBe(1);
  });

  it('authenticated role cannot INSERT companies_universe', async () => {
    const uid = newUserId();
    await expect(
      user.asUser(uid, async (tx) => {
        await tx.insert(companiesUniverse).values({
          ticker: 'EVIL', name: 'Evil', country: 'XX', exchange: 'NYSE',
          sector: 'Tech', description: 'evil', descriptionEmbedding: vec(), sources: ['nyse']
        });
      })
    ).rejects.toThrow();
  });
});
