'use client';

import type { SecTable } from '@/lib/providers/types';
import { FilingTable } from './filing-table';

interface Props {
  text: string;
  tables: SecTable[];
}

const MARKER = /<<TABLE_(\d+)>>/;

export function SectionText({ text, tables }: Props) {
  // Split on marker pattern with capture group. Result:
  // [prose, '0', prose, '1', prose, ...]
  const parts = text.split(MARKER);

  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) {
          // Prose segment
          if (!part.trim()) return null;
          return (
            <pre
              key={i}
              className="whitespace-pre-wrap font-mono text-xs leading-relaxed mb-3"
            >
              {part}
            </pre>
          );
        }
        // Table reference — `part` is the id string
        const id = parseInt(part, 10);
        const table = tables.find((t) => t.id === id);
        return table ? <FilingTable key={i} table={table} /> : null;
      })}
    </>
  );
}
