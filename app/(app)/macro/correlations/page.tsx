import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { CorrelationService } from '@/lib/services/correlation';
import { CorrelationMatrix } from './_components/correlation-matrix';

export const dynamic = 'force-dynamic';

export default async function CorrelationsPage() {
  await requireUserId();
  const data = await new CorrelationService({ db: getServiceDb() }).getMatrices();
  return (
    <main className="container mx-auto px-4 py-6">
      <h1 className="text-xl font-semibold tracking-tight mb-4">Cross-Asset Correlations</h1>
      <CorrelationMatrix data={data} />
    </main>
  );
}
