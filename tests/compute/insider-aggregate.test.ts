import { describe, it, expect } from 'vitest';
import {
  computeInsiderAggregate,
  classifyTransaction,
  type InsiderTradeRow
} from '@/lib/compute/insider-aggregate';

function row(
  name: string,
  date: string,
  type: string,
  shares: number,
  value: number | null = null
): InsiderTradeRow {
  return {
    insiderName: name,
    insiderTitle: null,
    transactionDate: date,
    transactionType: type,
    shares,
    transactionValue: value
  };
}

describe('classifyTransaction', () => {
  it('classifies open-market purchase as buy', () => {
    expect(classifyTransaction('Open market purchase')).toBe('buy');
  });
  it('classifies open-market sale as sell', () => {
    expect(classifyTransaction('Open market sale')).toBe('sell');
  });
  it('classifies award as award', () => {
    expect(classifyTransaction('Award')).toBe('award');
    expect(classifyTransaction('Stock Grant')).toBe('award');
  });
  it('classifies option exercise as exercise', () => {
    expect(classifyTransaction('Exercise of options')).toBe('exercise');
  });
  it('classifies unknown as other', () => {
    expect(classifyTransaction('Gift')).toBe('other');
    expect(classifyTransaction('Conversion')).toBe('other');
  });
  it('is case insensitive', () => {
    expect(classifyTransaction('OPEN MARKET PURCHASE')).toBe('buy');
    expect(classifyTransaction('open market sale')).toBe('sell');
  });
});

describe('computeInsiderAggregate', () => {
  const asOf = new Date('2026-05-31');

  it('returns positive net for all-buy fixture', () => {
    const rows: InsiderTradeRow[] = [
      row('Alice', '2026-05-20', 'Open market purchase', 100, 10000),
      row('Alice', '2026-05-15', 'Open market purchase', 200, 20000)
    ];
    const agg = computeInsiderAggregate(rows, 90, asOf);
    expect(agg.netShares).toBe(300);
    expect(agg.netDollarValue).toBe(30000);
    expect(agg.buyCount).toBe(2);
    expect(agg.sellCount).toBe(0);
    expect(agg.uniqueBuyers).toBe(1);
    expect(agg.uniqueSellers).toBe(0);
    expect(agg.hasClusterBuy).toBe(false);   // single buyer = no cluster
    expect(agg.largestBuy?.valueUsd).toBe(20000);
  });

  it('returns negative net for all-sell fixture', () => {
    const rows: InsiderTradeRow[] = [
      row('Alice', '2026-05-20', 'Open market sale', 100, 10000),
      row('Bob',   '2026-05-15', 'Open market sale', 200, 20000)
    ];
    const agg = computeInsiderAggregate(rows, 90, asOf);
    expect(agg.netShares).toBe(-300);
    expect(agg.netDollarValue).toBe(-30000);
    expect(agg.sellCount).toBe(2);
    expect(agg.uniqueSellers).toBe(2);
    expect(agg.largestSell?.name).toBe('Bob');
  });

  it('detects cluster buy when 2+ distinct buyers within 30 days', () => {
    const rows: InsiderTradeRow[] = [
      row('Alice', '2026-05-20', 'Open market purchase', 100, 10000),
      row('Bob',   '2026-05-10', 'Open market purchase', 150, 15000),
      row('Carol', '2026-05-05', 'Open market purchase', 200, 20000)
    ];
    const agg = computeInsiderAggregate(rows, 90, asOf);
    expect(agg.hasClusterBuy).toBe(true);
    expect(agg.clusterBuyDates.length).toBeGreaterThan(0);
    expect(agg.uniqueBuyers).toBe(3);
  });

  it('treats compensation (awards + exercises) as not contributing to aggregate', () => {
    const rows: InsiderTradeRow[] = [
      row('Alice', '2026-05-20', 'Award', 100000, null),
      row('Alice', '2026-05-15', 'Exercise of options', 50000, 5000000)
    ];
    const agg = computeInsiderAggregate(rows, 90, asOf);
    expect(agg.netShares).toBe(0);
    expect(agg.netDollarValue).toBe(0);
    expect(agg.buyCount).toBe(0);
    expect(agg.sellCount).toBe(0);
    expect(agg.hasClusterBuy).toBe(false);
  });

  it('respects the window — old transactions excluded', () => {
    const rows: InsiderTradeRow[] = [
      row('Alice', '2026-05-20', 'Open market purchase', 100, 10000),  // in window
      row('Bob',   '2025-01-01', 'Open market purchase', 9999, 999999) // out of window
    ];
    const agg = computeInsiderAggregate(rows, 90, asOf);
    expect(agg.netShares).toBe(100);
    expect(agg.buyCount).toBe(1);
    expect(agg.uniqueBuyers).toBe(1);
  });

  it('extracts largest buy and largest sell separately', () => {
    const rows: InsiderTradeRow[] = [
      row('Alice', '2026-05-20', 'Open market purchase', 100, 10000),
      row('Bob',   '2026-05-15', 'Open market purchase', 500, 50000),
      row('Carol', '2026-05-10', 'Open market sale',     300, 30000),
      row('Dave',  '2026-05-05', 'Open market sale',     800, 80000)
    ];
    const agg = computeInsiderAggregate(rows, 90, asOf);
    expect(agg.largestBuy?.name).toBe('Bob');
    expect(agg.largestBuy?.valueUsd).toBe(50000);
    expect(agg.largestSell?.name).toBe('Dave');
    expect(agg.largestSell?.valueUsd).toBe(80000);
  });

  it('returns zeros + nulls when no rows in window', () => {
    const agg = computeInsiderAggregate([], 90, asOf);
    expect(agg.netShares).toBe(0);
    expect(agg.netDollarValue).toBe(0);
    expect(agg.buyCount).toBe(0);
    expect(agg.sellCount).toBe(0);
    expect(agg.largestBuy).toBeNull();
    expect(agg.largestSell).toBeNull();
    expect(agg.lastTransactionDate).toBeNull();
    expect(agg.hasClusterBuy).toBe(false);
  });
});
