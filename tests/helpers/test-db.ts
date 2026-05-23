import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from '@/lib/db/schema';

/**
 * Build a fresh service-role Drizzle client for tests. Use this for setup
 * and teardown (truncating tables, seeding companies, etc.) — it bypasses RLS.
 */
export function makeTestServiceDb() {
  const url = process.env.DATABASE_URL_SERVICE_ROLE;
  if (!url) throw new Error('DATABASE_URL_SERVICE_ROLE required for tests');
  const conn = postgres(url, { prepare: false, max: 3 });
  return { db: drizzle(conn, { schema }), close: () => conn.end() };
}

/**
 * Build a user-scoped client for the RLS test path. Each `asUser` call runs
 * inside a transaction with `set local role authenticated` and the JWT claim
 * set to the given user id — matching what `withUserContext` does in app code.
 */
export function makeTestUserDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for tests');
  const conn = postgres(url, { prepare: false, max: 3 });
  const db = drizzle(conn, { schema });

  return {
    async asUser<T>(userId: string, fn: (tx: typeof db) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`set local role authenticated`);
        await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true)`);
        return fn(tx as unknown as typeof db);
      });
    },
    close: () => conn.end()
  };
}

/** Generate a fresh test user uuid. */
export function newUserId(): string {
  return randomUUID();
}

/**
 * Truncate all app tables (uses service-role client). Order is enforced by
 * CASCADE but listed explicitly for clarity.
 */
export async function resetDb(db: ReturnType<typeof makeTestServiceDb>['db']) {
  await db.execute(
    sql`truncate table
      public.refresh_runs,
      public.notes,
      public.watchlist,
      public.earnings,
      public.prices,
      public.fundamentals,
      public.snapshots,
      public.companies
    restart identity cascade`
  );
}
