import type { SentimentLabel } from '@/lib/providers/types';

interface Article {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: Date;
  sentiment: SentimentLabel | null;
  confidence: number | null;
}

const BADGE_STYLES: Record<SentimentLabel, string> = {
  bullish: 'text-green-600',
  bearish: 'text-red-600',
  neutral: 'text-muted-foreground'
};

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export function ArticleRow({ article }: { article: Article }) {
  return (
    <li className="border-b border-border py-3 last:border-0">
      <div className="flex items-baseline gap-3 text-xs">
        {article.sentiment ? (
          <span className={`font-medium ${BADGE_STYLES[article.sentiment]}`}>
            ● {article.sentiment.toUpperCase()}
            {article.confidence != null && (
              <span className="font-mono ml-1 tabular-nums">({article.confidence.toFixed(2)})</span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground">● UNSCORED</span>
        )}
        <span className="font-mono text-muted-foreground tabular-nums">{fmtDate(article.publishedAt)}</span>
      </div>
      <a
        href={article.url}
        target="_blank"
        rel="noreferrer"
        className="block mt-1 text-sm hover:underline"
      >
        {article.title}
      </a>
      <div className="text-xs text-muted-foreground mt-0.5">{article.source}</div>
    </li>
  );
}
