'use client';
import { useState } from 'react';
import type { CorrMatrices } from '@/lib/services/correlation';

type Win = '30' | '60' | '90';

function cellClass(c: number | null, diag: boolean): string {
  if (diag) return 'bg-card text-muted-foreground';
  if (c == null) return 'bg-slate-800 text-slate-500';
  if (c >= 0.55) return 'bg-blue-700 text-blue-50';
  if (c >= 0.2) return 'bg-blue-900 text-blue-200';
  if (c > -0.2) return 'bg-slate-800 text-slate-300';
  if (c > -0.55) return 'bg-red-900 text-red-200';
  return 'bg-red-700 text-red-50';
}
function fmt(c: number | null): string { return c == null ? 'n/a' : (c < 0 ? '' : '+') + c.toFixed(2); }

export function CorrelationMatrix({ data }: { data: CorrMatrices }) {
  const [win, setWin] = useState<Win>('60');
  if (data.asOf == null) {
    return <div className="rounded-xl border border-border p-6 text-sm text-muted-foreground">No overlapping data yet for the cross-asset set.</div>;
  }
  const m = data.windows[win];
  const labels = data.assets.map((a) => a.label);
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] text-muted-foreground">as of {data.asOf} · correlation of daily returns</div>
        <div className="flex gap-1.5">
          {(['30', '60', '90'] as Win[]).map((w) => (
            <button key={w} onClick={() => setWin(w)} className={`rounded-md border px-2 py-1 text-xs ${win === w ? 'bg-foreground text-background' : 'border-border text-muted-foreground'}`}>{w}d</button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="border-separate" style={{ borderSpacing: '3px' }}>
          <thead><tr><th></th>{labels.map((l) => <th key={l} className="text-[10px] text-muted-foreground font-bold px-1">{l}</th>)}</tr></thead>
          <tbody>
            {m.map((row, i) => (
              <tr key={labels[i]}>
                <th className="text-[10px] text-muted-foreground font-bold pr-2 text-right">{labels[i]}</th>
                {row.map((c, j) => (
                  <td key={j} className={`w-[54px] h-[38px] text-center text-xs font-bold rounded-md ${cellClass(c, i === j)}`}>{i === j ? '1.00' : fmt(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 text-[11px] text-muted-foreground">red = move opposite · slate = uncorrelated · blue = move together</div>
    </div>
  );
}
