import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, snapshots } from '@/lib/db/schema';
import { isFresh, upsertSnapshot } from '@/lib/cache/postgres';

config({ path: '.env.local' });

describe('cache/postgres', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => {
    dbH = makeTestServiceDb();
  });

  afterAll(async () => {
    await dbH.close();
  });

  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
  });

  it('upsertSnapshot inserts then updates by primary key', async () => {
    await upsertSnapshot(dbH.db, {
      ticker: 'AAPL',
      price: '195.40',
      marketCap: '3100000000000',
      week52High: '220.50',
      week52Low: '165.00',
      pe: '28.50',
      ps: '7.80',
      pb: '45.20',
      evEbitda: '22.10',
      peg: '2.40',
      asOf: new Date(),
      source: 'financial_datasets'
    });

    await upsertSnapshot(dbH.db, {
      ticker: 'AAPL',
      price: '200.00',
      marketCap: '3100000000000',
      week52High: '220.50',
      week52Low: '165.00',
      pe: '29.00',
      ps: '7.80',
      pb: '45.20',
      evEbitda: '22.10',
      peg: '2.40',
      asOf: new Date(),
      source: 'financial_datasets'
    });

    const rows = await dbH.db.select().from(snapshots);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.price).toBe('200.0000');
    expect(rows[0]!.pe).toBe('29.0000');
  });

  it('isFresh returns true when row written within TTL', async () => {
    await upsertSnapshot(dbH.db, {
      ticker: 'AAPL',
      price: null,
      marketCap: null,
      week52High: null,
      week52Low: null,
      pe: null,
      ps: null,
      pb: null,
      evEbitda: null,
      peg: null,
      asOf: new Date(),
      source: 'financial_datasets'
    });

    const fresh = await isFresh(dbH.db, 'snapshots', 'AAPL', 3600);
    expect(fresh).toBe(true);
  });

  it('isFresh returns false when row older than TTL', async () => {
    // Use service-role to insert a backdated row.
    await dbH.db.execute(sql`
      insert into snapshots (ticker, as_of, fetched_at, source)
      values ('AAPL', now() - interval '2 hours', now() - interval '2 hours', 'financial_datasets')
    `);

    const fresh = await isFresh(dbH.db, 'snapshots', 'AAPL', 3600);
    expect(fresh).toBe(false);
  });

  it('isFresh returns false when row missing', async () => {
    const fresh = await isFresh(dbH.db, 'snapshots', 'AAPL', 3600);
    expect(fresh).toBe(false);
  });
});
