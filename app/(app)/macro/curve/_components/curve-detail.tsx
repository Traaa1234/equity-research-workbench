'use client';
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface Detail { seriesId: string; label: string; points: { date: string; value: number }[] }

export function CurveDetail({ seriesId, onClose }: { seriesId: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!seriesId) { setDetail(null); setError(null); return; }
    let alive = true; setLoading(true); setError(null);
    fetch(`/api/curve/${encodeURIComponent(seriesId)}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { if (alive) setDetail(d as Detail); })
      .catch((e) => { if (alive) setError(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [seriesId]);
  return (
    <Dialog.Root open={!!seriesId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed right-0 top-0 h-full w-full max-w-lg bg-background border-l border-border p-5 overflow-y-auto">
          <Dialog.Title className="text-lg font-semibold">{detail ? `${detail.label} Treasury yield` : seriesId}</Dialog.Title>
          <Dialog.Description className="text-xs text-muted-foreground mb-3">Constant-maturity yield history</Dialog.Description>
          {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {error && <div className="text-sm text-red-400">Failed to load: {error}</div>}
          {detail && detail.points.length > 0 && (
            <div className="h-72"><ResponsiveContainer width="100%" height="100%">
              <LineChart data={detail.points}><XAxis dataKey="date" tick={{ fontSize: 9 }} minTickGap={40} /><YAxis tick={{ fontSize: 9 }} width={40} domain={['auto', 'auto']} unit="%" /><Tooltip /><Line type="monotone" dataKey="value" stroke="#60a5fa" dot={false} strokeWidth={2} /></LineChart>
            </ResponsiveContainer></div>
          )}
          {detail && detail.points.length === 0 && !loading && !error && <div className="text-sm text-muted-foreground">No data for this maturity yet.</div>}
          <Dialog.Close className="absolute top-4 right-4 text-muted-foreground hover:text-foreground text-sm">✕</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
