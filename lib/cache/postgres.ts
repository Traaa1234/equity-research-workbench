import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type {
  NewSnapshot,
  NewFundamental,
  NewPrice,
  NewEarning
} from '@/lib/db/types';

type CacheableTable = 'snapshots' | 'fundamentals' | 'prices' | 'earnings';

const FRESH_COLUMN: Record<CacheableTable, string> = {
  snapshots: 'fetched_at',
  fundamentals: 'fetched_at',
  prices: 'date',
  earnings: 'fetched_at'
};

/**
 * Returns true iff at least one row exists for `ticker` in `table` with the
 * freshness column more recent than `now() - ttlSeconds`.
 *
 * For `prices`, the freshness column is a `date` (not timestamp); we treat a
 * row as "fresh until end-of-day" by adding one day to it.
 */
export async function isFresh(
  db: ServiceDb,
  table: CacheableTable,
  ticker: string,
  ttlSeconds: number
): Promise<boolean> {
  const col = FRESH_COLUMN[table];
  const freshExpr =
    table === 'prices'
      ? sql`(${sql.identifier(col)}::timestamp + interval '1 day')`
      : sql`${sql.identifier(col)}`;
  const result = await db.execute(
    sql`select 1 from ${sql.identifier(table)}
        where ticker = ${ticker}
        and ${freshExpr} > now() - (${String(ttlSeconds)} || ' seconds')::interval
        limit 1`
  );
  // postgres-js execute returns an array-like result; check length.
  return Array.isArray(result) ? result.length > 0 : (result as any).rows?.length > 0;
}

/**
 * Upsert a snapshot row by ticker primary key. Returns nothing — caller
 * already has the data and just wants persistence.
 */
export async function upsertSnapshot(db: ServiceDb, row: NewSnapshot): Promise<void> {
  await db
    .insert(schema.snapshots)
    .values(row)
    .onConflictDoUpdate({
      target: schema.snapshots.ticker,
      set: {
        price: row.price,
        marketCap: row.marketCap,
        week52High: row.week52High,
        week52Low: row.week52Low,
        pe: row.pe,
        ps: row.ps,
        pb: row.pb,
        evEbitda: row.evEbitda,
        peg: row.peg,
        asOf: row.asOf,
        fetchedAt: sql`now()`,
        source: row.source
      }
    });
}

export async function upsertFundamentals(
  db: ServiceDb,
  rows: NewFundamental[]
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(schema.fundamentals)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        schema.fundamentals.ticker,
        schema.fundamentals.periodEnd,
        schema.fundamentals.periodType,
        schema.fundamentals.statementType,
        schema.fundamentals.lineItem
      ],
      set: {
        value: sql`excluded.value`,
        currency: sql`excluded.currency`,
        fetchedAt: sql`now()`,
        source: sql`excluded.source`
      }
    });
}

export async function upsertPrices(db: ServiceDb, rows: NewPrice[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(schema.prices)
    .values(rows)
    .onConflictDoUpdate({
      target: [schema.prices.ticker, schema.prices.date],
      set: {
        open: sql`excluded.open`,
        high: sql`excluded.high`,
        low: sql`excluded.low`,
        close: sql`excluded.close`,
        adjClose: sql`excluded.adj_close`,
        volume: sql`excluded.volume`,
        source: sql`excluded.source`
      }
    });
}

export async function upsertEarnings(db: ServiceDb, rows: NewEarning[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(schema.earnings)
    .values(rows)
    .onConflictDoUpdate({
      target: [schema.earnings.ticker, schema.earnings.periodEnd],
      set: {
        reportedDate: sql`excluded.reported_date`,
        epsActual: sql`excluded.eps_actual`,
        price1dPct: sql`excluded.price_1d_pct`,
        price5dPct: sql`excluded.price_5d_pct`,
        source: sql`excluded.source`,
        fetchedAt: sql`now()`
      }
    });
}
