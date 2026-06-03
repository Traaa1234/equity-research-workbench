'use client';

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface Detail {
  seriesId: string; label: string; unit: string; decimals: number;
  points: { date: string; value: number }[]; badge: string; explain: string; asOf: string | null;
}
const RANGES = ['1y', '3y', '5y'] as const;
type Range = (typeof RANGES)[number];

export function MacroDetail({ seriesId, onClose }: { seriesId: string | null; onClose: () => void }) {
  const [range, setRange] = useState<Range>('3y');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!seriesId) { setDetail(null); return; }
    let alive = true;
    setLoading(true);
    fetch(`/api/macro/${encodeURIComponent(seriesId)}?range=${range}`)
      .then((r) => r.json())
      .then((d) => { if (alive) setDetail(d as Detail); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [seriesId, range]);

  return (
    <Dialog.Root open={!!seriesId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed right-0 top-0 h-full w-full max-w-lg bg-background border-l border-border p-5 overflow-y-auto">
          <Dialog.Title className="text-lg font-semibold">{detail?.label ?? seriesId}</Dialog.Title>
          <Dialog.Description className="text-xs text-muted-foreground mb-3">{detail?.explain ?? ''}</Dialog.Description>

          <div className="flex gap-1.5 mb-3">
            {RANGES.map((r) => (
              <button key={r} onClick={() => setRange(r)}
                className={`rounded-md border px-2 py-1 text-xs ${range === r ? 'bg-foreground text-background' : 'border-border text-muted-foreground'}`}>
                {r.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="h-64">
            {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
            {!loading && detail && detail.points.length > 0 && (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={detail.points}>
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={40} />
                  <YAxis tick={{ fontSize: 10 }} width={44} domain={['auto', 'auto']} />
                  <Tooltip />
                  <Line type="monotone" dataKey="value" stroke="#60a5fa" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            )}
            {!loading && detail && detail.points.length === 0 && <div className="text-sm text-muted-foreground">No data in range.</div>}
          </div>

          {detail?.asOf && <div className="text-[11px] text-muted-foreground mt-3">as of {detail.asOf} · current signal: <b>{detail.badge}</b></div>}

          <Dialog.Close className="absolute top-4 right-4 text-muted-foreground hover:text-foreground text-sm">✕</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
