interface Props {
  /** Number of skeleton rows to render. Defaults to 6 (target + 5 peers). */
  count?: number;
}

export function PeersSkeleton({ count = 6 }: Props = {}) {
  return (
    <div className="space-y-2 animate-pulse">
      <div className="hidden sm:block">
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="grid grid-cols-12 gap-3 px-3 py-2 border-b border-border">
            <div className="col-span-2 h-4 bg-muted rounded" />
            <div className="col-span-2 h-4 bg-muted rounded" />
            <div className="col-span-1 h-4 bg-muted rounded" />
            <div className="col-span-1 h-4 bg-muted rounded" />
            <div className="col-span-1 h-4 bg-muted rounded" />
            <div className="col-span-1 h-4 bg-muted rounded" />
            <div className="col-span-1 h-4 bg-muted rounded" />
            <div className="col-span-1 h-4 bg-muted rounded" />
            <div className="col-span-1 h-4 bg-muted rounded" />
            <div className="col-span-1 h-4 bg-muted rounded" />
          </div>
        ))}
      </div>
      <div className="sm:hidden space-y-2">
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="rounded border border-border p-3 h-32 bg-muted/40" />
        ))}
      </div>
    </div>
  );
}
