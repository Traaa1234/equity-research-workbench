import { describe, it, expect, vi } from 'vitest';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { NotFoundError, ProviderError, ValidationError } from '@/lib/providers/types';

/**
 * The adapter is tested by mocking child_process.spawn.
 * We don't run real Python in unit tests.
 */
function makeProvider(spawnImpl: any) {
  return new YFinanceProvider({
    pythonBin: 'python',
    scriptPath: '/fake/yfinance_fetch.py',
    spawn: spawnImpl
  });
}

function fakeSpawn(stdout: string, exitCode: number) {
  return () => {
    const listeners: Record<string, ((arg?: any) => void)[]> = { close: [], error: [] };
    const proc = {
      stdout: {
        on: (ev: string, cb: (data: Buffer) => void) => {
          if (ev === 'data') cb(Buffer.from(stdout));
        }
      },
      stderr: { on: () => {} },
      on: (ev: string, cb: (arg?: any) => void) => {
        if (!listeners[ev]) listeners[ev] = [];
        listeners[ev]!.push(cb);
      }
    };
    setTimeout(() => listeners.close?.forEach((cb) => cb(exitCode)), 0);
    return proc;
  };
}

describe('YFinanceProvider', () => {
  it('parses company JSON from stdout', async () => {
    const stdout = JSON.stringify({
      ticker: 'AAPL',
      name: 'Apple Inc.',
      cik: null,
      exchange: 'NMS',
      sector: 'Technology',
      industry: 'Consumer Electronics'
    });
    const provider = makeProvider(fakeSpawn(stdout, 0));

    const result = await provider.company('AAPL');
    expect(result.ticker).toBe('AAPL');
    expect(result.sector).toBe('Technology');
  });

  it('throws NotFoundError when script exits 1 with kind=NotFound', async () => {
    const stdout = JSON.stringify({ error: 'Ticker not found: XXXX', kind: 'NotFound' });
    const provider = makeProvider(fakeSpawn(stdout, 1));

    await expect(provider.company('XXXX')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ProviderError when script exits 1 with kind=Provider', async () => {
    const stdout = JSON.stringify({ error: 'Network error', kind: 'Provider' });
    const provider = makeProvider(fakeSpawn(stdout, 1));

    await expect(provider.company('AAPL')).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws ValidationError when script exits 1 with kind=Validation', async () => {
    const stdout = JSON.stringify({ error: 'Bad kind', kind: 'Validation' });
    const provider = makeProvider(fakeSpawn(stdout, 1));

    await expect(provider.company('AAPL')).rejects.toBeInstanceOf(ValidationError);
  });

  it('returns normalized statements rows for income annual', async () => {
    const stdout = JSON.stringify({
      ticker: 'JD',
      statementType: 'income',
      periodType: 'annual',
      rows: [
        { periodEnd: '2024-12-31', lineItem: 'revenue', value: 154000000000, currency: 'USD' },
        { periodEnd: '2024-12-31', lineItem: 'net_income', value: 5000000000, currency: 'USD' }
      ]
    });
    const provider = makeProvider(fakeSpawn(stdout, 0));

    const bundle = await provider.statements('JD', 'income', 'annual');
    expect(bundle.ticker).toBe('JD');
    expect(bundle.statementType).toBe('income');
    expect(bundle.periodType).toBe('annual');
    expect(bundle.rows).toHaveLength(2);
    expect(bundle.rows[0]!.value).toBe(154000000000);
  });

  it('returns empty rows when yfinance has no data', async () => {
    const stdout = JSON.stringify({
      ticker: 'XYZ',
      statementType: 'balance',
      periodType: 'quarterly',
      rows: []
    });
    const provider = makeProvider(fakeSpawn(stdout, 0));

    const bundle = await provider.statements('XYZ', 'balance', 'quarterly');
    expect(bundle.rows).toEqual([]);
  });

  describe('.info()', () => {
    it('returns info fields mapped from yfinance .info', async () => {
      const spawnImpl = vi.fn(fakeSpawn(
        JSON.stringify({
          longBusinessSummary: 'Apple Inc. designs and sells iPhones.',
          country: 'United States',
          sector: 'Technology',
          industry: 'Consumer Electronics',
          exchange: 'NMS',
          marketCap: 3000000000000,
          longName: 'Apple Inc.'
        }),
        0
      ));
      const provider = makeProvider(spawnImpl);

      const result = await provider.info('AAPL');

      expect(spawnImpl).toHaveBeenCalledOnce();
      const args = spawnImpl.mock.calls[0]![1] as string[];
      expect(args).toContain('AAPL');
      expect(args).toContain('info');
      expect(result.longBusinessSummary).toContain('Apple');
      expect(result.country).toBe('United States');
      expect(result.sector).toBe('Technology');
      expect(result.marketCap).toBe(3000000000000);
    });

    it('returns nulls when the upstream returns null fields', async () => {
      const stdout = JSON.stringify({
        longBusinessSummary: null,
        country: null,
        sector: null,
        industry: null,
        exchange: null,
        marketCap: null,
        longName: null
      });
      const provider = makeProvider(fakeSpawn(stdout, 0));

      const result = await provider.info('DELISTED');
      expect(result.longBusinessSummary).toBeNull();
      expect(result.country).toBeNull();
      expect(result.marketCap).toBeNull();
    });
  });
});
