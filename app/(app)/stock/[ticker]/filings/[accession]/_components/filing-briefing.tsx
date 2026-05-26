import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getServiceDb } from '@/lib/db/client';
import { FilingsService } from '@/lib/services/filings';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';
import { SummariesService } from '@/lib/services/summaries';
import { QwenProviderImpl } from '@/lib/providers/qwen';
import { ProviderError, RateLimitError, ValidationError } from '@/lib/providers/types';
import { RegenerateButton } from './regenerate-button';

function timeAgo(d: Date): string {
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

interface Props {
  ticker: string;
  accession: string;
}

export async function FilingBriefing({ ticker, accession }: Props) {
  const db = getServiceDb();
  const filingsSvc = new FilingsService({ db, provider: new SecEdgarProviderImpl() });
  const svc = new SummariesService({
    db,
    provider: new QwenProviderImpl(),
    filingsService: filingsSvc
  });

  try {
    const summary = await svc.getOrGenerate(accession);
    return (
      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between">
          <CardTitle>Briefing</CardTitle>
          <p className="text-xs text-muted-foreground">
            {summary.model} · generated {timeAgo(summary.generatedAt)}
          </p>
        </CardHeader>
        <CardContent>
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary.summaryText}</ReactMarkdown>
          </div>
          <div className="mt-6 flex justify-end">
            <RegenerateButton ticker={ticker} accession={accession} />
          </div>
        </CardContent>
      </Card>
    );
  } catch (err) {
    const isRate = err instanceof RateLimitError;
    const isValidation = err instanceof ValidationError;
    const isProvider = err instanceof ProviderError;
    return (
      <Card>
        <CardHeader><CardTitle>Briefing unavailable</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {isValidation && 'No parsed content available to summarize for this filing.'}
            {isRate && 'Briefing service is rate-limited. Try again in a moment.'}
            {isProvider && 'Briefing service is temporarily unavailable.'}
            {!isValidation && !isRate && !isProvider && 'Could not generate a briefing for this filing.'}
          </p>
          <RegenerateButton ticker={ticker} accession={accession} />
        </CardContent>
      </Card>
    );
  }
}
