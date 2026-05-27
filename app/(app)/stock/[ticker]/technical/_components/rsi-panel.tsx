'use client';

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine
} from 'recharts';

interface DataPoint {
  date: string;
  rsi: number | null;
}

const formatTick = (iso: string) => iso.slice(5);

export function RsiPanel({ data }: { data: DataPoint[] }) {
  return (
    <div className="h-32 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <XAxis dataKey="date" tickFormatter={formatTick} minTickGap={40} />
          <YAxis domain={[0, 100]} ticks={[0, 30, 50, 70, 100]} width={40} />
          <Tooltip
            labelFormatter={(label) => `Date: ${label}`}
            formatter={(value) => [typeof value === 'number' ? value.toFixed(1) : '—', 'RSI']}
          />
          <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="3 3" />
          <ReferenceLine y={30} stroke="#22c55e" strokeDasharray="3 3" />
          <Line type="monotone" dataKey="rsi" stroke="#8b5cf6" dot={false} strokeWidth={1.25} name="RSI" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
