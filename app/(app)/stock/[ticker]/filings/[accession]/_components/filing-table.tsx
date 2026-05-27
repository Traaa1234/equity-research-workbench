'use client';

import type { SecTable } from '@/lib/providers/types';

// Right-align cells that look numeric. Anchored ^...$, so "March 28, 2026"
// fails (starts with letter) and "(1,234)" succeeds (parens + digits).
const NUMERIC = /^[\s$(]*[-+]?\d[\d,]*(\.\d+)?[\s)%]*$/;

export function FilingTable({ table }: { table: SecTable }) {
  const head = table.rows.slice(0, table.head_row_count);
  const body = table.rows.slice(table.head_row_count);

  return (
    <div className="my-4 overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse font-mono text-xs">
        {head.length > 0 && (
          <thead>
            {head.map((row, ri) => (
              <tr key={ri} className="border-b border-border bg-muted/40">
                {row.map((cell, ci) => {
                  const span = table.colspans[ri]?.[ci] ?? 1;
                  if (span === 0) return null;
                  return (
                    <th
                      key={ci}
                      colSpan={span}
                      className="px-3 py-2 text-left font-medium"
                    >
                      {cell}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
        )}
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri} className="border-b border-border last:border-0 hover:bg-muted/20">
              {row.map((cell, ci) => {
                const span = table.colspans[ri + head.length]?.[ci] ?? 1;
                if (span === 0) return null;
                const isNum = NUMERIC.test(cell);
                return (
                  <td
                    key={ci}
                    colSpan={span}
                    className={`px-3 py-1.5 ${isNum ? 'text-right tabular-nums' : 'text-left'}`}
                  >
                    {cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
