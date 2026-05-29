import { cn } from '@/lib/utils';
import { quartileClass, type QuartileDirection } from '@/lib/compute/quartile-helpers';

interface Props {
  value: number | null;
  allValues: Array<number | null>;
  direction: QuartileDirection;
  format: 'currency' | 'multiple' | 'percent' | 'integer' | 'similarity';
  title?: string;
}

function formatValue(value: number | null, format: Props['format']): string {
  if (value == null || !Number.isFinite(value)) return '—';
  switch (format) {
    case 'currency': {
      // Compact USD: $3.2T, $890B, $245M
      if (value >= 1e12) return `$${(value / 1e12).toFixed(1)}T`;
      if (value >= 1e9)  return `$${(value / 1e9).toFixed(1)}B`;
      if (value >= 1e6)  return `$${(value / 1e6).toFixed(1)}M`;
      return `$${value.toFixed(0)}`;
    }
    case 'multiple':
      return `${value.toFixed(1)}x`;
    case 'percent':
      return `${(value * 100).toFixed(1)}%`;
    case 'integer':
      return value.toFixed(0);
    case 'similarity':
      return `${Math.round(value * 100)}%`;
  }
}

export function PeerCell({ value, allValues, direction, format, title }: Props) {
  const text = formatValue(value, format);
  const colorClass = value == null ? '' : quartileClass(value, allValues, direction);
  return (
    <span
      className={cn('tabular-nums', colorClass)}
      title={title ?? (value == null ? 'Data unavailable' : undefined)}
    >
      {text}
    </span>
  );
}
