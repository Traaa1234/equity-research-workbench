import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { YFinanceProvider } from '@/lib/providers/yfinance';

function fakeSpawn(stdout: string) {
  return () => {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setTimeout(() => { proc.stdout.emit('data', Buffer.from(stdout)); proc.emit('close', 0); }, 0);
    return proc;
  };
}

describe('YFinanceProvider.pricesBatch', () => {
  it('parses the {series:{SYM:[...]}} batch shape', async () => {
    const body = JSON.stringify({ series: { EWJ: [{ date: '2026-06-01', open: null, high: null, low: null, close: 70, adjClose: null, volume: null }], EWG: [] } });
    const yf = new YFinanceProvider({ useHttp: false, spawn: fakeSpawn(body) as any });
    const out = await yf.pricesBatch(['EWJ', 'EWG'], '1Y');
    expect(Object.keys(out)).toEqual(['EWJ', 'EWG']);
    expect(out.EWJ![0]!.close).toBe(70);
    expect(out.EWG).toEqual([]);
  });
});
