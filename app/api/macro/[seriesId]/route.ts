import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { NotFoundError, ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { MacroService } from '@/lib/services/macro';
import { MACRO_REGISTRY } from '@/lib/compute/macro-registry';

export const dynamic = 'force-dynamic';

const RANGES = ['1y', '3y', '5y'] as const;
type Range = (typeof RANGES)[number];

interface Ctx { params: { seriesId: string } }

export async function GET(req: Request, ctx: Ctx) {
  try {
    await requireUserId();
    const seriesId = decodeURIComponent(ctx.params.seriesId);
    const rangeRaw = new URL(req.url).searchParams.get('range') ?? '3y';
    if (!RANGES.includes(rangeRaw as Range)) throw new ValidationError(`range must be one of ${RANGES.join(', ')}`);
    if (!MACRO_REGISTRY.some((d) => d.seriesId === seriesId)) throw new NotFoundError(`Unknown series: ${seriesId}`);
    const svc = new MacroService({ db: getServiceDb() });
    const detail = await svc.getSeriesDetail(seriesId, rangeRaw as Range);
    return NextResponse.json(detail, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (err) {
    return errorResponse(err, { route: 'macro/[seriesId]' });
  }
}
