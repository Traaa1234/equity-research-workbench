import { describe, it, expect } from 'vitest';
import {
  classifyDelta,
  joinHoldersWithDeltas,
  computeHoldingsAggregate,
  type HoldingsRow,
  type HolderWithDelta
} from '@/lib/compute/holdings-aggregate';

function row(
  investorId: string,
  investorName: string,
  reportPeriod: string,
  shares: number,
  marketValue: number | null = null,
  pct: number | null = null
): HoldingsRow {
  return { investorId, investorName, reportPeriod, shares, marketValue, sharesPctOfPortfolio: pct };
}

describe('classifyDelta', () => {
  it('returns "new" when prev is null or 0 and current > 0', () => {
    expect(classifyDelta(100, null)).toBe('new');
    expect(classifyDelta(100, 0)).toBe('new');
  });
  it('returns "sold-out" when current is 0 and prev > 0', () => {
    expect(classifyDelta(0, 100)).toBe('sold-out');
  });
  it('returns "added" when current > prev * 1.05', () => {
    expect(classifyDelta(110, 100)).toBe('added');     // +10%
    expect(classifyDelta(106, 100)).toBe('added');     // +6%
  });
  it('returns "reduced" when current < prev * 0.95', () => {
    expect(classifyDelta(90, 100)).toBe('reduced');    // -10%
    expect(classifyDelta(94, 100)).toBe('reduced');    // -6%
  });
  it('returns "unchanged" within ±5% threshold', () => {
    expect(classifyDelta(100, 100)).toBe('unchanged');
    expect(classifyDelta(104, 100)).toBe('unchanged');
    expect(classifyDelta(96, 100)).toBe('unchanged');
  });
});

describe('joinHoldersWithDeltas', () => {
  it('marks present-in-both as added/reduced/unchanged based on share delta', () => {
    const current = [row('0001067983', 'BERKSHIRE', '2026-03-31', 110)];
    const previous = [row('0001067983', 'BERKSHIRE', '2025-12-31', 100)];
    const joined = joinHoldersWithDeltas(current, previous);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.delta).toBe('added');
    expect(joined[0]!.sharesChange).toBe(10);
    expect(joined[0]!.sharesPrev).toBe(100);
  });
  it('marks present-in-current-only as new', () => {
    const current = [row('NEW-FUND', 'NEW FUND', '2026-03-31', 50)];
    const previous: HoldingsRow[] = [];
    const joined = joinHoldersWithDeltas(current, previous);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.delta).toBe('new');
    expect(joined[0]!.sharesPrev).toBeNull();
  });
  it('marks present-in-previous-only as sold-out and emits a row with shares=0', () => {
    const current: HoldingsRow[] = [];
    const previous = [row('EXITING', 'EXITING FUND', '2025-12-31', 200)];
    const joined = joinHoldersWithDeltas(current, previous);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.delta).toBe('sold-out');
    expect(joined[0]!.shares).toBe(0);
    expect(joined[0]!.sharesPrev).toBe(200);
    expect(joined[0]!.sharesChange).toBe(-200);
  });
  it('tags smart-money holders with category', () => {
    const current = [row('0001067983', 'BERKSHIRE HATHAWAY INC', '2026-03-31', 100)];
    const previous: HoldingsRow[] = [];
    const joined = joinHoldersWithDeltas(current, previous);
    expect(joined[0]!.isSmartMoney).toBe(true);
    expect(joined[0]!.smartMoneyCategory).toBe('value');
  });
  it('does not tag non-smart-money holders', () => {
    const current = [row('0000102909', 'VANGUARD GROUP INC', '2026-03-31', 1000)];
    const previous: HoldingsRow[] = [];
    const joined = joinHoldersWithDeltas(current, previous);
    expect(joined[0]!.isSmartMoney).toBe(false);
    expect(joined[0]!.smartMoneyCategory).toBeNull();
  });
});

describe('computeHoldingsAggregate', () => {
  function holder(investorId: string, shares: number, delta: 'new' | 'added' | 'reduced' | 'sold-out' | 'unchanged', isSmart = false): HolderWithDelta {
    return {
      investorId,
      investorName: `FUND ${investorId}`,
      shares,
      marketValue: shares * 290,
      sharesPctOfPortfolio: 0.05,
      delta,
      sharesPrev: delta === 'new' ? null : shares - 10,
      sharesChange: delta === 'new' ? shares : 10,
      isSmartMoney: isSmart,
      smartMoneyCategory: isSmart ? 'value' : null
    };
  }

  it('counts new positions and exits', () => {
    const joined: HolderWithDelta[] = [
      holder('A', 100, 'new'),
      holder('B', 200, 'new'),
      holder('C', 0, 'sold-out'),
      holder('D', 500, 'unchanged')
    ];
    const trend = [{ period: '2026-03-31', holders: 3 }];
    const agg = computeHoldingsAggregate(joined, trend);
    expect(agg.newPositions).toBe(2);
    expect(agg.exits).toBe(1);
    expect(agg.totalHolders).toBe(3);   // sold-out excluded from current count
  });

  it('computes top-10 concentration as sum of top-10 shares / total', () => {
    const joined: HolderWithDelta[] = [];
    for (let i = 1; i <= 15; i++) {
      joined.push(holder(`F${i}`, i * 100, 'unchanged'));
    }
    // shares: 100, 200, ..., 1500. Total = 12000.
    // Top 10 = 600+700+...+1500 = 10500.
    const agg = computeHoldingsAggregate(joined, [{ period: '2026-03-31', holders: 15 }]);
    expect(agg.totalSharesHeld).toBe(12000);
    expect(agg.top10Concentration).toBeCloseTo(10500 / 12000, 5);
  });

  it('returns currentPeriod from trend[0] and previousPeriod from trend[1]', () => {
    const trend = [
      { period: '2026-03-31', holders: 5 },
      { period: '2025-12-31', holders: 4 }
    ];
    const agg = computeHoldingsAggregate([], trend);
    expect(agg.currentPeriod).toBe('2026-03-31');
    expect(agg.previousPeriod).toBe('2025-12-31');
  });

  it('returns null currentPeriod/previousPeriod with empty trend', () => {
    const agg = computeHoldingsAggregate([], []);
    expect(agg.currentPeriod).toBeNull();
    expect(agg.previousPeriod).toBeNull();
  });

  it('separates smart-money moves into additions and reductions', () => {
    const joined: HolderWithDelta[] = [
      holder('SM1', 100, 'new', true),
      holder('SM2', 200, 'added', true),
      holder('SM3', 50, 'reduced', true),
      holder('SM4', 0, 'sold-out', true),
      holder('REG1', 100, 'new', false)   // not smart money
    ];
    const agg = computeHoldingsAggregate(joined, [{ period: '2026-03-31', holders: 4 }]);
    expect(agg.smartMoneyMoves.additions).toHaveLength(2);   // new + added
    expect(agg.smartMoneyMoves.reductions).toHaveLength(2);  // reduced + sold-out
  });

  it('sums market value (excluding sold-out rows which have shares=0)', () => {
    const joined: HolderWithDelta[] = [
      holder('A', 100, 'unchanged'),    // mv = 29000
      holder('B', 200, 'added'),        // mv = 58000
      holder('C', 0, 'sold-out')        // mv = 0
    ];
    const agg = computeHoldingsAggregate(joined, [{ period: '2026-03-31', holders: 2 }]);
    expect(agg.totalMarketValue).toBe(87000);
  });

  it('handles 8-quarter breadthTrend correctly', () => {
    const trend = [
      { period: '2026-03-31', holders: 1200 },
      { period: '2025-12-31', holders: 1150 },
      { period: '2025-09-30', holders: 1100 },
      { period: '2025-06-30', holders: 1080 },
      { period: '2025-03-31', holders: 1050 },
      { period: '2024-12-31', holders: 1000 },
      { period: '2024-09-30', holders: 950 },
      { period: '2024-06-30', holders: 900 }
    ];
    const agg = computeHoldingsAggregate([], trend);
    expect(agg.breadthTrend).toEqual(trend);
    expect(agg.breadthTrend).toHaveLength(8);
  });
});
