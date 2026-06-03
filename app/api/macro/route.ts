import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { MacroService } from '@/lib/services/macro';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireUserId();
    const svc = new MacroService({ db: getServiceDb() });
    const board = await svc.getBoard();
    return NextResponse.json(board, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (err) {
    return errorResponse(err, { route: 'macro' });
  }
}
