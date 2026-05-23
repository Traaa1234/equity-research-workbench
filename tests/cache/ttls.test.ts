import { describe, it, expect } from 'vitest';
import { TTL, isUSMarketOpen } from '@/lib/cache/ttls';

describe('TTL constants', () => {
  it('has all expected keys', () => {
    expect(Object.keys(TTL).sort()).toEqual(
      [
        'earnings',
        'financialsAnnual',
        'financialsQuarterly',
        'prices1Y',
        'prices5Y',
        'snapshotInMarket',
        'snapshotOffMarket',
        'watchlist'
      ].sort()
    );
  });

  it('snapshot off-market is longer than in-market', () => {
    expect(TTL.snapshotOffMarket).toBeGreaterThan(TTL.snapshotInMarket);
  });
});

describe('isUSMarketOpen', () => {
  it('returns false on a Saturday', () => {
    // 2026-05-23 is a Saturday.
    expect(isUSMarketOpen(new Date('2026-05-23T14:00:00Z'))).toBe(false);
  });

  it('returns false on a Sunday', () => {
    // 2026-05-24 is a Sunday.
    expect(isUSMarketOpen(new Date('2026-05-24T14:00:00Z'))).toBe(false);
  });

  it('returns true at 14:00 ET on a Wednesday in summer (EDT, UTC-4)', () => {
    // 2026-07-15 is a Wednesday. 14:00 EDT = 18:00 UTC.
    expect(isUSMarketOpen(new Date('2026-07-15T18:00:00Z'))).toBe(true);
  });

  it('returns false at 8:00 ET on a Wednesday (pre-market)', () => {
    // 2026-07-15 8:00 EDT = 12:00 UTC.
    expect(isUSMarketOpen(new Date('2026-07-15T12:00:00Z'))).toBe(false);
  });

  it('returns false at 17:00 ET on a Wednesday (post-market)', () => {
    // 2026-07-15 17:00 EDT = 21:00 UTC.
    expect(isUSMarketOpen(new Date('2026-07-15T21:00:00Z'))).toBe(false);
  });

  it('returns true at 14:00 ET on a Wednesday in winter (EST, UTC-5)', () => {
    // 2026-01-14 is a Wednesday. 14:00 EST = 19:00 UTC.
    expect(isUSMarketOpen(new Date('2026-01-14T19:00:00Z'))).toBe(true);
  });
});
