import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { loadServerEnv } from '@/lib/env';
import * as schema from './schema';

/**
 * Service-role Drizzle client. Bypasses RLS via the service_role Postgres
 * role's BYPASSRLS attribute. Use in cron jobs, ingestion, and tests.
 */
let serviceClient: ReturnType<typeof makeServiceClient> | null = null;

function makeServiceClient() {
  const env = loadServerEnv();
  const conn = postgres(env.DATABASE_URL_SERVICE_ROLE, { prepare: false, max: 5 });
  return drizzle(conn, { schema });
}

export function getServiceDb() {
  if (!serviceClient) serviceClient = makeServiceClient();
  return serviceClient;
}

export type ServiceDb = ReturnType<typeof getServiceDb>;

/**
 * User-scoped Drizzle client. Subject to RLS. Connection uses the OWNER
 * Postgres role (via DATABASE_URL) but each `withUserContext` transaction
 * does `set local role authenticated` so RLS policies apply, and sets
 * `request.jwt.claim.sub` to the Stack Auth user id so `current_user_id()`
 * resolves correctly.
 */
let authClient: ReturnType<typeof makeAuthClient> | null = null;

function makeAuthClient() {
  const env = loadServerEnv();
  const conn = postgres(env.DATABASE_URL, { prepare: false, max: 5 });
  return drizzle(conn, { schema });
}

function getAuthDb() {
  if (!authClient) authClient = makeAuthClient();
  return authClient;
}

/**
 * Run a function against the user-scoped DB with:
 *   - the Postgres role set to `authenticated` (so RLS policies evaluate),
 *   - `request.jwt.claim.sub` set to `userId` (so current_user_id() resolves).
 *
 * Always use this from server routes that handle authenticated requests.
 */
export async function withUserContext<T>(
  userId: string,
  fn: (db: ReturnType<typeof getAuthDb>) => Promise<T>
): Promise<T> {
  const db = getAuthDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role authenticated`);
    await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true)`);
    return fn(tx as unknown as ReturnType<typeof getAuthDb>);
  });
}
