import Link from 'next/link';
import type { Cell, CellColor } from '@/lib/compute/watchlist-cells';

interface Props {
  cell: Cell;
  href: string;
  align?: 'left' | 'center' | 'right';
}

const COLOR_CLASSES: Record<CellColor, string> = {
  green:   'text-green-600',
  red:     'text-red-600',
  amber:   'text-amber-700',
  muted:   'text-muted-foreground',
  default: 'text-foreground'
};

export function CellChip({ cell, href, align = 'center' }: Props) {
  const alignClass =
    align === 'left' ? 'text-left' :
    align === 'right' ? 'text-right' :
    'text-center';
  return (
    <Link
      href={href}
      title={cell.tooltip}
      className={`block ${alignClass} ${COLOR_CLASSES[cell.color]} font-mono tabular-nums text-sm hover:underline`}
    >
      {cell.glyph}
    </Link>
  );
}
