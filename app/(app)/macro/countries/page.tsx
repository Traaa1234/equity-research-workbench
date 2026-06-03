import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { CountryScorecardService } from '@/lib/services/country-scorecard';
import { CountryScorecard } from './_components/country-scorecard';

export const dynamic = 'force-dynamic';

export default async function CountriesPage() {
  await requireUserId();
  const board = await new CountryScorecardService({ db: getServiceDb() }).getScorecard();
  return (
    <main className="container mx-auto px-4 py-6">
      <h1 className="text-xl font-semibold tracking-tight mb-4">Country Scorecard</h1>
      <CountryScorecard board={board} />
    </main>
  );
}
