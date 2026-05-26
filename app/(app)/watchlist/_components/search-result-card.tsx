import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface Props {
  ticker: string;
  companyName: string;
  accessionNo: string;
  formType: string;
  filingDate: string;
  sectionKey: string;
  sectionTitle: string;
  snippet: string;
  distance: number;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

export function SearchResultCard({
  ticker, companyName, accessionNo, formType, filingDate,
  sectionKey, sectionTitle, snippet, distance
}: Props) {
  const href = `/stock/${ticker}/filings/${accessionNo}#section-${sectionKey}`;
  return (
    <Card>
      <CardContent className="py-4 space-y-2">
        <div className="flex items-baseline gap-2 text-sm">
          <Badge variant="outline">{ticker}</Badge>
          <span className="text-muted-foreground">·</span>
          <span className="font-medium">{formType}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{filingDate}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{sectionTitle}</span>
        </div>
        <p className="text-sm leading-relaxed">{truncate(snippet, 240)}</p>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span aria-hidden>cosine {distance.toFixed(2)} · {companyName}</span>
          <Link href={href} className="hover:text-foreground">open ↗</Link>
        </div>
      </CardContent>
    </Card>
  );
}
