'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

type Kind = 'entry' | 'review' | 'exit';

interface Props {
  positionId: bigint;
  defaultKind?: Kind;
  onClose?: () => void;
}

export function EntryEditor({ positionId, defaultKind = 'review', onClose }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [kind, setKind] = useState<Kind>(defaultKind);
  const [occurredAt, setOccurredAt] = useState<string>(new Date().toISOString().slice(0, 10));
  const [conviction, setConviction] = useState<number>(7);
  const [thesis, setThesis] = useState<string>('');
  const [outcome, setOutcome] = useState<'right' | 'wrong' | 'mixed' | ''>('');
  const [whatChanged, setWhatChanged] = useState<string>('');
  const [lessons, setLessons] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = {
        kind, occurredAt, thesisMd: thesis, convictionAtTime: conviction
      };
      if (kind !== 'entry' && whatChanged) body.whatChanged = whatChanged;
      if (kind === 'exit') {
        if (outcome) body.outcome = outcome;
        if (lessons) body.lessons = lessons;
      }
      const res = await fetch(`/api/journal/positions/${positionId}/entries`, {
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
    <div className="rounded border border-border p-3 space-y-3 bg-card text-sm">
      <div className="flex items-baseline gap-3">
        <label>
          Kind:{' '}
          <select value={kind} onChange={(e) => setKind(e.currentTarget.value as Kind)}
            className="border border-border rounded px-2 py-1 text-sm">
            <option value="entry">Open</option>
            <option value="review">Review</option>
            <option value="exit">Exit</option>
          </select>
        </label>
        <label>
          Date:{' '}
          <input type="date" value={occurredAt} onChange={(e) => setOccurredAt(e.currentTarget.value)}
            className="border border-border rounded px-2 py-1 text-sm" />
        </label>
        <label>
          Conviction {conviction}/10:{' '}
          <input type="range" min={1} max={10} value={conviction}
            onChange={(e) => setConviction(Number(e.currentTarget.value))} />
        </label>
      </div>
      <label className="block">
        <div className="text-xs text-muted-foreground mb-1">Thesis (markdown)</div>
        <textarea value={thesis} onChange={(e) => setThesis(e.currentTarget.value)} rows={5}
          className="border border-border rounded px-2 py-1 w-full font-mono text-xs" />
      </label>
      {kind !== 'entry' && (
        <label className="block">
          <div className="text-xs text-muted-foreground mb-1">What changed (markdown)</div>
          <textarea value={whatChanged} onChange={(e) => setWhatChanged(e.currentTarget.value)} rows={3}
            className="border border-border rounded px-2 py-1 w-full font-mono text-xs" />
        </label>
      )}
      {kind === 'exit' && (
        <>
          <label className="block">
            Outcome:{' '}
            <select value={outcome} onChange={(e) => setOutcome(e.currentTarget.value as any)}
              className="border border-border rounded px-2 py-1 text-sm">
              <option value="">—</option>
              <option value="right">Right</option>
              <option value="wrong">Wrong</option>
              <option value="mixed">Mixed</option>
            </select>
          </label>
          <label className="block">
            <div className="text-xs text-muted-foreground mb-1">Lessons (markdown)</div>
            <textarea value={lessons} onChange={(e) => setLessons(e.currentTarget.value)} rows={3}
              className="border border-border rounded px-2 py-1 w-full font-mono text-xs" />
          </label>
        </>
      )}
      {err && <p className="text-xs text-rose-700">{err}</p>}
      <div className="flex gap-2 justify-end">
        {onClose && <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>}
        <Button size="sm" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  );
}
