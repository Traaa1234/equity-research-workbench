import { describe, it, expect } from 'vitest';
import { pipeRenderTable, substituteTableMarkers } from '@/lib/services/table-render';
import type { SecTable } from '@/lib/providers/types';

describe('pipeRenderTable', () => {
  it('renders rows as pipe-separated lines, dropping empty cells', () => {
    const t: SecTable = {
      id: 0,
      rows: [['a', 'b'], ['c', '', 'd']],
      colspans: [[1, 1], [1, 1, 1]],
      head_row_count: 0
    };
    expect(pipeRenderTable(t)).toBe('a | b\nc | d');
  });

  it('returns empty string for an all-empty table', () => {
    const t: SecTable = {
      id: 0,
      rows: [['', '']],
      colspans: [[1, 1]],
      head_row_count: 0
    };
    expect(pipeRenderTable(t)).toBe('');
  });

  it('byte-identical to Slice 3.5 fixture (AAPL Net Sales row)', () => {
    // Mirror of what render_table_as_text emitted before this slice.
    const t: SecTable = {
      id: 0,
      rows: [
        ['Net sales:', '', '', '', ''],
        ['Products', '$ 113,743', '$ 97,960', '$ 217,332', '$ 195,800']
      ],
      colspans: [[1, 1, 1, 1, 1], [1, 1, 1, 1, 1]],
      head_row_count: 0
    };
    expect(pipeRenderTable(t)).toBe(
      'Net sales:\nProducts | $ 113,743 | $ 97,960 | $ 217,332 | $ 195,800'
    );
  });
});

describe('substituteTableMarkers', () => {
  it('substitutes a single marker', () => {
    const text = 'foo <<TABLE_0>> bar';
    const tables: SecTable[] = [
      { id: 0, rows: [['x', 'y']], colspans: [[1, 1]], head_row_count: 0 }
    ];
    expect(substituteTableMarkers(text, tables)).toBe('foo x | y bar');
  });

  it('substitutes multiple markers independently', () => {
    const text = 'a <<TABLE_0>> b <<TABLE_1>> c';
    const tables: SecTable[] = [
      { id: 0, rows: [['x']], colspans: [[1]], head_row_count: 0 },
      { id: 1, rows: [['y']], colspans: [[1]], head_row_count: 0 }
    ];
    expect(substituteTableMarkers(text, tables)).toBe('a x b y c');
  });

  it('collapses marker for missing table id to empty string', () => {
    const text = 'a <<TABLE_5>> b';
    const tables: SecTable[] = [
      { id: 0, rows: [['x']], colspans: [[1]], head_row_count: 0 }
    ];
    expect(substituteTableMarkers(text, tables)).toBe('a  b');
  });

  it('leaves text without markers unchanged', () => {
    expect(substituteTableMarkers('plain text', [])).toBe('plain text');
  });
});
