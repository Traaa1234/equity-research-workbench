import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSkeleton, mergeSources } from '@/scripts/seed-universe';

const NASDAQ_NYSE_FIXTURE = {
  data: {
    table: {
      rows: [
        { symbol: 'AAA', name: 'Alpha Corp', country: 'United States', sector: 'Technology', industry: 'Software', marketCap: '1000000000' },
        { symbol: 'BBB', name: 'Beta Corp', country: 'Brazil', sector: 'Consumer Defensive', industry: 'Beverages', marketCap: '500000000' }
      ]
    }
  }
};

const NASDAQ_NASDAQ_FIXTURE = {
  data: {
    table: {
      rows: [
        { symbol: 'CCC', name: 'Cee Corp', country: 'China', sector: 'Technology', industry: 'Internet', marketCap: '2000000000' },
        { symbol: 'AAA', name: 'Alpha Corp', country: 'United States', sector: 'Technology', industry: 'Software', marketCap: '1000000000' }
      ]
    }
  }
};

const ISHARES_CSV = `Fund,iShares Test ETF
"Ticker","Name","Asset Class","Weight (%)"
"AAA","Alpha Corp","Equity","5.00"
"DDD","Dee Corp","Equity","3.00"
`;

describe('mergeSources', () => {
  it('dedupes by ticker and accumulates sources array', () => {
    const merged = mergeSources([
      { ticker: 'AAA', name: 'Alpha', country: null, sector: null, industry: null, exchange: 'NYSE',   marketCap: null, source: 'nyse' },
      { ticker: 'AAA', name: 'Alpha', country: null, sector: null, industry: null, exchange: 'NYSE',   marketCap: null, source: 'etf:BOTZ' },
      { ticker: 'BBB', name: 'Beta',  country: null, sector: null, industry: null, exchange: 'NASDAQ', marketCap: null, source: 'nasdaq' }
    ]);
    expect(merged.size).toBe(2);
    expect(merged.get('AAA')!.sources).toEqual(['nyse', 'etf:BOTZ']);
    expect(merged.get('BBB')!.sources).toEqual(['nasdaq']);
  });

  it('uses uppercase tickers as keys', () => {
    const merged = mergeSources([
      { ticker: 'aaa', name: 'Alpha', country: null, sector: null, industry: null, exchange: 'NYSE', marketCap: null, source: 'nyse' }
    ]);
    expect(merged.has('AAA')).toBe(true);
    expect(merged.has('aaa')).toBe(false);
  });

  it('preserves first non-null metadata field, ignores later nulls', () => {
    const merged = mergeSources([
      { ticker: 'AAA', name: 'Alpha', country: 'BR', sector: 'Tech',  industry: null, exchange: 'NYSE', marketCap: null, source: 'nyse' },
      { ticker: 'AAA', name: 'Alpha', country: null, sector: null,    industry: null, exchange: null,   marketCap: null, source: 'etf:KWEB' }
    ]);
    const row = merged.get('AAA')!;
    expect(row.country).toBe('BR');
    expect(row.sector).toBe('Tech');
  });
});

describe('buildSkeleton', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('exchange=NYSE')) {
        return Promise.resolve({ ok: true, json: async () => NASDAQ_NYSE_FIXTURE } as any);
      }
      if (url.includes('exchange=NASDAQ')) {
        return Promise.resolve({ ok: true, json: async () => NASDAQ_NASDAQ_FIXTURE } as any);
      }
      if (url.includes('ishares')) {
        return Promise.resolve({ ok: true, text: async () => ISHARES_CSV } as any);
      }
      return Promise.resolve({ ok: false, status: 404 } as any);
    });
  });

  it('merges NYSE + Nasdaq + one ETF and dedupes', async () => {
    const skeleton = await buildSkeleton({
      fetch: fetchMock,
      etfs: [{ id: 'BOTZ', issuer: 'ishares', url: 'https://ishares.com/botz-holdings.csv' }]
    });
    expect(skeleton.size).toBe(4);
    expect(skeleton.get('AAA')!.sources).toEqual(expect.arrayContaining(['nyse', 'nasdaq', 'etf:BOTZ']));
    expect(skeleton.get('BBB')!.sources).toEqual(['nyse']);
    expect(skeleton.get('DDD')!.sources).toEqual(['etf:BOTZ']);
  });

  it('skips ETFs whose fetch fails', async () => {
    const skeleton = await buildSkeleton({
      fetch: fetchMock,
      etfs: [{ id: 'BAD', issuer: 'unknown', url: 'https://nonexistent.example/holdings.csv' }]
    });
    expect(skeleton.has('AAA')).toBe(true);
  });

  it('normalizes country names to ISO codes when possible', async () => {
    const skeleton = await buildSkeleton({ fetch: fetchMock, etfs: [] });
    expect(skeleton.get('BBB')!.country).toBe('BR');
    expect(skeleton.get('CCC')!.country).toBe('CN');
    expect(skeleton.get('AAA')!.country).toBe('US');
  });
});
