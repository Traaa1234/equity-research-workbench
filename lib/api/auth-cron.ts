import { loadServerEnv } from '@/lib/env';

/**
 * Verify that the request carries `Authorization: Bearer ${CRON_SECRET}`.
 * Returns true on exact match, false otherwise. Comparison is XOR-based to
 * reduce timing-leak risk (CRON_SECRET is 64 hex chars so this is fine for
 * the cron-trigger use case; Vercel Cron itself adds the header automatically
 * on deploys).
 */
export function verifyCronAuth(req: Request): boolean {
  const header = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return false;
  const expected = loadServerEnv().CRON_SECRET;
  if (token.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}
