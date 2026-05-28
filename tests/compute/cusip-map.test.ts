import { describe, it, expect } from 'vitest';
import { tickerForCusip, watchlistCusips, CUSIP_BY_TICKER } from '@/lib/compute/cusip-map';

describe('cusip-map', () => {
  it('maps known CUSIPs back to tickers', () => {
    expect(tickerForCusip('037833100')).toBe('AAPL');
    expect(tickerForCusip('67066G104')).toBe('NVDA');
    expect(tickerForCusip('594918104')).toBe('MSFT');
  });

  it('is case-insensitive on lookup (CUSIPs use uppercase letters)', () => {
    expect(tickerForCusip('67066g104')).toBe('NVDA');
    expect(tickerForCusip('02079K305')).toBe('GOOGL');
  });

  it('returns null for unknown CUSIPs', () => {
    expect(tickerForCusip('000000000')).toBeNull();
    expect(tickerForCusip('UNKNOWN12')).toBeNull();
  });

  it('watchlistCusips returns 6 entries', () => {
    expect(watchlistCusips()).toHaveLength(6);
    expect(watchlistCusips()).toContain('037833100');   // AAPL
  });

  it('CUSIP_BY_TICKER has the expected 6 keys', () => {
    expect(Object.keys(CUSIP_BY_TICKER).sort()).toEqual(
      ['AAPL', 'GOOGL', 'JD', 'MSFT', 'NVDA', 'TSLA']
    );
  });
});
