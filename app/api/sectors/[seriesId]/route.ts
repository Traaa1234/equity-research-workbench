// app/api/sectors/[seriesId]/route.ts
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { SectorRotationService } from '@/lib/services/sector-rotation';

export const dynamic = 'force-dynamic';

const RANGES = ['1y', '3y', '5y'] as const;
type Range = (typeof RANGES)[number];

interface Ctx { params: { seriesId: string } }

export async function GET(req: Request, ctx: Ctx) {
  try {
    await requireUserId();
    const seriesId = decodeURIComponent(ctx.params.seriesId);
    const rangeRaw = new URL(req.url).searchParams.get('range') ?? '1y';
    if (!RANGES.includes(rangeRaw as Range)) {
      throw new ValidationError(`range must be one of: ${RANGES.join(', ')}`);
    }
    const svc = new SectorRotationService({ db: getServiceDb() });
    const detail = await svc.getSeriesHistory(seriesId, rangeRaw as Range);
    return NextResponse.json(detail, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (err) {
    return errorResponse(err, { route: 'sectors/[seriesId]' });
  }
}
