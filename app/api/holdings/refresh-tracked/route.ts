import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';
import { HoldingsService } from '@/lib/services/holdings';
import { getRedisCache } from '@/lib/cache/redis';

const RATE_LIMIT_PER_HOUR = 5;

let svc: HoldingsService | null = null;
function service(): HoldingsService {
  if (svc) return svc;
  svc = new HoldingsService({
    db: getServiceDb(),
    secProvider: new SecEdgarProviderImpl()
  });
  return svc;
}

async function rateLimit(userId: string): Promise<boolean> {
  const redis = getRedisCache();
  const key = `ratelimit:holdings-refresh-global:${userId}`;
  const cur = (await redis.get<number>(key)) ?? 0;
  if (cur >= RATE_LIMIT_PER_HOUR) return false;
  await redis.set(key, cur + 1, 60 * 60);
  return true;
}

export async function POST() {
  try {
    const userId = await requireUserId();
    if (!(await rateLimit(userId))) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': '3600' } }
      );
    }
    const summary = await service().refreshTrackedInvestors();
    return ok(summary);
  } catch (err) {
    return errorResponse(err, { route: 'holdings/refresh-tracked POST' });
  }
}
