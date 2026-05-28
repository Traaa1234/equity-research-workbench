import { describe, it, expect } from 'vitest';
import { matchSmartMoney, normalizeInvestorName, SMART_MONEY } from '@/lib/compute/smart-money';

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
