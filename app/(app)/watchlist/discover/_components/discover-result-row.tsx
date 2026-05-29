import Link from 'next/link';
import { flagFor } from '@/lib/compute/country-flags';
import type { DiscoverResult } from '@/lib/services/discover';

interface Props { result: DiscoverResult; }

function truncate(s: string | null, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

export function DiscoverResultRow({ result }: Props) {
  const pct = Math.round(result.similarity * 100);
  return (
    <li className="border-b border-border py-3 last:border-0">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2 min-w-0">
          <Link
            href={`/stock/${result.ticker}`}
            className="font-mono font-medium tabular-nums text-base hover:text-primary"
          >
            {result.ticker}
          </Link>
          <span className="text-sm truncate">{result.name}</span>
        </div>
        <div className="flex items-baseline gap-2 text-xs text-muted-foreground shrink-0">
          {result.country && <span>{flagFor(result.country)}</span>}
          {result.sector && <span>{result.sector}</span>}
          <span className="font-medium text-foreground">{pct}%</span>
        </div>
      </div>
      {result.description && (
        <div className="mt-1 text-xs text-muted-foreground">
          {truncate(result.description, 180)}
        </div>
      )}
    </li>
  );
}
