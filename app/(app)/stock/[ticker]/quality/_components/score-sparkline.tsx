'use client';

import { ResponsiveContainer, LineChart, Line, YAxis, Tooltip } from 'recharts';

interface Point {
  periodEnd: string;
  value: number | null;
}

export function ScoreSparkline({ data, color = 'hsl(var(--primary))' }: { data: Point[]; color?: string }) {
  const series = data
    .filter((d) => d.value != null && Number.isFinite(d.value))
    .map((d) => ({ x: d.periodEnd, y: d.value as number }));

  if (series.length < 2) {
    return <p className="text-xs text-muted-foreground">Insufficient history for trend.</p>;
  }

  const ys = series.map((d) => d.y);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const pad = (max - min) * 0.1 || 0.5;

  return (
    <div className="h-16 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={series}>
          <YAxis domain={[min - pad, max + pad]} hide />
          <Tooltip
            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 11 }}
            labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
            formatter={(v) => (typeof v === 'number' ? v.toFixed(2) : '—')}
            labelFormatter={(label) => `Period: ${label}`}
          />
          <Line type="monotone" dataKey="y" stroke={color} strokeWidth={1.5} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
