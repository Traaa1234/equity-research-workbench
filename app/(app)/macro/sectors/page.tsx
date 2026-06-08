// app/(app)/macro/sectors/page.tsx
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { SectorRotationService } from '@/lib/services/sector-rotation';
import { SectorTable } from './_components/sector-table';

export const dynamic = 'force-dynamic';

export default async function SectorsPage() {
  await requireUserId();
  const data = await new SectorRotationService({ db: getServiceDb() }).getSectors();
  return (
    <main className="container mx-auto px-4 py-6">
      <h1 className="text-xl font-semibold tracking-tight mb-4">Sector Rotation</h1>
      <SectorTable data={data} />
    </main>
  );
}
