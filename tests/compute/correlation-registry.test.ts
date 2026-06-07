import { describe, it, expect } from 'vitest';
import { CORR_ASSETS, corrSeriesIds } from '@/lib/compute/correlation-registry';

describe('correlation registry', () => {
  it('has 7 assets with unique ids + valid transforms', () => {
    expect(CORR_ASSETS).toHaveLength(7);
    expect(new Set(corrSeriesIds()).size).toBe(7);
    for (const a of CORR_ASSETS) { expect(a.label).toBeTruthy(); expect(['return', 'diff']).toContain(a.transform); }
  });
  it('prices use return, levels use diff', () => {
    const byId = Object.fromEntries(CORR_ASSETS.map((a) => [a.seriesId, a.transform]));
    expect(byId['SPY']).toBe('return');
    expect(byId['GC=F']).toBe('return');
    expect(byId['CL=F']).toBe('return');
    expect(byId['DGS10']).toBe('diff');
    expect(byId['^VIX']).toBe('diff');
    expect(byId['BAMLH0A0HYM2']).toBe('diff');
  });
});
