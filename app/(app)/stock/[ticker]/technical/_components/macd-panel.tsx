'use client';

import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ReferenceLine,
  Cell
} from 'recharts';

interface DataPoint {
  date: string;
  macdLine: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
}

const formatTick = (iso: string) => iso.slice(5);

export function MacdPanel({ data }: { data: DataPoint[] }) {
  return (
    <div className="h-32 w-full">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <XAxis dataKey="date" tickFormatter={formatTick} minTickGap={40} />
          <YAxis width={50} tickFormatter={(v) => v.toFixed(1)} />
          <Tooltip
            labelFormatter={(label) => `Date: ${label}`}
            formatter={(value, name) => [typeof value === 'number' ? value.toFixed(3) : '—', name]}
          />
          <Legend />
          <ReferenceLine y={0} stroke="#71717a" />
          <Bar dataKey="macdHistogram" name="Histogram">
            {data.map((d, i) => (
              <Cell
                key={`hist-${i}`}
                fill={d.macdHistogram == null ? 'transparent' : d.macdHistogram >= 0 ? '#22c55e' : '#ef4444'}
              />
            ))}
          </Bar>
          <Line type="monotone" dataKey="macdLine" stroke="#3b82f6" dot={false} name="MACD" strokeWidth={1.25} />
          <Line type="monotone" dataKey="macdSignal" stroke="#eab308" dot={false} name="Signal" strokeWidth={1} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
