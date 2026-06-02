'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

interface Props {
  ticker: string;
  onClose?: () => void;
}

export function PositionEditor({ ticker, onClose }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [openedAt, setOpenedAt] = useState<string>(new Date().toISOString().slice(0, 10));
  const [conviction, setConviction] = useState<number>(7);
  const [target, setTarget] = useState<string>('');
  const [stop, setStop] = useState<string>('');
  const [hold, setHold] = useState<string>('');
  const [thesis, setThesis] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = {
        ticker, openedAt, convictionAtOpen: conviction
      };
      if (target) body.targetPrice = Number(target);
      if (stop) body.stopPrice = Number(stop);
      if (hold) body.expectedHoldingDays = Number(hold);
      if (thesis) body.firstEntry = { thesisMd: thesis, convictionAtTime: conviction };
      const res = await fetch('/api/journal/positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error || `HTTP ${res.status}`);
      }
      startTransition(() => router.refresh());
      onClose?.();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-border p-4 space-y-3 bg-card">
      <h3 className="font-medium">New position on {ticker}</h3>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <label>
          <div className="text-xs text-muted-foreground">Opened at</div>
          <input type="date" value={openedAt} onChange={(e) => setOpenedAt(e.currentTarget.value)}
            className="border border-border rounded px-2 py-1 w-full" />
        </label>
        <label>
          <div className="text-xs text-muted-foreground">Conviction (1-10): {conviction}</div>
          <input type="range" min={1} max={10} value={conviction}
            onChange={(e) => setConviction(Number(e.currentTarget.value))} className="w-full" />
        </label>
        <label>
          <div className="text-xs text-muted-foreground">Target price (optional)</div>
          <input type="number" step="0.01" value={target} onChange={(e) => setTarget(e.currentTarget.value)}
            className="border border-border rounded px-2 py-1 w-full" />
        </label>
        <label>
          <div className="text-xs text-muted-foreground">Stop price (optional)</div>
          <input type="number" step="0.01" value={stop} onChange={(e) => setStop(e.currentTarget.value)}
            className="border border-border rounded px-2 py-1 w-full" />
        </label>
        <label className="col-span-2">
          <div className="text-xs text-muted-foreground">Expected holding (days, optional)</div>
          <input type="number" value={hold} onChange={(e) => setHold(e.currentTarget.value)}
            className="border border-border rounded px-2 py-1 w-full" />
        </label>
        <label className="col-span-2">
          <div className="text-xs text-muted-foreground">Thesis (markdown)</div>
          <textarea value={thesis} onChange={(e) => setThesis(e.currentTarget.value)} rows={6}
            placeholder="What's your thesis? What's the catalyst? What would prove you wrong?"
            className="border border-border rounded px-2 py-1 w-full font-mono text-xs" />
        </label>
      </div>
      {err && <p className="text-xs text-rose-700">{err}</p>}
      <div className="flex gap-2 justify-end">
        {onClose && <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>}
        <Button onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  );
}
