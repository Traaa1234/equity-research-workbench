'use client';

import { ResponsiveContainer, LineChart, Line, YAxis, Tooltip } from 'recharts';
import type { PricePoint } from '@/lib/providers/types';

export function Sparkline({ data }: { data: PricePoint[] }) {
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground mt-6">No price history.</p>;
  }
  const min = Math.min(...data.map((d) => d.close));
  const max = Math.max(...data.map((d) => d.close));
  return (
    <div className="mt-6 h-32">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <YAxis domain={[min * 0.95, max * 1.05]} hide />
          <Tooltip
            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 12 }}
            labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
            formatter={(v) => (typeof v === 'number' ? `$${v.toFixed(2)}` : String(v))}
          />
          <Line
            type="monotone"
            dataKey="close"
            stroke="hsl(var(--primary))"
            strokeWidth={1.5}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
