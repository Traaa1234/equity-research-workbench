import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/providers/types';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { SnapshotService } from '@/lib/services/snapshot';
import { loadServerEnv } from '@/lib/env';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface RouteContext {
  params: { symbol: string };
}

let svc: SnapshotService | null = null;
function service(): SnapshotService {
  if (svc) return svc;
  const env = loadServerEnv();
  svc = new SnapshotService({
    db: getServiceDb(),
    primary: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY }),
    fallback: new YFinanceProvider(),
    redis: getRedisCache()
  });
  return svc;
}

export async function GET(_req: Request, ctx: RouteContext) {
  try {
    const { symbol } = ctx.params;
    if (!TICKER_RE.test(symbol)) {
      throw new ValidationError(`Invalid ticker: ${symbol}`);
    }
    const snap = await service().get(symbol);
    if (!snap) throw new NotFoundError(`No snapshot for ${symbol}`);
    return ok(snap);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/snapshot' });
  }
}
