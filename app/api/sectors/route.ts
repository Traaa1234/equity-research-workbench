// app/api/sectors/route.ts
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { SectorRotationService } from '@/lib/services/sector-rotation';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireUserId();
    const svc = new SectorRotationService({ db: getServiceDb() });
    const data = await svc.getSectors();
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (err) {
    return errorResponse(err, { route: 'sectors' });
  }
}
