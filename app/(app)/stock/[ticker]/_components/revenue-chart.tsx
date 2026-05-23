'use client';

import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import type { StatementBundle } from '@/lib/providers/types';

export function RevenueChart({ income }: { income: StatementBundle }) {
  const data = Array.from(new Set(income.rows.map((r) => r.periodEnd)))
    .sort()
    .map((period) => {
      const rev = income.rows.find((r) => r.lineItem === 'revenue' && r.periodEnd === period)?.value ?? null;
      return { period, revenue: rev ?? 0 };
    });

  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No data.</p>;
  }

  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <XAxis dataKey="period" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
          <YAxis hide />
          <Tooltip
            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 12 }}
            formatter={(v) => typeof v === 'number' ? `$${(v / 1e9).toFixed(1)}B` : String(v)}
          />
          <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={2} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
