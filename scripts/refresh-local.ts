#!/usr/bin/env tsx
/**
 * Invoke /api/cron/refresh on a locally-running dev server.
 *
 *   pnpm exec tsx scripts/refresh-local.ts snapshot
 *   pnpm exec tsx scripts/refresh-local.ts fundamentals
 *   pnpm exec tsx scripts/refresh-local.ts prices
 *
 * Reads CRON_SECRET from .env.local. Defaults to http://localhost:3001 (current dev port).
 * Set LOCAL_BASE_URL to override.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

const kind = process.argv[2];
const validKinds = ['snapshot', 'fundamentals', 'prices', 'earnings'];
if (!kind || !validKinds.includes(kind)) {
  console.error(`Usage: pnpm exec tsx scripts/refresh-local.ts <${validKinds.join('|')}>`);
  process.exit(2);
}

const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error('CRON_SECRET not set in .env.local');
  process.exit(2);
}

const base = process.env.LOCAL_BASE_URL ?? 'http://localhost:3001';

(async () => {
  const url = `${base}/api/cron/refresh?kind=${encodeURIComponent(kind)}`;
  console.log(`POSTing ${url}`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${secret}` }
  });
  const body = await res.json().catch(() => ({}));
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(body, null, 2));
  process.exit(res.ok ? 0 : 1);
})();
