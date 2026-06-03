import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { MacroService } from '@/lib/services/macro';
import { MacroBoard } from './_components/macro-board';

export const dynamic = 'force-dynamic';

export default async function MacroPage() {
  await requireUserId();
  const board = await new MacroService({ db: getServiceDb() }).getBoard();
  return (
    <main className="container mx-auto px-4 py-6">
      <h1 className="text-xl font-semibold tracking-tight mb-4">Macro Weather</h1>
      <MacroBoard board={board} />
    </main>
  );
}
