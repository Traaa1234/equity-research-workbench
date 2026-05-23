'use client';

import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import type { StatementBundle } from '@/lib/providers/types';

export function MarginChart({ income }: { income: StatementBundle }) {
  const periods = Array.from(new Set(income.rows.map((r) => r.periodEnd))).sort();
  const data = periods.map((period) => {
    const rev = income.rows.find((r) => r.lineItem === 'revenue' && r.periodEnd === period)?.value ?? null;
    const gross = income.rows.find((r) => r.lineItem === 'gross_profit' && r.periodEnd === period)?.value ?? null;
    const op = income.rows.find((r) => r.lineItem === 'operating_income' && r.periodEnd === period)?.value ?? null;
    return {
      period,
      gross: rev && gross != null ? (gross / rev) * 100 : null,
      operating: rev && op != null ? (op / rev) * 100 : null
    };
  });

  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No data.</p>;
  }

  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <XAxis dataKey="period" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
          <YAxis unit="%" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
          <Tooltip
            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 12 }}
            formatter={(v) => typeof v === 'number' ? `${v.toFixed(1)}%` : String(v ?? '—')}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line type="monotone" dataKey="gross" stroke="hsl(var(--primary))" name="Gross" dot={false} />
          <Line type="monotone" dataKey="operating" stroke="hsl(var(--accent-foreground))" name="Operating" dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
