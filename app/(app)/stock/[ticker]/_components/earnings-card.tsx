import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getServiceDb } from '@/lib/db/client';
import { earnings as earningsTable } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';

function fmtEps(v: string | null): string {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)}`;
}

function fmtDate(d: string): string {
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export async function EarningsCard({ ticker }: { ticker: string }) {
  const db = getServiceDb();
  const rows = await db
    .select()
    .from(earningsTable)
    .where(eq(earningsTable.ticker, ticker))
    .orderBy(desc(earningsTable.periodEnd))
    .limit(8);

  return (
    <Card>
      <CardHeader><CardTitle>Earnings (last 8Q)</CardTitle></CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No earnings history for {ticker} yet. Will populate after the next cron run.
          </p>
        ) : (
          <ol className="space-y-2 text-sm">
            {rows.map((r) => (
              <li key={r.periodEnd} className="flex justify-between items-baseline">
                <span className="text-muted-foreground">{r.periodEnd}</span>
                <span className="tabular-nums font-medium">{fmtEps(r.epsActual)}</span>
                {r.reportedDate && (
                  <span className="text-xs text-muted-foreground">
                    Reported {fmtDate(r.reportedDate)}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Consensus EPS + price reaction land in Slice 1.5 (requires paid estimates API).
        </p>
      </CardContent>
    </Card>
  );
}
