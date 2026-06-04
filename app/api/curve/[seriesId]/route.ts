import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { NotFoundError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { YieldCurveService } from '@/lib/services/yield-curve';
import { CURVE_MATURITIES } from '@/lib/compute/curve-registry';

export const dynamic = 'force-dynamic';
interface Ctx { params: { seriesId: string } }

export async function GET(_req: Request, ctx: Ctx) {
  try {
    await requireUserId();
    const seriesId = ctx.params.seriesId.toUpperCase();
    if (!CURVE_MATURITIES.some((m) => m.seriesId === seriesId)) throw new NotFoundError(`Unknown maturity: ${seriesId}`);
    const detail = await new YieldCurveService({ db: getServiceDb() }).getMaturityDetail(seriesId);
    return NextResponse.json(detail, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (err) { return errorResponse(err, { route: 'curve/[seriesId]' }); }
}
