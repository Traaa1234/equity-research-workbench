// app/(app)/macro/sectors/_components/sector-detail.tsx
'use client';

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { displaySectors } from '@/lib/compute/sector-registry';

interface History {
  seriesId: string;
  label: string;
  history: { date: string; value: number }[];
}

const RANGES = ['1y', '3y', '5y'] as const;
type Range = (typeof RANGES)[number];

export function SectorDetail({
  seriesId,
  onClose,
}: {
  seriesId: string | null;
  onClose: () => void;
}) {
  const [range, setRange] = useState<Range>('1y');
  const [detail, setDetail] = useState<History | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!seriesId) { setDetail(null); setError(null); return; }
    let alive = true;
    setLoading(true); setError(null);
    fetch(`/api/sectors/${encodeURIComponent(seriesId)}?range=${range}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { if (alive) setDetail(d as History); })
      .catch((e) => { if (alive) setError(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [seriesId, range]);

  const def = seriesId ? displaySectors().find((s) => s.seriesId === seriesId) : null;

  return (
    <Dialog.Root open={!!seriesId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed right-0 top-0 h-full w-full max-w-lg bg-background border-l border-border p-5 overflow-y-auto">
          <Dialog.Title className="text-lg font-semibold">
            {detail?.label ?? def?.label ?? seriesId}
          </Dialog.Title>
          <Dialog.Description className="text-xs text-muted-foreground mb-3">
            Price history
          </Dialog.Description>

          <div className="flex gap-1.5 mb-3">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`rounded-md border px-2 py-1 text-xs ${
                  range === r
                    ? 'bg-foreground text-background'
                    : 'border-border text-muted-foreground'
                }`}
              >
                {r.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="h-64">
            {loading && (
              <div className="text-sm text-muted-foreground">Loading…</div>
            )}
            {!loading && error && (
              <div className="text-sm text-red-400">Failed to load: {error}</div>
            )}
            {!loading && detail && detail.history.length > 0 && (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={detail.history}>
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={40} />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    width={52}
                    domain={['auto', 'auto']}
                    tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                  />
                  <Tooltip formatter={(v) => (typeof v === 'number' ? [`$${v.toFixed(2)}`, 'Price'] : [String(v ?? ''), 'Price'])} />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="#60a5fa"
                    dot={false}
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
            {!loading && detail && detail.history.length === 0 && (
              <div className="text-sm text-muted-foreground">No data in range.</div>
            )}
          </div>

          <Dialog.Close className="absolute top-4 right-4 text-muted-foreground hover:text-foreground text-sm">
            ✕
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
