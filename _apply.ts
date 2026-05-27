import { config } from 'dotenv';
config({ path: '.env.local' });
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

const targetArg = process.argv.indexOf('--target');
const fileArg = process.argv.indexOf('--file');
const target = targetArg >= 0 ? process.argv[targetArg + 1] : null;
const file = fileArg >= 0 ? process.argv[fileArg + 1] : null;
if (!target || !file) {
  console.error('Usage: tsx _apply.ts --target prod|test --file <path>');
  process.exit(2);
}

const url = target === 'prod'
  ? process.env.DATABASE_URL_SERVICE_ROLE
  : process.env.DATABASE_URL_TEST_SERVICE_ROLE;
if (!url) { console.error(`URL for ${target} not set`); process.exit(2); }

const sqlText = readFileSync(file, 'utf8');
const sql = postgres(url, { prepare: false, max: 1 });
try {
  await sql.unsafe(sqlText);
  console.log(`Applied ${file} to ${target} OK`);
} catch (e) {
  console.error('Apply failed:', e);
  process.exit(1);
} finally {
  await sql.end();
}
