import type { Signal } from '@/lib/compute/technical';

const KIND_BADGE: Record<Signal['kind'], { label: string; color: string }> = {
  golden_cross:   { label: 'Golden cross',   color: 'text-green-600' },
  death_cross:    { label: 'Death cross',    color: 'text-red-600' },
  macd_bullish:   { label: 'MACD bullish',   color: 'text-green-600' },
  macd_bearish:   { label: 'MACD bearish',   color: 'text-red-600' },
  rsi_overbought: { label: 'RSI overbought', color: 'text-red-600' },
  rsi_oversold:   { label: 'RSI oversold',   color: 'text-green-600' }
};

export function SignalsList({ signals }: { signals: Signal[] }) {
  if (signals.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No technical signals detected in the last year.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {signals.map((s, i) => {
        const meta = KIND_BADGE[s.kind];
        return (
          <li key={`${s.date}-${s.kind}-${i}`} className="flex items-baseline gap-3 text-sm">
            <span className="font-mono text-xs text-muted-foreground tabular-nums">{s.date}</span>
            <span className={`font-medium ${meta.color}`}>{meta.label}</span>
            <span className="text-muted-foreground">{s.desc}</span>
          </li>
        );
      })}
    </ul>
  );
}
