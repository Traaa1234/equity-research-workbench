import type { SecTable } from '@/lib/providers/types';

/**
 * Render a SecTable as pipe-separated rows — TypeScript mirror of the
 * Python render_table_as_text that Slice 3.5 used for embedding text.
 *
 * Drops empty cells within each row (matches Slice 3.5 behavior). Skips
 * rows that end up empty after the drop. Output is byte-identical to
 * what the old Python parser emitted for the same input — verified by
 * the unit tests in this directory.
 */
export function pipeRenderTable(table: SecTable): string {
  return table.rows
    .map((row) => row.filter((cell) => cell !== '').join(' | '))
    .filter((line) => line.length > 0)
    .join('\n');
}

const TABLE_MARKER = /<<TABLE_(\d+)>>/g;

/**
 * Replace every `<<TABLE_N>>` marker in `text` with the pipe-rendered
 * representation of the matching table. Markers referencing missing ids
 * collapse to empty strings.
 *
 * Used by EmbeddingsService.embedFiling before subchunking so the text
 * that gets embedded is byte-identical in shape to what Slice 3.5 produced.
 */
export function substituteTableMarkers(text: string, tables: SecTable[]): string {
  const byId = new Map(tables.map((t) => [t.id, t]));
  return text.replace(TABLE_MARKER, (_, idStr: string) => {
    const id = parseInt(idStr, 10);
    const t = byId.get(id);
    return t ? pipeRenderTable(t) : '';
  });
}
