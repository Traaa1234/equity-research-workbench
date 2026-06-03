'use client';

import type { BoardTile } from '@/lib/services/macro';

const VOTE_BADGE: Record<number, string> = {
  [-1]: 'bg-red-950 text-red-300 border-red-900',
  [0]: 'bg-slate-800 text-slate-300 border-slate-700',
  [1]: 'bg-emerald-950 text-emerald-300 border-emerald-900',
};

function fmt(t: BoardTile): string {
  if (t.value == null) return '—';
  const v = t.value.toLocaleString(undefined, { minimumFractionDigits: t.decimals, maximumFractionDigits: t.decimals });
  return t.unit === '$' ? `$${v}` : t.unit === '%' ? `${v}%` : v;
}

export function MacroTile({ tile, onOpen }: { tile: BoardTile; onOpen: (seriesId: string) => void }) {
  const isVote = tile.role === 'vote';
  const badgeClass = isVote
    ? VOTE_BADGE[tile.level]
    : tile.level !== 0
      ? 'bg-amber-950 text-amber-300 border-amber-900'
      : 'bg-slate-800 text-slate-400 border-slate-700';
  return (
    <button
      onClick={() => onOpen(tile.seriesId)}
      className={`text-left rounded-xl border p-3 transition hover:border-foreground/40 ${isVote ? 'bg-card border-border' : 'bg-card/60 border-dashed border-border'}`}
    >
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {isVote && <span className={`inline-block w-1.5 h-1.5 rounded-full ${tile.level < 0 ? 'bg-red-400' : tile.level > 0 ? 'bg-emerald-400' : 'bg-slate-400'}`} />}
          {tile.label}
        </span>
      </div>
      <div className="text-xl font-bold mt-1">{fmt(tile)}</div>
      {tile.change != null && (
        <div className={`text-[11px] mt-0.5 ${tile.change > 0 ? 'text-emerald-400' : tile.change < 0 ? 'text-red-400' : 'text-muted-foreground'}`}>
          {tile.change > 0 ? '▲' : tile.change < 0 ? '▼' : '—'} {Math.abs(tile.change).toFixed(tile.decimals)}
        </div>
      )}
      <span className={`inline-block mt-2 rounded-full border px-2 py-0.5 text-[9px] font-bold tracking-wide ${badgeClass}`}>{tile.badge}</span>
    </button>
  );
}
