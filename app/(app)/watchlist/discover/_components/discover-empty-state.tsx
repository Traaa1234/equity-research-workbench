import Link from 'next/link';

const EXAMPLES = [
  'AI infrastructure',
  'Brazilian CPG on US exchanges',
  'Chinese internet ADRs',
  'small-cap healthcare AI'
];

export function DiscoverEmptyState() {
  return (
    <section className="space-y-3 py-8 text-center">
      <div className="text-sm text-muted-foreground">
        Search the universe of ~6,500 NYSE + Nasdaq + ETF-tracked companies.
      </div>
      <div className="text-xs text-muted-foreground">
        Try:
      </div>
      <ul className="space-y-1.5">
        {EXAMPLES.map((q) => (
          <li key={q}>
            <Link
              href={`/watchlist?tab=discover&q=${encodeURIComponent(q)}`}
              className="text-sm text-primary hover:underline"
            >
              "{q}"
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
