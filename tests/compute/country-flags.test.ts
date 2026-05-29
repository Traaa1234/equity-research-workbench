import { describe, it, expect } from 'vitest';
import { flagFor } from '@/lib/compute/country-flags';

describe('flagFor', () => {
  it('returns flag emoji for known countries', () => {
    expect(flagFor('US')).toBe('🇺🇸');
    expect(flagFor('BR')).toBe('🇧🇷');
    expect(flagFor('CN')).toBe('🇨🇳');
    expect(flagFor('JP')).toBe('🇯🇵');
    expect(flagFor('GB')).toBe('🇬🇧');
    expect(flagFor('DE')).toBe('🇩🇪');
    expect(flagFor('IN')).toBe('🇮🇳');
    expect(flagFor('TW')).toBe('🇹🇼');
  });

  it('returns regional-indicator pair for any valid 2-letter code', () => {
    expect(flagFor('XX')).toBe('🇽🇽'); // valid pair, even if not an assigned country
  });

  it('returns code itself for non-2-letter input, empty string for null/empty', () => {
    expect(flagFor(null)).toBe('');
    expect(flagFor('')).toBe('');
    expect(flagFor('USA')).toBe('USA'); // 3 letters: not a valid pair, returned as-is
    expect(flagFor('us')).toBe('🇺🇸'); // case-insensitive
  });
});
