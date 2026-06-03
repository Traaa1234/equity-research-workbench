'use client';

import { useState } from 'react';
import type { MacroBoard as MacroBoardData } from '@/lib/services/macro';
import { MacroTile } from './macro-tile';
import { MacroDetail } from './macro-detail';

export function MacroBoard({ board }: { board: MacroBoardData }) {
  const [open, setOpen] = useState<string | null>(null);
  const w = board.weather;
  const allEmpty = board.groups.every((g) => g.tiles.every((t) => t.value == null));
  if (allEmpty) {
    return (
      <div className="rounded-xl border border-border p-6 text-sm text-muted-foreground">
        No macro data yet. Run <code>pnpm seed-macro</code> to backfill, then the daily cron keeps it fresh.
      </div>
    );
  }
  return (
    <div>
      <div className="rounded-2xl border border-amber-700/60 bg-gradient-to-r from-amber-950/40 to-card p-4 mb-5">
        <div className="text-2xl font-extrabold">
          {w.icon} {w.label} <span className="text-sm font-semibold text-amber-400">· score {w.score >= 0 ? '+' : ''}{w.score} / 7</span>
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          {w.benign} benign · {w.neutral} neutral · {w.caution} caution
          {w.flashing.length > 0 && <> · flashing: <b>{w.flashing.join(', ')}</b></>}
        </div>
        {board.asOf && <div className="text-[11px] text-muted-foreground mt-1">as of {board.asOf}</div>}
        {board.asOf && Date.now() - new Date(board.asOf).getTime() > 5 * 864e5 && (
          <div className="text-[11px] text-amber-400 mt-1">⚠ data looks stale — last refresh {board.asOf}</div>
        )}
      </div>

      {board.groups.map((g) => (
        <section key={g.assetClass} className="mb-4">
          <h2 className="text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border pb-1 mb-2">{g.label}</h2>
          <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(176px,1fr))' }}>
            {g.tiles.map((t) => <MacroTile key={t.seriesId} tile={t} onOpen={setOpen} />)}
          </div>
        </section>
      ))}

      <MacroDetail seriesId={open} onClose={() => setOpen(null)} />
    </div>
  );
}
