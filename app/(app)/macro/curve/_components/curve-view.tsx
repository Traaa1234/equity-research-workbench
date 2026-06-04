'use client';
import { useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { CurveResult } from '@/lib/compute/curve-analytics';
import { CurveDetail } from './curve-detail';

type Board = CurveResult & { asOf: string | null };
type Overlay = 'm1' | 'y1' | 'y2';
const OVERLAY_LABEL: Record<Overlay, string> = { m1: '1mo', y1: '1yr', y2: '2yr' };
const REC_CLASS: Record<string, string> = { ON: 'text-red-300', CAUTION: 'text-amber-300', WATCH: 'text-amber-300', CLEAR: 'text-emerald-300' };
const SPREAD_BADGE: Record<string, string> = { INVERTED: 'bg-red-950 text-red-300', FLAT: 'bg-amber-950 text-amber-300', POSITIVE: 'bg-emerald-950 text-emerald-300', STEEP: 'bg-emerald-950 text-emerald-300', 'N/A': 'bg-slate-800 text-slate-400' };

export function CurveView({ curve }: { curve: Board }) {
  const [overlay, setOverlay] = useState<Overlay>('y1');
  const [open, setOpen] = useState<string | null>(null);
  const allEmpty = curve.maturities.every((m) => m.current == null);
  if (allEmpty) return <div className="rounded-xl border border-border p-6 text-sm text-muted-foreground">No curve data yet. Run <code>pnpm seed-curve</code>.</div>;

  const r = curve.read;
  const chartData = curve.maturities.map((m) => ({ label: m.label, now: m.current, ago: m.overlay[overlay] }));
  return (
    <div>
      <div className="rounded-2xl border border-amber-700/60 bg-gradient-to-r from-amber-950/40 to-card p-4 mb-4">
        <div className="text-lg font-extrabold">Curve: {r.shape ?? 'n/a'} <span className="text-sm font-semibold text-muted-foreground">· {r.momentum}</span></div>
        <div className="text-xs mt-1">recession signal: <b className={REC_CLASS[r.recession.level] ?? ''}>{r.recession.level}</b> — {r.recession.label}{r.recession.durationMo ? ` (${r.recession.durationMo} mo)` : ''}</div>
        {curve.asOf && <div className="text-[11px] text-muted-foreground mt-1">as of {curve.asOf}</div>}
      </div>

      <div className="rounded-xl border border-border bg-card p-3 mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Treasury yield curve</div>
          <div className="flex gap-1">
            {(['m1', 'y1', 'y2'] as Overlay[]).map((o) => (
              <button key={o} onClick={() => setOverlay(o)} className={`rounded border px-2 py-0.5 text-[10px] ${overlay === o ? 'bg-foreground text-background' : 'border-border text-muted-foreground'}`}>vs {OVERLAY_LABEL[o]}</button>
            ))}
          </div>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <XAxis dataKey="label" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} width={40} domain={['auto', 'auto']} unit="%" />
              <Tooltip />
              <Line type="monotone" dataKey="ago" stroke="#64748b" strokeDasharray="5 4" dot={false} strokeWidth={2} name={`${OVERLAY_LABEL[overlay]} ago`} />
              <Line type="monotone" dataKey="now" stroke="#60a5fa" dot strokeWidth={2.5} name="now" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">Maturity yields</div>
      <div className="grid gap-2 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(96px,1fr))' }}>
        {curve.maturities.map((m) => (
          <button key={m.seriesId} onClick={() => setOpen(m.seriesId)} className="rounded-lg border border-border bg-card p-2 text-center hover:border-foreground/40">
            <div className="text-[10px] font-bold text-muted-foreground">{m.label}</div>
            <div className="text-base font-bold">{m.current == null ? '—' : m.current.toFixed(2)}</div>
            {m.change1d != null && <div className={`text-[9px] ${m.change1d > 0 ? 'text-emerald-400' : m.change1d < 0 ? 'text-red-400' : 'text-muted-foreground'}`}>{m.change1d > 0 ? '▲' : m.change1d < 0 ? '▼' : '—'}{Math.abs(m.change1d).toFixed(2)}</div>}
          </button>
        ))}
      </div>

      <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">Key spreads</div>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))' }}>
        {curve.spreads.map((s) => (
          <div key={s.key} className="rounded-xl border border-border bg-card p-3">
            <div className="text-[10px] uppercase text-muted-foreground">{s.label}</div>
            <div className="text-xl font-bold">{s.value == null ? '—' : `${s.value > 0 ? '+' : ''}${s.value.toFixed(2)}%`}</div>
            <span className={`inline-block mt-2 rounded-full px-2 py-0.5 text-[9px] font-bold ${SPREAD_BADGE[s.badge] ?? SPREAD_BADGE['N/A']}`}>{s.badge}{s.durationMo ? ` · ${s.durationMo}mo` : ''}</span>
          </div>
        ))}
      </div>

      <CurveDetail seriesId={open} onClose={() => setOpen(null)} />
    </div>
  );
}
