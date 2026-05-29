import { cn } from '@/lib/utils';
import { quartileClass, type QuartileDirection } from '@/lib/compute/quartile-helpers';

interface Props {
  value: number | null;
  allValues: Array<number | null>;
  direction: QuartileDirection;
  format: 'currency' | 'multiple' | 'percent' | 'integer' | 'similarity';
  title?: string;
}

// Compact USD: handles negatives, sub-million, and the K/M/B/T ladder.
// Examples: -$45.0M, $250.0K, $890.5B, $3.2T
const COMPACT_USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1
});

function formatValue(value: number | null, format: Props['format']): string {
  if (value == null || !Number.isFinite(value)) return '—';
  switch (format) {
    case 'currency':
      return COMPACT_USD.format(value);
    case 'multiple':
      return `${value.toFixed(1)}x`;
    case 'percent':
      return `${(value * 100).toFixed(1)}%`;
    case 'integer':
      return value.toFixed(0);
    case 'similarity':
      return `${Math.round(value * 100)}%`;
    default: {
      // Exhaustiveness check: TypeScript will error here if a new format
      // literal is added to the union but not handled above.
      const _exhaustive: never = format;
      return String(_exhaustive);
    }
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
