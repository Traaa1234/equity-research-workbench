import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { NotFoundError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { CountryScorecardService } from '@/lib/services/country-scorecard';
import { COUNTRY_REGISTRY } from '@/lib/compute/country-registry';

export const dynamic = 'force-dynamic';
interface Ctx { params: { code: string } }

export async function GET(_req: Request, ctx: Ctx) {
  try {
    await requireUserId();
    const code = ctx.params.code.toUpperCase();
    if (!COUNTRY_REGISTRY.some((c) => c.code === code)) throw new NotFoundError(`Unknown country: ${code}`);
    const detail = await new CountryScorecardService({ db: getServiceDb() }).getCountryDetail(code);
    return NextResponse.json(detail, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (err) { return errorResponse(err, { route: 'countries/[code]' }); }
}
