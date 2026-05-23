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
  });
});
