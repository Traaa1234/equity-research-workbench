import type { AltmanResult, QualityResult } from '@/lib/compute/quality';
import { ScoreSparkline } from './score-sparkline';

function label(zone: AltmanResult['zone']): { text: string; color: string } {
  if (zone === 'safe')     return { text: 'Safe',     color: 'text-green-600' };
  if (zone === 'caution')  return { text: 'Caution',  color: 'text-yellow-600' };
  return                          { text: 'Distress', color: 'text-red-600' };
}

export function AltmanSection({
  result,
  trend
}: {
  result: AltmanResult | null;
  trend: QualityResult['trend'];
}) {
  return (
    <section className="space-y-3 border-b pb-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Altman Z-Score</h2>
        {result ? (
          <span className="flex items-center gap-2">
            <span className="text-2xl font-bold font-mono tabular-nums">{result.score.toFixed(2)}</span>
            <span className={`text-sm font-medium ${label(result.zone).color}`}>
              {label(result.zone).text}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>

      {result ? (
        <div className="text-sm space-y-1">
          <p className="text-xs text-muted-foreground">
            Formula: 1.2·A + 1.4·B + 3.3·C + 0.6·D + 1.0·E
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono tabular-nums text-xs">
            <span>A (WC / Assets):</span>           <span>{result.components.a.toFixed(3)}</span>
            <span>B (Retained Earnings / Assets):</span> <span>{result.components.b.toFixed(3)}</span>
            <span>C (EBIT / Assets):</span>          <span>{result.components.c.toFixed(3)}</span>
            <span>D (Market Cap / Liabilities):</span> <span>{result.components.d.toFixed(2)}</span>
            <span>E (Sales / Assets):</span>         <span>{result.components.e.toFixed(3)}</span>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Score could not be computed — required line items missing.
        </p>
      )}

      <div>
        <p className="text-xs text-muted-foreground mb-1">5-year trend</p>
        <ScoreSparkline
          data={[...trend].reverse().map((t) => ({ periodEnd: t.periodEnd, value: t.altmanZ }))}
        />
      </div>

      <div className="text-xs text-muted-foreground italic">
        <p className="font-medium text-sm not-italic mb-1 text-foreground">What is this?</p>
        A bankruptcy-risk indicator from Edward Altman (NYU, 1968). Mixes 5 financial
        ratios into one number that predicts bankruptcy 2 years ahead with ~72% accuracy.
        <strong> Above 2.99 = safe, 1.81–2.99 = caution, below 1.81 = distress.</strong>
        <br />
        <em>Best-suited for non-financial manufacturers. Treat with caution for banks,
        REITs, or pure-software companies.</em>
      </div>
    </section>
  );
}
