import { describe, it, expect } from 'vitest';
import {
  matchSmartMoney,
  normalizeInvestorName,
  SMART_MONEY,
  INDEX_GIANTS,
  getReverseLookupCiks
} from '@/lib/compute/smart-money';

describe('normalizeInvestorName', () => {
  it('uppercases, collapses whitespace, strips common suffixes', () => {
    expect(normalizeInvestorName('Berkshire   Hathaway  Inc.')).toBe('BERKSHIRE HATHAWAY');
    expect(normalizeInvestorName('Tiger Global Management, LLC')).toBe('TIGER GLOBAL MANAGEMENT');
    expect(normalizeInvestorName('Renaissance Technologies LLC')).toBe('RENAISSANCE TECHNOLOGIES');
  });
  it('handles ampersands + abbreviations', () => {
    expect(normalizeInvestorName('D. E. Shaw & Co., L.P.')).toBe('D E SHAW');
    expect(normalizeInvestorName('AQR Capital Management LLC')).toBe('AQR CAPITAL MANAGEMENT');
  });
});

describe('matchSmartMoney', () => {
  it('matches by CIK with leading-zero padding', () => {
    const match = matchSmartMoney('0001067983', 'whatever name');
    expect(match).not.toBeNull();
    expect(match!.name).toBe('Berkshire Hathaway');
  });
  it('matches by canonical name when CIK is missing or unknown', () => {
    const match = matchSmartMoney('NOT-A-CIK-12345', 'TIGER GLOBAL MANAGEMENT LLC');
    expect(match).not.toBeNull();
    expect(match!.name).toBe('Tiger Global Management');
    expect(match!.category).toBe('growth');
  });
  it('returns null for non-smart-money funds', () => {
    expect(matchSmartMoney('0000000000', 'VANGUARD GROUP INC')).toBeNull();
    expect(matchSmartMoney('NO-MATCH', 'BLACKROCK INSTITUTIONAL TRUST')).toBeNull();
  });
  it('list includes all 5 categories', () => {
    const cats = new Set(SMART_MONEY.map((e) => e.category));
    expect(cats).toContain('value');
    expect(cats).toContain('macro');
    expect(cats).toContain('quant');
    expect(cats).toContain('growth');
    expect(cats).toContain('activist');
  });
});

describe('INDEX_GIANTS + getReverseLookupCiks', () => {
  it('INDEX_GIANTS has 15 entries spanning the major index houses', () => {
    expect(INDEX_GIANTS).toHaveLength(15);
    const names = INDEX_GIANTS.map((g) => g.name);
    expect(names).toContain('Vanguard Group');
    expect(names).toContain('BlackRock');
    expect(names).toContain('State Street');
  });

  it('getReverseLookupCiks returns 45 unique CIKs (30 SMART_MONEY + 15 INDEX_GIANTS)', () => {
    const ciks = getReverseLookupCiks();
    expect(ciks.length).toBe(SMART_MONEY.length + INDEX_GIANTS.length);
    expect(new Set(ciks).size).toBe(ciks.length);     // all unique
  });

  it('getReverseLookupCiks: every cik is 10-digit zero-padded', () => {
    for (const c of getReverseLookupCiks()) {
      expect(c).toMatch(/^\d{10}$/);
    }
  });
});
