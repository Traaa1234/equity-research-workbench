import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { YieldCurveService } from '@/lib/services/yield-curve';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireUserId();
    const curve = await new YieldCurveService({ db: getServiceDb() }).getCurve();
    return NextResponse.json(curve, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (err) { return errorResponse(err, { route: 'curve' }); }
}
