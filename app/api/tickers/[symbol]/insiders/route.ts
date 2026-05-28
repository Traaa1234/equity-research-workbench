import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { InsidersService } from '@/lib/services/insiders';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const RATE_LIMIT_PER_MIN = 10;

interface RouteContext { params: { symbol: string }; }

let svc: InsidersService | null = null;
function service(): InsidersService {
  if (svc) return svc;
  const env = loadServerEnv();
  svc = new InsidersService({
    db: getServiceDb(),
    fdProvider: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY })
  });
  return svc;
}

async function rateLimit(userId: string): Promise<boolean> {
  const redis = getRedisCache();
  const key = `ratelimit:insiders-refresh:${userId}`;
  const cur = (await redis.get<number>(key)) ?? 0;
  if (cur >= RATE_LIMIT_PER_MIN) return false;
  await redis.set(key, cur + 1, 60);
  return true;
}

export async function GET(_req: Request, ctx: RouteContext) {
  try {
    await requireUserId();
    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid ticker: ${symbol}`);
    const svc_ = service();
    const [transactions, aggregate] = await Promise.all([
      svc_.getList(symbol),
      svc_.getAggregate(symbol)
    ]);
    return ok({ transactions, aggregate });
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/insiders GET' });
  }
}

export async function POST(_req: Request, ctx: RouteContext) {
  try {
    const userId = await requireUserId();
    if (!(await rateLimit(userId))) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': '60' } }
      );
    }
    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid ticker: ${symbol}`);
    const summary = await service().refresh(symbol);
    return ok(summary);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/insiders POST' });
  }
}
