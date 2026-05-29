import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { PeersService } from '@/lib/services/peers';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const DEFAULT_K = 5;
const MAX_K = 10;
const MIN_K = 1;

interface RouteContext {
  params: { symbol: string };
}

let svc: PeersService | null = null;
function service(): PeersService {
  if (svc) return svc;
  const env = loadServerEnv();
  const db = getServiceDb();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const redis = getRedisCache();
  svc = new PeersService({ db, primary: yf, fallback: fd, redis });
  return svc;
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    await requireUserId();

    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) {
      throw new ValidationError(`Invalid symbol: ${ctx.params.symbol}`);
    }

    const url = new URL(req.url);
    const kRaw = url.searchParams.get('k');
    const k = kRaw == null ? DEFAULT_K : Number(kRaw);
    if (!Number.isInteger(k) || k < MIN_K || k > MAX_K) {
      throw new ValidationError(`k must be an integer in [${MIN_K}, ${MAX_K}]`);
    }

    const result = await service().getPeers(symbol, k);

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'private, max-age=300' }
    });
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/peers' });
  }
}
