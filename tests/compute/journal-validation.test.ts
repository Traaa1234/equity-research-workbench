import { describe, it, expect } from 'vitest';
import {
  validateNewPosition,
  validateNewEntry,
  type NewPositionInput,
  type NewEntryInput
} from '@/lib/compute/journal-validation';

describe('validateNewPosition', () => {
  const valid: NewPositionInput = { ticker: 'AAPL', openedAt: '2024-01-15' };

  it('accepts minimal valid input', () => {
    expect(() => validateNewPosition(valid)).not.toThrow();
  });
  it('accepts full valid input', () => {
    expect(() => validateNewPosition({
      ...valid, convictionAtOpen: 8, targetPrice: 250, stopPrice: 180, expectedHoldingDays: 365
    })).not.toThrow();
  });
  it('rejects negative target price', () => {
    expect(() => validateNewPosition({ ...valid, targetPrice: -10 })).toThrow(/target/i);
  });
  it('rejects zero stop price', () => {
    expect(() => validateNewPosition({ ...valid, stopPrice: 0 })).toThrow(/stop/i);
  });
  it('rejects conviction below 1', () => {
    expect(() => validateNewPosition({ ...valid, convictionAtOpen: 0 })).toThrow(/conviction/i);
  });
  it('rejects conviction above 10', () => {
    expect(() => validateNewPosition({ ...valid, convictionAtOpen: 11 })).toThrow(/conviction/i);
  });
  it('rejects malformed ticker', () => {
    expect(() => validateNewPosition({ ...valid, ticker: 'lower-case' })).toThrow(/ticker/i);
  });
  it('rejects future opened_at', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(() => validateNewPosition({ ...valid, openedAt: future })).toThrow(/opened/i);
  });
});

describe('validateNewEntry', () => {
  const valid: NewEntryInput = { kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'x' };

  it('accepts minimal valid input', () => {
    expect(() => validateNewEntry(valid)).not.toThrow();
  });
  it('accepts exit with outcome+lessons', () => {
    expect(() => validateNewEntry({ ...valid, kind: 'exit', outcome: 'right', lessons: 'l' })).not.toThrow();
  });
  it('rejects invalid kind', () => {
    expect(() => validateNewEntry({ ...valid, kind: 'invalid' as any })).toThrow(/kind/i);
  });
  it('rejects invalid outcome', () => {
    expect(() => validateNewEntry({ ...valid, kind: 'exit', outcome: 'maybe' as any })).toThrow(/outcome/i);
  });
  it('rejects conviction out of range', () => {
    expect(() => validateNewEntry({ ...valid, convictionAtTime: 0 })).toThrow(/conviction/i);
    expect(() => validateNewEntry({ ...valid, convictionAtTime: 11 })).toThrow(/conviction/i);
  });
  it('rejects entry > 50KB', () => {
    const huge = 'x'.repeat(50_001);
    expect(() => validateNewEntry({ ...valid, thesisMd: huge })).toThrow(/size|byte/i);
  });
  it('rejects outcome on non-exit kind', () => {
    expect(() => validateNewEntry({ ...valid, kind: 'entry', outcome: 'right' })).toThrow(/outcome/i);
  });
});
