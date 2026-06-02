import { config } from 'dotenv';
// Load .env.local but do NOT override env vars already set in the process.
// This lets callers do: DATABASE_URL=$DATABASE_URL_TEST_SERVICE_ROLE pnpm db:migrate
config({ path: '.env.local', override: false });

import postgres from 'postgres';
import { readdir, readFile } from 'fs/promises';
import path from 'path';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL is required for migrations.\n' +
      'For test branch:  DATABASE_URL=$DATABASE_URL_TEST_SERVICE_ROLE pnpm db:migrate\n' +
      'For prod branch:  DATABASE_URL=$DATABASE_URL_SERVICE_ROLE pnpm db:migrate'
  );
}

const conn = postgres(url, { prepare: false, max: 1 });
console.log('Running migrations against:', url.replace(/:[^:@]*@/, ':***@'));

// Ensure migration tracking table exists
await conn.unsafe(`
  CREATE TABLE IF NOT EXISTS public.__drizzle_migrations (
    id serial PRIMARY KEY,
    hash text NOT NULL UNIQUE,
    created_at bigint
  )
`);

const migrationsDir = path.join(process.cwd(), 'lib/db/migrations');
const allFiles = await readdir(migrationsDir);
const sqlFiles = allFiles
  .filter((f) => f.endsWith('.sql') && !f.startsWith('9'))
  .sort();

let applied = 0;
for (const file of sqlFiles) {
  const hash = file.replace('.sql', '');
  const existing = await conn<{ hash: string }[]>`
    SELECT hash FROM public.__drizzle_migrations WHERE hash = ${hash}
  `;
  if (existing.length > 0) {
    console.log(`  skip  ${file} (already applied)`);
    continue;
  }

  const sqlContent = await readFile(path.join(migrationsDir, file), 'utf8');
  const statements = sqlContent
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`  apply ${file} (${statements.length} statements)`);
  for (const stmt of statements) {
    await conn.unsafe(stmt);
  }

  await conn`
    INSERT INTO public.__drizzle_migrations (hash, created_at)
    VALUES (${hash}, ${Date.now()})
  `;
  applied++;
}

console.log(`\nDone. Applied ${applied} new migration(s).`);
await conn.end();
