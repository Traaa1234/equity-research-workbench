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
});
