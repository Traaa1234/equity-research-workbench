import { flagFor } from '@/lib/compute/country-flags';
import type { ParsedQuery } from '@/lib/services/discover';

interface Props { parsed: ParsedQuery; }

function fmtMarketCap(n: number | null): string {
  if (n == null) return '';
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(0)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(0)}M`;
  return `$${n.toLocaleString()}`;
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded border border-border bg-muted/30 px-2 py-0.5 text-xs">
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-medium">{value}</span>
    </span>
  );
}

export function DiscoverFilterSummary({ parsed }: Props) {
  const chips: Array<{ label: string; value: string }> = [];
  if (parsed.country) chips.push({ label: 'Country', value: `${flagFor(parsed.country)} ${parsed.country}` });
  if (parsed.sector) chips.push({ label: 'Sector', value: parsed.sector });
  if (parsed.industry) chips.push({ label: 'Industry', value: parsed.industry });
  if (parsed.exchanges.length > 0) chips.push({ label: 'Exchange', value: parsed.exchanges.join(' / ') });
  if (parsed.marketCapMin != null || parsed.marketCapMax != null) {
    const min = parsed.marketCapMin != null ? `≥ ${fmtMarketCap(parsed.marketCapMin)}` : '';
    const max = parsed.marketCapMax != null ? `≤ ${fmtMarketCap(parsed.marketCapMax)}` : '';
    chips.push({ label: 'Market cap', value: [min, max].filter(Boolean).join(', ') });
  }
  chips.push({ label: 'Concept', value: parsed.conceptText });

  return (
    <section className="space-y-1">
      <div className="text-xs text-muted-foreground">Filters detected:</div>
      <div className="flex flex-wrap items-baseline gap-2">
        {chips.map((c, i) => <Chip key={i} {...c} />)}
      </div>
    </section>
  );
}
