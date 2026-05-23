import { describe, it, expect, vi } from 'vitest';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { NotFoundError, ProviderError, RateLimitError } from '@/lib/providers/types';
import { loadFixture } from '../helpers/fixtures';

function makeProvider(fetchImpl: typeof fetch) {
  return new FinancialDatasetsProvider({
    apiKey: 'test-key',
    fetch: fetchImpl,
    // Disable retries in tests by default; specific tests opt in.
    retry: { attempts: 1, baseDelayMs: 0 }
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  });
}

describe('FinancialDatasetsProvider', () => {
  describe('.company()', () => {
    it('returns normalized CompanyData for AAPL', async () => {
      const fix = loadFixture('fd-company-aapl.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProvider(fetchMock);

      const result = await provider.company('AAPL');

      expect(result).toEqual({
        ticker: 'AAPL',
        name: 'Apple Inc.',
        cik: '0000320193',
        exchange: 'NASDAQ',
        sector: 'Technology',
        industry: 'Consumer Electronics'
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('throws NotFoundError on 404', async () => {
      const fix = loadFixture('fd-not-found.json');
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(fix), { status: 404 })
      );
      const provider = makeProvider(fetchMock);

      await expect(provider.company('XXXX')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('throws RateLimitError on 429', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response('', { status: 429 })
      );
      const provider = makeProvider(fetchMock);

      await expect(provider.company('AAPL')).rejects.toBeInstanceOf(RateLimitError);
    });

    it('throws ProviderError on 500', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response('', { status: 500 })
      );
      const provider = makeProvider(fetchMock);

      await expect(provider.company('AAPL')).rejects.toBeInstanceOf(ProviderError);
    });
  });

  describe('.snapshot()', () => {
    it('returns normalized SnapshotData with computed multiples passed through', async () => {
      const fix = loadFixture('fd-snapshot-aapl.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProvider(fetchMock);

      const result = await provider.snapshot('AAPL');

      expect(result.ticker).toBe('AAPL');
      expect(result.price).toBe(195.4);
      expect(result.marketCap).toBe(3100000000000);
      expect(result.pe).toBeCloseTo(28.5);
      expect(result.peg).toBeCloseTo(2.4);
      expect(result.asOf).toBeInstanceOf(Date);
    });

    it('passes ticker through as uppercase', async () => {
      const fix = loadFixture('fd-snapshot-aapl.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProvider(fetchMock);

      await provider.snapshot('aapl');

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('ticker=AAPL');
    });

    it('handles missing as_of by defaulting to now()', async () => {
      const fix = {
        snapshot: {
          ticker: 'AAPL',
          market_cap: 3.1e12,
          latest_price: 195.4,
          // no as_of, no fifty_two_week_high/low — real FD often omits these
        }
      };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProvider(fetchMock);

      const before = Date.now();
      const result = await provider.snapshot('AAPL');
      const after = Date.now();

      expect(result.asOf).toBeInstanceOf(Date);
      expect(result.asOf.getTime()).toBeGreaterThanOrEqual(before);
      expect(result.asOf.getTime()).toBeLessThanOrEqual(after + 100);
      expect(result.week52High).toBeNull();
      expect(result.week52Low).toBeNull();
    });
  });

  describe('.statements()', () => {
    it('returns normalized income statement rows', async () => {
      const fix = loadFixture('fd-income-aapl-annual.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProvider(fetchMock);

      const result = await provider.statements('AAPL', 'income', 'annual');

      expect(result.ticker).toBe('AAPL');
      expect(result.statementType).toBe('income');
      expect(result.periodType).toBe('annual');
      expect(result.rows.length).toBeGreaterThan(0);
      const revenue2024 = result.rows.find(
        (r) => r.lineItem === 'revenue' && r.periodEnd === '2024-09-30'
      );
      expect(revenue2024?.value).toBe(383285000000);
      expect(revenue2024?.currency).toBe('USD');
    });

    it('hits the correct endpoint for balance sheet quarterly', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({ balance_sheets: [] })
      );
      const provider = makeProvider(fetchMock);

      await provider.statements('AAPL', 'balance', 'quarterly');

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('/financials/balance-sheets');
      expect(url).toContain('ticker=AAPL');
      expect(url).toContain('period=quarterly');
    });
  });

  describe('.prices()', () => {
    it('returns normalized daily prices', async () => {
      const fix = loadFixture('fd-prices-aapl-1y.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProvider(fetchMock);

      const result = await provider.prices('AAPL', '1Y');

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        date: '2025-05-23',
        open: 188.0,
        close: 189.4,
        volume: 50000000
      });
    });

    it('requests the right date range for 1Y', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ prices: [] }));
      const provider = makeProvider(fetchMock);

      await provider.prices('AAPL', '1Y');

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('/prices');
      expect(url).toContain('interval=day');
      // Range covers ~365 days.
      const startMatch = url.match(/start_date=(\d{4}-\d{2}-\d{2})/);
      const endMatch = url.match(/end_date=(\d{4}-\d{2}-\d{2})/);
      expect(startMatch).not.toBeNull();
      expect(endMatch).not.toBeNull();
    });
  });

  describe('.earnings()', () => {
    it('returns normalized earnings points', async () => {
      const fix = loadFixture('fd-earnings-aapl.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProvider(fetchMock);

      const result = await provider.earnings('AAPL', 8);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        periodEnd: '2024-12-31',
        reportedDate: '2025-01-30',
        epsActual: 2.4
      });
      // price_1d_pct and price_5d_pct are computed by the service later — provider returns null here.
      expect(result[0]!.price1dPct).toBeNull();
      expect(result[0]!.price5dPct).toBeNull();
    });
  });

  describe('retry behavior', () => {
    it('retries on RateLimitError and succeeds on second attempt', async () => {
      vi.useFakeTimers();
      const fix = loadFixture('fd-company-aapl.json');
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 429 }))
        .mockResolvedValueOnce(jsonResponse(fix));
      const provider = new FinancialDatasetsProvider({
        apiKey: 'k',
        fetch: fetchMock,
        retry: { attempts: 3, baseDelayMs: 100 }
      });

      const promise = provider.company('AAPL');
      // Advance through the backoff
      await vi.advanceTimersByTimeAsync(150);
      const result = await promise;
      expect(result.ticker).toBe('AAPL');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry on NotFoundError', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
      const provider = new FinancialDatasetsProvider({
        apiKey: 'k',
        fetch: fetchMock,
        retry: { attempts: 3, baseDelayMs: 1 }
      });

      await expect(provider.company('XXXX')).rejects.toBeInstanceOf(NotFoundError);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('gives up after configured attempts', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
      const provider = new FinancialDatasetsProvider({
        apiKey: 'k',
        fetch: fetchMock,
        retry: { attempts: 2, baseDelayMs: 10 }
      });

      const promise = provider.company('AAPL').catch((e) => e);
      await vi.advanceTimersByTimeAsync(100);
      const err = await promise;
      expect(err).toBeInstanceOf(ProviderError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
