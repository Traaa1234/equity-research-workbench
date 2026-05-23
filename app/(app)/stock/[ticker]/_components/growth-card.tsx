import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { GrowthSummary } from '@/lib/compute/dashboard';

function fmtPct(v: number | null) {
  if (v == null) return '—';
  const pct = (v * 100).toFixed(1);
  return v >= 0 ? `+${pct}%` : `${pct}%`;
}

export function GrowthCard({ growth }: { growth: GrowthSummary }) {
  const rows: Array<{ label: string; threeY: number | null; fiveY: number | null }> = [
    { label: 'Revenue', threeY: growth.revenueCAGR3Y, fiveY: growth.revenueCAGR5Y },
    { label: 'EPS', threeY: growth.epsCAGR3Y, fiveY: growth.epsCAGR5Y },
    { label: 'FCF', threeY: growth.fcfCAGR3Y, fiveY: growth.fcfCAGR5Y }
  ];
  return (
    <Card>
      <CardHeader><CardTitle>Growth (CAGR)</CardTitle></CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-x-4 gap-y-3 text-sm">
          <div className="text-muted-foreground">Metric</div>
          <div className="text-muted-foreground text-right">3Y</div>
          <div className="text-muted-foreground text-right">5Y</div>
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <div className="font-medium">{r.label}</div>
              <div className="text-right tabular-nums">{fmtPct(r.threeY)}</div>
              <div className="text-right tabular-nums">{fmtPct(r.fiveY)}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
