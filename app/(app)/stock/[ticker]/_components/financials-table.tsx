import type { StatementBundle } from '@/lib/providers/types';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { computeYoY } from '@/lib/compute/growth';

function fmtBillions(v: number | null) {
  if (v == null) return '—';
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  return v.toFixed(0);
}

function fmtPct(v: number | null) {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

export function FinancialsTable({ bundle }: { bundle: StatementBundle }) {
  if (bundle.rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No data.</p>;
  }
  const periods = Array.from(new Set(bundle.rows.map((r) => r.periodEnd))).sort().reverse().slice(0, 5);
  const lineItems = Array.from(new Set(bundle.rows.map((r) => r.lineItem)));

  function get(li: string, period: string): number | null {
    return bundle.rows.find((r) => r.lineItem === li && r.periodEnd === period)?.value ?? null;
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-48">Line item</TableHead>
            {periods.map((p) => (
              <TableHead key={p} className="text-right tabular-nums">{p}</TableHead>
            ))}
            <TableHead className="text-right">YoY</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lineItems.map((li) => {
            const cur = get(li, periods[0]!);
            const prev = periods.length >= 2 ? get(li, periods[1]!) : null;
            const yoy = computeYoY(cur, prev);
            return (
              <TableRow key={li}>
                <TableCell className="font-medium">{li.replace(/_/g, ' ')}</TableCell>
                {periods.map((p) => (
                  <TableCell key={p} className="text-right tabular-nums">
                    {fmtBillions(get(li, p))}
                  </TableCell>
                ))}
                <TableCell className="text-right tabular-nums">{fmtPct(yoy)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
