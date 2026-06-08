// app/(app)/macro/sectors/_components/sector-table.tsx
'use client';

import { useState } from 'react';
import type { SectorData, ReturnWindow } from '@/lib/services/sector-rotation';
import { SectorDetail } from './sector-detail';

const WINDOWS: ReturnWindow[] = ['1D', '1W', '1M', '3M', '1Y'];

function cellClass(v: number | null): string {
  if (v == null) return 'text-muted-foreground';
  if (v >= 0.005)  return 'bg-emerald-950 text-emerald-300';
  if (v <= -0.005) return 'bg-red-950 text-red-300';
  return 'bg-amber-950 text-amber-300';
}

function fmtPct(v: number | null): string {
  if (v == null) return '—';
  const pct = v * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

export function SectorTable({ data }: { data: SectorData }) {
  const [sortCol, setSortCol] = useState<ReturnWindow>('1M');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [open, setOpen] = useState<string | null>(null);

  if (data.sectors.length === 0 || data.sectors.every((s) => s.latestPrice === null)) {
    return (
      <div className="rounded-xl border border-border p-6 text-sm text-muted-foreground">
        No sector data yet. Run <code>pnpm seed-sectors</code> to backfill, then the daily cron keeps it fresh.
      </div>
    );
  }

  function handleSort(col: ReturnWindow) {
    if (sortCol === col) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortCol(col);
      setSortDir('desc');
    }
  }

  const rows = [...data.sectors].sort((a, b) => {
    const av = a.returns[sortCol] ?? -Infinity;
    const bv = b.returns[sortCol] ?? -Infinity;
    return sortDir === 'desc' ? bv - av : av - bv;
  });

  return (
    <div>
      {data.stale && (
        <div className="text-[11px] text-amber-400 mb-2">
          ⚠ data looks stale — last refresh {data.asOf ?? 'unknown'}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="px-2 py-1.5 text-left text-[10px] uppercase text-muted-foreground">
                Sector
              </th>
              <th className="px-2 py-1.5 text-right text-[10px] uppercase text-muted-foreground">
                Price
              </th>
              {WINDOWS.map((w) => (
                <th
                  key={w}
                  onClick={() => handleSort(w)}
                  className={`px-2 py-1.5 text-right text-[10px] uppercase tracking-wide cursor-pointer select-none ${
                    sortCol === w ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {w} {sortCol === w ? (sortDir === 'desc' ? '↓' : '↑') : ''}
                </th>
              ))}
              <th className="px-2 py-1.5 text-right text-[10px] uppercase text-muted-foreground">
                vs SPY ({sortCol})
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.seriesId}
                onClick={() => setOpen(r.seriesId)}
                className="border-b border-border/50 hover:bg-card cursor-pointer"
              >
                <td className="px-2 py-1.5 font-medium whitespace-nowrap">{r.label}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                  {r.latestPrice != null ? `$${r.latestPrice.toFixed(2)}` : '—'}
                </td>
                {WINDOWS.map((w) => (
                  <td
                    key={w}
                    className={`px-2 py-1.5 text-right tabular-nums text-xs rounded ${cellClass(r.returns[w])}`}
                  >
                    {fmtPct(r.returns[w])}
                  </td>
                ))}
                <td className={`px-2 py-1.5 text-right tabular-nums text-xs rounded ${cellClass(r.vsSpy[sortCol])}`}>
                  {fmtPct(r.vsSpy[sortCol])}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.asOf && (
        <div className="text-[11px] text-muted-foreground mt-2">as of {data.asOf}</div>
      )}
      <SectorDetail seriesId={open} onClose={() => setOpen(null)} />
    </div>
  );
}
