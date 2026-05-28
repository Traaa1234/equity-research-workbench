interface Props {
  bullish: number;
  neutral: number;
  bearish: number;
  totalScored: number;
  score: number;
  lastRefresh: Date | null;
}

export function SentimentAggregateBar({ bullish, neutral, bearish, totalScored, score, lastRefresh }: Props) {
  if (totalScored === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No scored articles yet.
      </div>
    );
  }

  const pctBullish = (bullish / totalScored) * 100;
  const pctNeutral = (neutral / totalScored) * 100;
  const pctBearish = (bearish / totalScored) * 100;
  const scoreDisplay = score >= 0 ? `+${score.toFixed(2)}` : score.toFixed(2);

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">
        Aggregate (last {totalScored} {totalScored === 1 ? 'article' : 'articles'})
      </div>
      <div className="flex h-3 w-full rounded overflow-hidden bg-muted">
        <div className="bg-green-600" style={{ width: `${pctBullish}%` }} title={`Bullish ${bullish}`} />
        <div className="bg-muted-foreground/30" style={{ width: `${pctNeutral}%` }} title={`Neutral ${neutral}`} />
        <div className="bg-red-600" style={{ width: `${pctBearish}%` }} title={`Bearish ${bearish}`} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <span><span className="text-green-600 font-medium">Bullish</span> {bullish}</span>
        <span><span className="text-muted-foreground font-medium">Neutral</span> {neutral}</span>
        <span><span className="text-red-600 font-medium">Bearish</span> {bearish}</span>
        <span>Score: <span className="font-mono">{scoreDisplay}</span></span>
        {lastRefresh && (
          <span>Last refresh: <span className="font-mono">{lastRefresh.toISOString().slice(0, 19).replace('T', ' ')} UTC</span></span>
        )}
      </div>
    </div>
  );
}
