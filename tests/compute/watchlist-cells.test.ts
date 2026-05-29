import { describe, it, expect } from 'vitest';
import {
  snapshotToCell,
  technicalToCell,
  newsToCell,
  insidersToCell,
  filingsToCell,
  type Cell
} from '@/lib/compute/watchlist-cells';

describe('snapshotToCell', () => {
  it('formats positive change as green with + sign', () => {
    const c = snapshotToCell({ price: 290.45, changePct: 0.0042 });
    expect(c.glyph).toContain('290.45');
    expect(c.glyph).toContain('+0.4%');
    expect(c.color).toBe('green');
  });
  it('formats negative change as red without + sign', () => {
    const c = snapshotToCell({ price: 175.10, changePct: -0.021 });
    expect(c.glyph).toContain('175.10');
    expect(c.glyph).toContain('-2.1%');
    expect(c.color).toBe('red');
  });
  it('formats zero/null change as muted', () => {
    const c = snapshotToCell({ price: 100, changePct: null });
    expect(c.glyph).toBe('$100.00');
    expect(c.color).toBe('muted');
  });
  it('handles null snapshot', () => {
    const c = snapshotToCell(null);
    expect(c.glyph).toBe('—');
    expect(c.color).toBe('muted');
  });
});

describe('technicalToCell', () => {
  it('marks RSI > 70 as overbought (red OB)', () => {
    const c = technicalToCell({ rsi: 72, recentCross: null });
    expect(c.glyph).toBe('OB');
    expect(c.color).toBe('red');
    expect(c.tooltip).toContain('RSI 72');
  });
  it('marks RSI < 30 as oversold (green OS)', () => {
    const c = technicalToCell({ rsi: 25, recentCross: null });
    expect(c.glyph).toBe('OS');
    expect(c.color).toBe('green');
  });
  it('shows GC when most recent signal is golden_cross within 10 days', () => {
    const c = technicalToCell({ rsi: 55, recentCross: 'golden' });
    expect(c.glyph).toBe('GC');
    expect(c.color).toBe('green');
  });
  it('shows DC when most recent signal is death_cross within 10 days', () => {
    const c = technicalToCell({ rsi: 55, recentCross: 'death' });
    expect(c.glyph).toBe('DC');
    expect(c.color).toBe('red');
  });
  it('prioritizes OB over GC (extreme over directional)', () => {
    const c = technicalToCell({ rsi: 75, recentCross: 'golden' });
    expect(c.glyph).toBe('OB');
  });
  it('returns neutral dot when nothing special', () => {
    const c = technicalToCell({ rsi: 55, recentCross: null });
    expect(c.glyph).toBe('●');
    expect(c.color).toBe('muted');
  });
  it('returns em-dash when rsi is null (no data)', () => {
    const c = technicalToCell({ rsi: null, recentCross: null });
    expect(c.glyph).toBe('—');
    expect(c.color).toBe('muted');
  });
});

describe('newsToCell', () => {
  it('counts articles in past 7 days and reports bullish skew', () => {
    const c = newsToCell([
      { publishedAt: new Date(), sentiment: 'bullish' },
      { publishedAt: new Date(), sentiment: 'bullish' },
      { publishedAt: new Date(), sentiment: 'bullish' },
      { publishedAt: new Date(), sentiment: 'neutral' },
      { publishedAt: new Date(), sentiment: 'bearish' }
    ]);
    expect(c.glyph).toBe('+5 art');
    expect(c.color).toBe('green');
    expect(c.tooltip).toContain('3 bullish');
  });
  it('reports red color when net sentiment is bearish', () => {
    const c = newsToCell([
      { publishedAt: new Date(), sentiment: 'bearish' },
      { publishedAt: new Date(), sentiment: 'bearish' },
      { publishedAt: new Date(), sentiment: 'neutral' }
    ]);
    expect(c.glyph).toBe('+3 art');
    expect(c.color).toBe('red');
  });
  it('reports muted when articles are balanced', () => {
    const c = newsToCell([
      { publishedAt: new Date(), sentiment: 'bullish' },
      { publishedAt: new Date(), sentiment: 'bearish' }
    ]);
    expect(c.color).toBe('muted');
  });
  it('excludes articles older than 7 days', () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const c = newsToCell([
      { publishedAt: old, sentiment: 'bullish' },
      { publishedAt: old, sentiment: 'bullish' }
    ]);
    expect(c.glyph).toBe('· quiet');
    expect(c.color).toBe('muted');
  });
  it('reports quiet when empty', () => {
    const c = newsToCell([]);
    expect(c.glyph).toBe('· quiet');
    expect(c.color).toBe('muted');
  });
});

describe('insidersToCell', () => {
  it('marks cluster-buy first regardless of net', () => {
    const c = insidersToCell({
      hasClusterBuy: true, netShares: -1000, buyCount: 3, sellCount: 2
    });
    expect(c.glyph).toBe('⚡ cluster');
    expect(c.color).toBe('green');
  });
  it('shows +N buys when net positive and no cluster', () => {
    const c = insidersToCell({
      hasClusterBuy: false, netShares: 5000, buyCount: 2, sellCount: 0
    });
    expect(c.glyph).toBe('+2 buys');
    expect(c.color).toBe('green');
  });
  it('shows -N sells when net negative', () => {
    const c = insidersToCell({
      hasClusterBuy: false, netShares: -3200, buyCount: 0, sellCount: 5
    });
    expect(c.glyph).toBe('-5 sells');
    expect(c.color).toBe('red');
  });
  it('shows quiet when no buy/sell activity', () => {
    const c = insidersToCell({
      hasClusterBuy: false, netShares: 0, buyCount: 0, sellCount: 0
    });
    expect(c.glyph).toBe('· quiet');
    expect(c.color).toBe('muted');
  });
  it('handles null aggregate', () => {
    const c = insidersToCell(null);
    expect(c.glyph).toBe('—');
    expect(c.color).toBe('muted');
  });
});

describe('filingsToCell', () => {
  const FIXED_NOW = new Date('2026-05-29T00:00:00Z');

  it('shows form + days since filed', () => {
    const c = filingsToCell({ formType: '10-Q', filingDate: '2026-05-17' }, FIXED_NOW);
    expect(c.glyph).toBe('10-Q · 12d');
    expect(c.color).toBe('default');
  });
  it('marks amber when within 7 days', () => {
    const c = filingsToCell({ formType: '8-K', filingDate: '2026-05-26' }, FIXED_NOW);
    expect(c.glyph).toBe('8-K · 3d');
    expect(c.color).toBe('amber');
  });
  it('handles 0d (filed today)', () => {
    const c = filingsToCell({ formType: '8-K', filingDate: '2026-05-29' }, FIXED_NOW);
    expect(c.glyph).toBe('8-K · 0d');
    expect(c.color).toBe('amber');
  });
  it('handles null filing', () => {
    const c = filingsToCell(null);
    expect(c.glyph).toBe('—');
    expect(c.color).toBe('muted');
  });
});
