'use client';

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ReferenceDot
} from 'recharts';
import type { Signal } from '@/lib/compute/technical';

interface DataPoint {
  date: string;
  close: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
}

interface Props {
  data: DataPoint[];
  signals: Signal[];
}

// Indicator line colors — chosen to be distinguishable in default + dark themes
const COLORS = {
  close: '#3b82f6',   // blue-500
  sma20: '#22c55e',   // green-500
  sma50: '#eab308',   // yellow-500
  sma200: '#ef4444'   // red-500
};

// Format ISO date as MM-DD for the X axis (keeps labels short)
const formatTick = (iso: string) => iso.slice(5);

export function PriceChartWithSmas({ data, signals }: Props) {
  // Lookup close price by date so signal markers sit on the price line
  const closeByDate = new Map(data.map((d) => [d.date, d.close]));

  // Only show signal kinds that belong on the price chart (the SMA crosses)
  const priceChartSignals = signals.filter(
    (s) => s.kind === 'golden_cross' || s.kind === 'death_cross'
  );

  return (
    <div className="h-80 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <XAxis dataKey="date" tickFormatter={formatTick} minTickGap={40} />
          <YAxis domain={['auto', 'auto']} width={60} tickFormatter={(v) => v.toFixed(0)} />
          <Tooltip
            labelFormatter={(label) => `Date: ${label}`}
            formatter={(value, name) => [
              typeof value === 'number' ? value.toFixed(2) : '—',
              name
            ]}
          />
          <Legend />
          <Line type="monotone" dataKey="close" stroke={COLORS.close} dot={false} name="Close" strokeWidth={1.5} />
          <Line type="monotone" dataKey="sma20" stroke={COLORS.sma20} dot={false} name="SMA 20" strokeWidth={1} />
          <Line type="monotone" dataKey="sma50" stroke={COLORS.sma50} dot={false} name="SMA 50" strokeWidth={1} />
          <Line type="monotone" dataKey="sma200" stroke={COLORS.sma200} dot={false} name="SMA 200" strokeWidth={1} />
          {priceChartSignals.map((s) => {
            const y = closeByDate.get(s.date);
            if (y == null) return null;
            const fill = s.kind === 'golden_cross' ? '#22c55e' : '#ef4444';
            return (
              <ReferenceDot
                key={`${s.kind}-${s.date}`}
                x={s.date}
                y={y}
                r={5}
                fill={fill}
                stroke="white"
                strokeWidth={1}
                ifOverflow="extendDomain"
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
