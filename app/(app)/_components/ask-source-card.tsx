// app/(app)/_components/ask-source-card.tsx
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

interface Props {
  marker: number;
  ticker: string;
  formType: string;
  filingDate: string;
  sectionKey: string;
  sectionTitle: string;
  accessionNo: string;
  snippet: string;
  distance: number;
  highlighted?: boolean;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

export function AskSourceCard({
  marker, ticker, formType, filingDate, sectionKey, sectionTitle,
  accessionNo, snippet, distance, highlighted
}: Props) {
  return (
    <Card
      data-source-marker={marker}
      className={`min-w-[280px] max-w-[320px] transition ${highlighted ? 'ring-2 ring-primary' : ''}`}
    >
      <CardContent className="py-3 space-y-2">
        <div className="flex items-baseline gap-1.5 text-xs">
          <Badge variant="outline" className="font-mono">[{marker}]</Badge>
          <Badge variant="outline">{ticker}</Badge>
          <span className="text-muted-foreground">·</span>
          <span className="font-medium">{formType}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{filingDate}</span>
        </div>
        <p className="text-xs text-muted-foreground">{sectionTitle}</p>
        <p className="text-sm leading-snug">{truncate(snippet, 140)}</p>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span aria-hidden>cosine {distance.toFixed(2)}</span>
          <Link
            href={`/stock/${ticker}/filings/${accessionNo}#section-${sectionKey}`}
            className="hover:text-foreground"
          >
            open ↗
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
