interface Props {
  ticker: string;
  reason: 'target_missing';
}

export function PeersEmpty({ ticker, reason }: Props) {
  if (reason === 'target_missing') {
    return (
      <div className="rounded border border-dashed border-border p-8 text-center space-y-3">
        <p className="text-sm text-muted-foreground">
          We don't have description data for <span className="font-mono font-medium">{ticker}</span> yet.
        </p>
        <p className="text-xs text-muted-foreground">
          The peers tab needs a description embedding to find semantic neighbors.
          This ticker may not be in the universe seed yet — check back after the next sync.
        </p>
      </div>
    );
  }
  return null;
}
