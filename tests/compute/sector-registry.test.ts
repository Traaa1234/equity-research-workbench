import { describe, it, expect } from 'vitest';
import { SECTOR_REGISTRY, sectorSeriesIds, displaySectors } from '@/lib/compute/sector-registry';

describe('sector-registry', () => {
  it('has 12 entries (11 sectors + SPY benchmark)', () => {
    expect(SECTOR_REGISTRY).toHaveLength(12);
  });
  it('sectorSeriesIds() returns all 12 symbols', () => {
    expect(sectorSeriesIds()).toHaveLength(12);
    expect(sectorSeriesIds()).toContain('SPY');
    expect(sectorSeriesIds()).toContain('XLK');
  });
  it('displaySectors() returns exactly 11, no benchmark', () => {
    const display = displaySectors();
    expect(display).toHaveLength(11);
    expect(display.every((s) => !s.isBenchmark)).toBe(true);
    expect(display.some((s) => s.seriesId === 'SPY')).toBe(false);
  });
  it('no duplicate seriesIds', () => {
    const ids = sectorSeriesIds();
    expect(new Set(ids).size).toBe(ids.length);
  });
});
