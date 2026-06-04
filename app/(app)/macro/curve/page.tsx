import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { YieldCurveService } from '@/lib/services/yield-curve';
import { CurveView } from './_components/curve-view';

export const dynamic = 'force-dynamic';

export default async function CurvePage() {
  await requireUserId();
  const curve = await new YieldCurveService({ db: getServiceDb() }).getCurve();
  return (
    <main className="container mx-auto px-4 py-6">
      <h1 className="text-xl font-semibold tracking-tight mb-4">Yield Curve</h1>
      <CurveView curve={curve} />
    </main>
  );
}
