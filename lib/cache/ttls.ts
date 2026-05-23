/**
 * Cache TTLs in seconds. Centralized so call sites stay readable
 * and so we can adjust without grepping.
 */
export const TTL = {
  snapshotInMarket: 60 * 60, // 1h
  snapshotOffMarket: 24 * 60 * 60, // 24h
  financialsAnnual: 24 * 60 * 60,
  financialsQuarterly: 24 * 60 * 60,
  prices1Y: 60 * 60,
  prices5Y: 24 * 60 * 60,
  earnings: 24 * 60 * 60,
  watchlist: 5 * 60 // 5m
} as const;

/**
 * US equity market hours (ET): Mon–Fri 9:30–16:00.
 * Returns true when the current time falls in that window (UTC-based check).
 * Used to pick snapshot TTL.
 */
export function isUSMarketOpen(now: Date = new Date()): boolean {
  // ET is UTC-5 (EST) or UTC-4 (EDT). Use simple approximation: convert to ET.
  const utcDay = now.getUTCDay();
  if (utcDay === 0 || utcDay === 6) return false; // Sun/Sat
  // Use Intl to get ET hour/minute reliably across DST.
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short'
  }).formatToParts(now);
  const get = (t: string) => et.find((p) => p.type === t)?.value ?? '';
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const hh = parseInt(get('hour'), 10);
  const mm = parseInt(get('minute'), 10);
  const minutes = hh * 60 + mm;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}
