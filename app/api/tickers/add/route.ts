import { errorResponse } from '@/lib/api/errors';
import { created, ok } from '@/lib/api/responses';
import { NextResponse } from 'next/server';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { companies } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { SnapshotService } from '@/lib/services/snapshot';
import { FinancialsService } from '@/lib/services/financials';
import { PricesService } from '@/lib/services/prices';
import { WatchlistService } from '@/lib/services/watchlist';
import { loadServerEnv } from '@/lib/env';
import { logger } from '@/lib/logger';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const RATE_LIMIT_PER_MIN = 10;

interface ServiceBundle {
  snapshot: SnapshotService;
  financials: FinancialsService;
  prices: PricesService;
  watchlist: WatchlistService;
}

let services: ServiceBundle | null = null;
function getServices(): ServiceBundle {
  if (services) return services;
  const env = loadServerEnv();
  const db = getServiceDb();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const redis = getRedisCache();
  // Slice 4: yfinance is primary (free + unlimited); FD is fallback (paid, quota-capped)
  services = {
    snapshot: new SnapshotService({ db, primary: yf, fallback: fd, redis }),
    financials: new FinancialsService({ db, primary: yf, fallback: fd, redis }),
    prices: new PricesService({ db, primary: yf, fallback: fd, redis }),
    watchlist: new WatchlistService(db)
  };
  return services;
}

async function rateLimit(userId: string): Promise<boolean> {
  const redis = getRedisCache();
  const key = `ratelimit:add-ticker:${userId}`;
  const cur = (await redis.get<number>(key)) ?? 0;
  if (cur >= RATE_LIMIT_PER_MIN) return false;
  await redis.set(key, cur + 1, 60);
  return true;
}

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    if (!(await rateLimit(userId))) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': '60' } }
      );
    }

    const body = (await req.json().catch(() => ({}))) as { symbol?: unknown };
    if (typeof body.symbol !== 'string') {
      throw new ValidationError('symbol is required');
    }
    const symbol = body.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) {
      throw new ValidationError(`Invalid symbol: ${body.symbol}`);
    }

    const svcs = getServices();
    const db = getServiceDb();

    const existing = await db.select().from(companies).where(eq(companies.ticker, symbol)).limit(1);
    if (existing.length > 0) {
      await svcs.watchlist.add(userId, symbol);
      return ok({ ticker: symbol, redirectTo: `/stock/${symbol}` });
    }

    logger.info({ userId, symbol }, 'add-ticker: ingest start');
    await db.insert(companies).values({ ticker: symbol, name: symbol }).onConflictDoNothing();

    const results = await Promise.allSettled([
      svcs.snapshot.refresh(symbol),
      svcs.financials.refresh(symbol, 'income', 'annual'),
      svcs.financials.refresh(symbol, 'balance', 'annual'),
      svcs.financials.refresh(symbol, 'cash_flow', 'annual'),
      svcs.prices.refresh(symbol, '1Y')
    ]);

    const snapshotFailed = results[0]!.status === 'rejected';
    const pricesFailed = results[4]!.status === 'rejected';
    if (snapshotFailed && pricesFailed) {
      await db.delete(companies).where(eq(companies.ticker, symbol));
      throw (results[0] as PromiseRejectedResult).reason;
    }

    await svcs.watchlist.add(userId, symbol);
    logger.info({ userId, symbol, ingested: results.map((r) => r.status) }, 'add-ticker: done');
    return created({ ticker: symbol, redirectTo: `/stock/${symbol}` });
  } catch (err) {
    return errorResponse(err, { route: 'tickers/add' });
  }
}
