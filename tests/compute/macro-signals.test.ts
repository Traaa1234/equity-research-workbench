import { describe, it, expect } from 'vitest';
import {
  curveClassifier, classifyHySpread, classifyVix, classifyNfci, classifyCpiYoY,
  classifySahm, classifyCopperMomentum, percentileClassifier,
  weatherFromVotes, percentileRank, sahmGap, pctChangeOverMonths, yoySeries,
} from '@/lib/compute/macro-signals';

const s = (vals: [string, number][]) => vals.map(([date, value]) => ({ date, value }));

describe('weatherFromVotes', () => {
  it('maps score to the 5 bands', () => {
    expect(weatherFromVotes([1, 1, 1, 1, 0, 0, 0]).label).toBe('SUNNY');   // +4
    expect(weatherFromVotes([1, 1, 0, 0, 0, 0, 0]).label).toBe('FAIR');    // +2
    expect(weatherFromVotes([1, 0, 0, 0, 0, 0, 0]).label).toBe('MIXED');   // +1
    expect(weatherFromVotes([-1, -1, 0, 0, 0, 0, 0]).label).toBe('CLOUDY'); // -2
    expect(weatherFromVotes([-1, -1, -1, -1, 0, 0, 0]).label).toBe('STORMY'); // -4
  });
});

describe('voting classifiers — boundaries', () => {
  it('2s10s curve (flatUpper 0.25)', () => {
    const c = curveClassifier(0.25);
    expect(c({ value: -0.01, series: [] }).level).toBe(-1);
    expect(c({ value: 0, series: [] }).level).toBe(0);
    expect(c({ value: 0.25, series: [] }).level).toBe(0);
    expect(c({ value: 0.26, series: [] }).level).toBe(1);
  });
  it('HY OAS spread', () => {
    expect(classifyHySpread({ value: 5.01, series: [] }).level).toBe(-1);
    expect(classifyHySpread({ value: 5, series: [] }).level).toBe(0);
    expect(classifyHySpread({ value: 3.5, series: [] }).level).toBe(0);
    expect(classifyHySpread({ value: 3.49, series: [] }).level).toBe(1);
  });
  it('VIX', () => {
    expect(classifyVix({ value: 24.1, series: [] }).level).toBe(-1);
    expect(classifyVix({ value: 16, series: [] }).level).toBe(0);
    expect(classifyVix({ value: 15.9, series: [] }).level).toBe(1);
  });
  it('NFCI', () => {
    expect(classifyNfci({ value: 0.21, series: [] }).level).toBe(-1);
    expect(classifyNfci({ value: 0, series: [] }).level).toBe(0);
    expect(classifyNfci({ value: -0.21, series: [] }).level).toBe(1);
  });
  it('CPI YoY', () => {
    expect(classifyCpiYoY({ value: 4.1, series: [] }).level).toBe(-1);
    expect(classifyCpiYoY({ value: 3, series: [] }).level).toBe(0);
    expect(classifyCpiYoY({ value: 2.5, series: [] }).level).toBe(1);
  });
  it('Sahm (unemployment)', () => {
    // base 3.5 for 9 months, then last-3 avg 4.4 -> gap = 4.4 - 3.5 = 0.9 >= 0.5
    const base = Array.from({ length: 9 }, (_, i) => [`2025-${String(i + 1).padStart(2, '0')}-01`, 3.5] as [string, number]);
    const rising = s([...base, ['2025-10-01', 4.2], ['2025-11-01', 4.4], ['2025-12-01', 4.6]]);
    expect(classifySahm({ value: 4.6, series: rising }).level).toBe(-1);
  });
  it('Copper momentum', () => {
    const up = s([['2026-03-01', 5.0], ['2026-06-01', 5.6]]); // +12%
    expect(classifyCopperMomentum({ value: 5.6, series: up }).level).toBe(1);
    const down = s([['2026-03-01', 5.0], ['2026-06-01', 4.6]]); // -8%
    expect(classifyCopperMomentum({ value: 4.6, series: down }).level).toBe(-1);
  });
});

describe('helpers', () => {
  it('percentileRank', () => {
    expect(percentileRank([1, 2, 3, 4], 4)).toBeCloseTo(1);
    expect(percentileRank([1, 2, 3, 4], 1)).toBeCloseTo(0.25);
  });
  it('percentileClassifier thirds', () => {
    const c = percentileClassifier(['LOW', 'NORMAL', 'ELEVATED']);
    const series = s(Array.from({ length: 9 }, (_, i) => [`2026-0${i + 1}-01`, i + 1]));
    expect(c({ value: 1, series }).badge).toBe('LOW');
    expect(c({ value: 5, series }).badge).toBe('NORMAL');
    expect(c({ value: 9, series }).badge).toBe('ELEVATED');
  });
  it('yoySeries computes year-over-year percent', () => {
    // 13 valid months Jan-2025 ... Jan-2026, values 100..112 -> last YoY = (112-100)/100 = 12%
    const monthly = s(Array.from({ length: 13 }, (_, i) => {
      const y = 2025 + Math.floor(i / 12);
      const m = (i % 12) + 1;
      return [`${y}-${String(m).padStart(2, '0')}-01`, 100 + i] as [string, number];
    }));
    const yoy = yoySeries(monthly);
    expect(yoy[yoy.length - 1]!.value).toBeCloseTo(12);
  });
  it('pctChangeOverMonths', () => {
    const series = s([['2026-03-01', 100], ['2026-06-01', 110]]);
    expect(pctChangeOverMonths(series, 3)).toBeCloseTo(10);
  });
  it('sahmGap', () => {
    expect(sahmGap([3.5, 3.5, 3.6, 3.7, 3.8, 3.9, 4.0, 4.1, 4.2, 4.3, 4.4, 4.5])).toBeCloseTo((4.3 + 4.4 + 4.5) / 3 - 3.5);
  });
});
