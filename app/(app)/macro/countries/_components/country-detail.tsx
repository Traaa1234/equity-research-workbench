'use client';
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface Detail {
  code: string; name: string; flag: string;
  row: { composite: number; rank: number; dims: Record<string, number> } | null;
  series: Record<string, { date: string; value: number }[]>;
}
const SERIES_LABEL: Record<string, string> = { cli: 'OECD CLI', cpi: 'CPI (index)', longRate: '10y Yield', unemployment: 'Unemployment', etf: 'ETF price' };

export function CountryDetail({ code, onClose }: { code: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!code) { setDetail(null); setError(null); return; }
    let alive = true; setLoading(true); setError(null);
    fetch(`/api/countries/${encodeURIComponent(code)}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { if (alive) setDetail(d as Detail); })
      .catch((e) => { if (alive) setError(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [code]);
  return (
    <Dialog.Root open={!!code} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed right-0 top-0 h-full w-full max-w-lg bg-background border-l border-border p-5 overflow-y-auto">
          <Dialog.Title className="text-lg font-semibold">{detail ? `${detail.flag} ${detail.name}` : code}</Dialog.Title>
          <Dialog.Description className="text-xs text-muted-foreground mb-3">{detail?.row ? `Composite ${detail.row.composite} · rank #${detail.row.rank}` : 'Country detail'}</Dialog.Description>
          {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {error && <div className="text-sm text-red-400">Failed to load: {error}</div>}
          {detail && Object.entries(detail.series).filter(([, pts]) => pts.length).map(([key, pts]) => (
            <div key={key} className="mb-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{SERIES_LABEL[key] ?? key}</div>
              <div className="h-32"><ResponsiveContainer width="100%" height="100%">
                <LineChart data={pts}><XAxis dataKey="date" tick={{ fontSize: 9 }} minTickGap={40} /><YAxis tick={{ fontSize: 9 }} width={40} domain={['auto', 'auto']} /><Tooltip /><Line type="monotone" dataKey="value" stroke="#60a5fa" dot={false} strokeWidth={2} /></LineChart>
              </ResponsiveContainer></div>
            </div>
          ))}
          {detail && Object.values(detail.series).every((pts) => pts.length === 0) && !loading && !error && (
            <div className="text-sm text-muted-foreground">No series data for this country yet.</div>
          )}
          <Dialog.Close className="absolute top-4 right-4 text-muted-foreground hover:text-foreground text-sm">✕</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
