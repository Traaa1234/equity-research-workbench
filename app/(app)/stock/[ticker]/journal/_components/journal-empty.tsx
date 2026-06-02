interface Props { variant: 'ticker' | 'all'; ticker?: string; }

export function JournalEmpty({ variant, ticker }: Props) {
  if (variant === 'ticker') {
    return (
      <div className="rounded border border-dashed border-border p-8 text-center space-y-3">
        <p className="text-sm text-muted-foreground">
          No positions on <span className="font-mono font-medium">{ticker}</span> yet.
        </p>
        <p className="text-xs text-muted-foreground">Open one above to start journaling your thesis.</p>
      </div>
    );
  }
  return (
    <div className="rounded border border-dashed border-border p-8 text-center space-y-3">
      <p className="text-sm text-muted-foreground">No positions yet.</p>
      <p className="text-xs text-muted-foreground">
        Open one from any ticker's Journal tab.
      </p>
    </div>
  );
}
