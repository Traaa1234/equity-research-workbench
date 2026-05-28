import type { PiotroskiResult, QualityResult } from '@/lib/compute/quality';
import { ScoreSparkline } from './score-sparkline';

function label(score: number): { text: string; color: string } {
  if (score >= 7) return { text: 'Healthy',  color: 'text-green-600' };
  if (score >= 4) return { text: 'Mediocre', color: 'text-yellow-600' };
  return                     { text: 'Weak',     color: 'text-red-600' };
}

export function PiotroskiSection({
  result,
  trend
}: {
  result: PiotroskiResult | null;
  trend: QualityResult['trend'];
}) {
  return (
    <section className="space-y-3 border-b pb-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Piotroski F-Score</h2>
        {result ? (
          <span className="flex items-center gap-2">
            <span className="text-2xl font-bold font-mono tabular-nums">{result.score}/9</span>
            <span className={`text-sm font-medium ${label(result.score).color}`}>
              {label(result.score).text}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>

      {result ? (
        <ul className="space-y-1 text-sm">
          {result.tests.map((t) => (
            <li key={t.name} className="flex items-baseline gap-2">
              <span className={t.passed ? 'text-green-600' : 'text-red-600'}>
                {t.passed ? '✓' : '✗'}
              </span>
              <span>{t.name}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          Score could not be computed — required line items missing for the most recent annual period.
        </p>
      )}

      <div>
        <p className="text-xs text-muted-foreground mb-1">5-year trend</p>
        <ScoreSparkline
          data={[...trend].reverse().map((t) => ({ periodEnd: t.periodEnd, value: t.piotroskiF }))}
        />
      </div>

      <div className="text-xs text-muted-foreground italic">
        <p className="font-medium text-sm not-italic mb-1 text-foreground">What is this?</p>
        A 9-question quiz from Joseph Piotroski (Stanford, 2000) measuring fundamental
        improvements year-over-year. Each &quot;yes&quot; = 1 point. The original study
        showed that cheap stocks scoring 8–9 outperformed cheap stocks scoring 0–1 by
        23%/year. <strong>Score 7-9 = strong, 4-6 = mediocre, 0-3 = weak.</strong>
      </div>
    </section>
  );
}
