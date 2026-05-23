import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { PricesService } from '@/lib/services/prices';
import { loadServerEnv } from '@/lib/env';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const RANGES = ['1Y', '5Y'] as const;
type Range = (typeof RANGES)[number];

interface RouteContext { params: { symbol: string }; }

let svc: PricesService | null = null;
function service(): PricesService {
  if (svc) return svc;
  const env = loadServerEnv();
  svc = new PricesService({
    db: getServiceDb(),
    primary: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY }),
    fallback: new YFinanceProvider(),
    redis: getRedisCache()
  });
  return svc;
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    const { symbol } = ctx.params;
    if (!TICKER_RE.test(symbol)) {
      throw new ValidationError(`Invalid ticker: ${symbol}`);
    }
    const url = new URL(req.url);
    const range = (url.searchParams.get('range') ?? '1Y') as Range;
    if (!RANGES.includes(range)) {
      throw new ValidationError(`Invalid range: ${range}`);
    }
    const px = await service().get(symbol, range);
    return ok(px);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/prices' });
  }
}
