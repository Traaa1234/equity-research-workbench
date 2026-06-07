import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { CorrelationService } from '@/lib/services/correlation';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireUserId();
    const data = await new CorrelationService({ db: getServiceDb() }).getMatrices();
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (err) { return errorResponse(err, { route: 'correlations' }); }
}
