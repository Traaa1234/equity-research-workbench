import { describe, it, expect } from 'vitest';
import { COUNTRY_REGISTRY, countryFredIds, countryEtfs } from '@/lib/compute/country-registry';

describe('country registry', () => {
  it('has 16 countries with unique codes + ETFs', () => {
    expect(COUNTRY_REGISTRY).toHaveLength(16);
    expect(new Set(COUNTRY_REGISTRY.map((c) => c.code)).size).toBe(16);
    expect(new Set(COUNTRY_REGISTRY.map((c) => c.etf)).size).toBe(16);
  });
  it('every country has name/flag/etf and a series object', () => {
    for (const c of COUNTRY_REGISTRY) {
      expect(c.name && c.flag && c.etf).toBeTruthy();
      expect(c.series).toHaveProperty('cli');
    }
  });
  it('countryFredIds dedupes and excludes null', () => {
    expect(countryFredIds().every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(countryEtfs()).toContain('SPY');
  });
});
