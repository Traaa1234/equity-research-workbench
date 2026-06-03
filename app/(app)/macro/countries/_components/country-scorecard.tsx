'use client';
import { useState } from 'react';
import type { RankedRow } from '@/lib/compute/country-score';
import { CountryDetail } from './country-detail';

type DimKey = keyof RankedRow['dims'];
const DIMS: { key: DimKey; label: string }[] = [
  { key: 'growth', label: 'Growth' },
  { key: 'inflation', label: 'Infl' },
  { key: 'rates', label: 'Rates' },
  { key: 'labor', label: 'Labor' },
  { key: 'equity', label: 'Equity' },
];

function cellClass(v: number): string {
  return v >= 67
    ? 'bg-emerald-950 text-emerald-300'
    : v >= 50
      ? 'bg-amber-950 text-amber-300'
      : 'bg-red-950 text-red-300';
}

export function CountryScorecard({ board }: { board: { asOf: string | null; countries: RankedRow[] } }) {
  const [sortKey, setSortKey] = useState<'composite' | DimKey>('composite');
  const [open, setOpen] = useState<string | null>(null);

  if (board.countries.length === 0) {
    return (
      <div className="rounded-xl border border-border p-6 text-sm text-muted-foreground">
        No country data yet. Run <code>pnpm seed-countries</code>.
      </div>
    );
  }

  const rows = [...board.countries].sort((a, b) =>
    sortKey === 'composite' ? b.composite - a.composite : b.dims[sortKey] - a.dims[sortKey],
  );

  return (
    <div>
      {board.asOf && (
        <div className="text-[11px] text-muted-foreground mb-2">as of {board.asOf}</div>
      )}
      {board.asOf && Date.now() - new Date(board.asOf).getTime() > 8 * 864e5 && (
        <div className="text-[11px] text-amber-400 mb-2">
          ⚠ data looks stale — last refresh {board.asOf}
        </div>
      )}
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th className="px-2 py-1.5 text-left text-[10px] uppercase text-muted-foreground">#</th>
            <th className="px-2 py-1.5 text-left text-[10px] uppercase text-muted-foreground">Country</th>
            <th
              onClick={() => setSortKey('composite')}
              className={`px-2 py-1.5 text-[10px] uppercase tracking-wide cursor-pointer ${sortKey === 'composite' ? 'text-foreground' : 'text-muted-foreground'}`}
            >
              Comp
            </th>
            {DIMS.map((d) => (
              <th
                key={d.key}
                onClick={() => setSortKey(d.key)}
                className={`px-2 py-1.5 text-[10px] uppercase tracking-wide cursor-pointer ${sortKey === d.key ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                {d.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.code}
              onClick={() => setOpen(r.code)}
              className="border-b border-border/50 hover:bg-card cursor-pointer"
            >
              <td className="px-2 py-1.5 text-muted-foreground">{r.rank}</td>
              <td className="px-2 py-1.5 whitespace-nowrap">
                {r.flag} {r.name}
              </td>
              <td className="px-1 py-1">
                <span className={`inline-block w-9 rounded text-center font-bold py-0.5 ${cellClass(r.composite)}`}>
                  {r.composite}
                </span>
              </td>
              {DIMS.map((d) => (
                <td key={d.key} className="px-1 py-1">
                  <span className={`inline-block w-9 rounded text-center py-0.5 ${cellClass(r.dims[d.key])}`}>
                    {r.dims[d.key]}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <CountryDetail code={open} onClose={() => setOpen(null)} />
    </div>
  );
}
