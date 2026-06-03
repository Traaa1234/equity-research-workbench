import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { CountryScorecardService } from '@/lib/services/country-scorecard';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireUserId();
    const svc = new CountryScorecardService({ db: getServiceDb() });
    const board = await svc.getScorecard();
    return NextResponse.json(board, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (err) { return errorResponse(err, { route: 'countries' }); }
}
