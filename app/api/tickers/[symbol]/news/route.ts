import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { QwenProviderImpl } from '@/lib/providers/qwen';
import { NewsService } from '@/lib/services/news';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const RATE_LIMIT_PER_MIN = 10;

interface RouteContext { params: { symbol: string }; }

let svc: NewsService | null = null;
function service(): NewsService {
  if (svc) return svc;
  const env = loadServerEnv();
  svc = new NewsService({
    db: getServiceDb(),
    fdProvider: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY }),
    qwenProvider: new QwenProviderImpl()
  });
  return svc;
}

async function rateLimit(userId: string): Promise<boolean> {
  const redis = getRedisCache();
  const key = `ratelimit:news-refresh:${userId}`;
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
    const [articles, aggregate] = await Promise.all([
      svc_.getList(symbol),
      svc_.getAggregate(symbol)
    ]);
    return ok({ articles, aggregate });
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/news GET' });
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
    return errorResponse(err, { route: 'tickers/[symbol]/news POST' });
  }
}
