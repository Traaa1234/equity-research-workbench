import { config } from 'dotenv';
config({ path: '.env.local' });
import postgres from 'postgres';

for (const [label, url] of [
  ['prod', process.env.DATABASE_URL_SERVICE_ROLE!],
  ['test', process.env.DATABASE_URL_TEST_SERVICE_ROLE!]
] as const) {
  const sql = postgres(url, { prepare: false, max: 1 });
  const cols = await sql`
    SELECT column_name, data_type, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'filing_chunks'
     ORDER BY ordinal_position`;
  console.log(`\n${label.toUpperCase()} filing_chunks columns:`);
  for (const c of cols) console.log(`  ${c.column_name}: ${c.data_type} (default: ${c.column_default ?? '—'})`);
  await sql.end();
}
