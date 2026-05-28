import type { QualityResult } from '@/lib/compute/quality';
import { PiotroskiSection } from './piotroski-section';
import { AltmanSection } from './altman-section';
import { BeneishSection } from './beneish-section';

export function QualityView({ quality }: { quality: QualityResult }) {
  return (
    <div className="space-y-6">
      <PiotroskiSection result={quality.current.piotroskiF} trend={quality.trend} />
      <AltmanSection    result={quality.current.altmanZ}    trend={quality.trend} />
      <BeneishSection   result={quality.current.beneishM}   trend={quality.trend} />
    </div>
  );
}
