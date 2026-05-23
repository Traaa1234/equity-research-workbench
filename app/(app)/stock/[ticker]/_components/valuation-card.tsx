import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ValuationSummary } from '@/lib/compute/dashboard';

function fmtMultiple(v: number | null) {
  if (v == null) return '—';
  return v.toFixed(1) + '×';
}

function delta(curr: number | null, avg: number | null): string {
  if (curr == null || avg == null) return '';
  const d = ((curr - avg) / avg) * 100;
  const sign = d >= 0 ? '+' : '';
  return ` (${sign}${d.toFixed(0)}% vs avg)`;
}

export function ValuationCard({ valuation }: { valuation: ValuationSummary }) {
  const rows: Array<{ label: string; current: number | null; avg: number | null }> = [
    { label: 'P/E', current: valuation.currentPE, avg: valuation.avgPE5Y },
    { label: 'P/S', current: valuation.currentPS, avg: valuation.avgPS5Y },
    { label: 'P/B', current: valuation.currentPB, avg: valuation.avgPB5Y },
    { label: 'EV/EBITDA', current: valuation.currentEvEbitda, avg: valuation.avgEvEbitda5Y },
    { label: 'PEG', current: valuation.currentPEG, avg: null }
  ];
  return (
    <Card>
      <CardHeader><CardTitle>Valuation</CardTitle></CardHeader>
      <CardContent>
        <dl className="space-y-2 text-sm">
          {rows.map((r) => (
            <div key={r.label} className="flex justify-between items-baseline">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="font-semibold tabular-nums">
                {fmtMultiple(r.current)}
                <span className="ml-1 text-xs text-muted-foreground font-normal">
                  {delta(r.current, r.avg)}
                </span>
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">
          5Y averages for P/S, P/B, EV/EBITDA require historical shares-outstanding data, deferred to Slice 1.5.
        </p>
      </CardContent>
    </Card>
  );
}
