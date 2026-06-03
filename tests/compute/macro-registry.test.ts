import { describe, it, expect } from 'vitest';
import { MACRO_REGISTRY, ASSET_CLASS_ORDER } from '@/lib/compute/macro-registry';

describe('macro registry integrity', () => {
  it('has 13 tiles', () => {
    expect(MACRO_REGISTRY).toHaveLength(13);
  });
  it('has exactly 7 voting tiles', () => {
    expect(MACRO_REGISTRY.filter((d) => d.role === 'vote')).toHaveLength(7);
  });
  it('voters are the 7 spec themes', () => {
    const ids = MACRO_REGISTRY.filter((d) => d.role === 'vote').map((d) => d.seriesId).sort();
    expect(ids).toEqual(['BAMLH0A0HYM2', 'CPIAUCSL', 'HG=F', 'NFCI', 'T10Y2Y', 'UNRATE', '^VIX'].sort());
  });
  it('every series id is unique and every asset class is known', () => {
    const ids = new Set(MACRO_REGISTRY.map((d) => d.seriesId));
    expect(ids.size).toBe(13);
    for (const d of MACRO_REGISTRY) expect(ASSET_CLASS_ORDER).toContain(d.assetClass);
  });
});
