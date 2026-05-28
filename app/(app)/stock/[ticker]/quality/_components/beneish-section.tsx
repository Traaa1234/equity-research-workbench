import type { BeneishResult, QualityResult } from '@/lib/compute/quality';
import { ScoreSparkline } from './score-sparkline';

export function BeneishSection({
  result,
  trend
}: {
  result: BeneishResult | null;
  trend: QualityResult['trend'];
}) {
  return (
    <section className="space-y-3 border-b pb-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Beneish M-Score</h2>
        {result ? (
          <span className="flex items-center gap-2">
            <span className="text-2xl font-bold font-mono tabular-nums">{result.score.toFixed(2)}</span>
            <span className={`text-sm font-medium ${result.flag ? 'text-red-600' : 'text-green-600'}`}>
              {result.flag ? 'Flagged' : 'Clean'}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>

      {result ? (
        <div className="text-sm space-y-1">
          <p className="text-xs text-muted-foreground">
            {result.flag
              ? 'Above −1.78 threshold → possible manipulation patterns detected'
              : 'Below −1.78 threshold → low manipulation risk'}
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono tabular-nums text-xs">
            <span>DSRI (receivables/sales):</span>     <span>{result.components.dsri.toFixed(3)}</span>
            <span>SGI (sales growth):</span>           <span>{result.components.sgi.toFixed(3)}</span>
            <span>GMI (gross-margin inverse):</span>   <span>{result.components.gmi.toFixed(3)}</span>
            <span>DEPI (depreciation inverse):</span>  <span>{result.components.depi.toFixed(3)}</span>
            <span>AQI (asset quality):</span>          <span>{result.components.aqi.toFixed(3)}</span>
            <span>SGAI (SGA/sales):</span>             <span>{result.components.sgai.toFixed(3)}</span>
            <span>LVGI (leverage growth):</span>       <span>{result.components.lvgi.toFixed(3)}</span>
            <span>TATA (accruals/assets):</span>       <span>{result.components.tata.toFixed(3)}</span>
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
          data={[...trend].reverse().map((t) => ({ periodEnd: t.periodEnd, value: t.beneishM }))}
        />
      </div>

      <div className="text-xs text-muted-foreground italic">
        <p className="font-medium text-sm not-italic mb-1 text-foreground">What is this?</p>
        A &quot;lie detector&quot; for financial reports from Messod Beneish (Indiana
        University, 1999). Looks at 8 things companies cooking the books tend to do
        — like collecting from customers more slowly, or shifting toward credit sales.
        Famously flagged Enron, WorldCom, and Tyco <em>before</em> their scandals broke.
        <strong> Below −1.78 = clean, above −1.78 = flagged.</strong>
        <br />
        <em>This is a suspicion signal, not proof of fraud. Most companies above the
        threshold are not fraudsters — they just look statistically similar.</em>
      </div>
    </section>
  );
}
