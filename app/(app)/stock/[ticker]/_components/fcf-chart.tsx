'use client';

import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import type { StatementBundle } from '@/lib/providers/types';

export function FCFChart({ cashFlow }: { cashFlow: StatementBundle }) {
  const data = Array.from(new Set(cashFlow.rows.map((r) => r.periodEnd)))
    .sort()
    .map((period) => {
      const fcf = cashFlow.rows.find((r) => r.lineItem === 'free_cash_flow' && r.periodEnd === period)?.value;
      const ocf = cashFlow.rows.find((r) => r.lineItem === 'operating_cash_flow' && r.periodEnd === period)?.value;
      const capex = cashFlow.rows.find((r) => r.lineItem === 'capital_expenditure' && r.periodEnd === period)?.value;
      const derived = ocf != null && capex != null ? ocf + capex : null;
      return { period, fcf: (fcf ?? derived) ?? 0 };
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
          <Bar dataKey="fcf" fill="hsl(var(--primary))" radius={2} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
