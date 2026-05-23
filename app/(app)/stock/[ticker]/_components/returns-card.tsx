import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ReturnsPoint } from '@/lib/compute/dashboard';

function fmtPct(v: number | null) {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

export function ReturnsCard({ series }: { series: ReturnsPoint[] }) {
  if (series.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>Profitability & returns</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">No data.</p></CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader><CardTitle>Profitability & returns (5Y)</CardTitle></CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Metric</TableHead>
              {series.map((p) => (
                <TableHead key={p.periodEnd} className="text-right tabular-nums">
                  {p.periodEnd.slice(0, 7)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {[
              { label: 'ROE', key: 'roe' as const },
              { label: 'ROA', key: 'roa' as const },
              { label: 'Gross margin', key: 'grossMargin' as const },
              { label: 'Operating margin', key: 'operatingMargin' as const },
              { label: 'Net margin', key: 'netMargin' as const }
            ].map(({ label, key }) => (
              <TableRow key={key}>
                <TableCell className="font-medium">{label}</TableCell>
                {series.map((p) => (
                  <TableCell key={p.periodEnd} className="text-right tabular-nums">
                    {fmtPct(p[key])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="mt-3 text-xs text-muted-foreground">
          ROIC is deferred to Slice 1.5 (requires pretax-income data not in the current schema).
        </p>
      </CardContent>
    </Card>
  );
}
