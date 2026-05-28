import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { QualityResult } from '@/lib/compute/quality';

interface Props {
  ticker: string;
  quality: QualityResult;
}

function piotroskiLabel(score: number): { label: string; color: string } {
  if (score >= 7) return { label: 'Healthy',  color: 'bg-green-600' };
  if (score >= 4) return { label: 'Mediocre', color: 'bg-yellow-500' };
  return                     { label: 'Weak',     color: 'bg-red-600' };
}

function altmanLabel(zone: 'safe' | 'caution' | 'distress'): { label: string; color: string } {
  if (zone === 'safe')     return { label: 'Safe',     color: 'bg-green-600' };
  if (zone === 'caution')  return { label: 'Caution',  color: 'bg-yellow-500' };
  return                          { label: 'Distress', color: 'bg-red-600' };
}

function beneishLabel(flag: boolean): { label: string; color: string } {
  return flag
    ? { label: 'Flagged', color: 'bg-red-600' }
    : { label: 'Clean',   color: 'bg-green-600' };
}

function row(
  name: string,
  score: number | null,
  fmt: (n: number) => string,
  badge: { label: string; color: string } | null
) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{name}</span>
      <span className="flex items-center gap-2">
        <span className="font-mono tabular-nums">
          {score == null ? '—' : fmt(score)}
        </span>
        {badge && (
          <>
            <span className={`inline-block h-2 w-2 rounded-full ${badge.color}`} />
            <span className="text-xs text-muted-foreground w-16">{badge.label}</span>
          </>
        )}
      </span>
    </div>
  );
}

export function QualityCard({ ticker, quality }: Props) {
  const f = quality.current.piotroskiF;
  const z = quality.current.altmanZ;
  const m = quality.current.beneishM;

  return (
    <Card>
      <CardHeader><CardTitle>Quality</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {row(
          'Piotroski F-Score',
          f?.score ?? null,
          (n) => `${n}/9`,
          f ? piotroskiLabel(f.score) : null
        )}
        {row(
          'Altman Z-Score',
          z?.score ?? null,
          (n) => n.toFixed(2),
          z ? altmanLabel(z.zone) : null
        )}
        {row(
          'Beneish M-Score',
          m?.score ?? null,
          (n) => n.toFixed(2),
          m ? beneishLabel(m.flag) : null
        )}
        <div className="pt-2 text-right">
          <Link
            href={`/stock/${ticker}/quality`}
            className="text-xs text-primary hover:underline"
          >
            See full breakdown →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
