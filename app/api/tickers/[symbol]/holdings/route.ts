import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { HoldingsService } from '@/lib/services/holdings';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;
const RATE_LIMIT_PER_MIN = 10;

interface RouteContext { params: { symbol: string }; }

let svc: HoldingsService | null = null;
function service(): HoldingsService {
  if (svc) return svc;
  const env = loadServerEnv();
  svc = new HoldingsService({
    db: getServiceDb(),
    fdProvider: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY })
  });
  return svc;
}

async function rateLimit(userId: string): Promise<boolean> {
  const redis = getRedisCache();
  const key = `ratelimit:holdings-refresh:${userId}`;
  const cur = (await redis.get<number>(key)) ?? 0;
  if (cur >= RATE_LIMIT_PER_MIN) return false;
  await redis.set(key, cur + 1, 60);
  return true;
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    await requireUserId();
    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid ticker: ${symbol}`);
    const url = new URL(req.url);
    const period = url.searchParams.get('period') ?? undefined;
    if (period && !PERIOD_RE.test(period)) {
      throw new ValidationError(`Invalid period: ${period} (expected YYYY-MM-DD)`);
    }
    const svc_ = service();
    const [holdings, aggregate, availablePeriods] = await Promise.all([
      svc_.getList(symbol, period, 200),
      svc_.getAggregate(symbol),
      svc_.listAvailablePeriods(symbol)
    ]);
    return ok({ holdings, aggregate, availablePeriods });
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/holdings GET' });
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
    return errorResponse(err, { route: 'tickers/[symbol]/holdings POST' });
  }
}
