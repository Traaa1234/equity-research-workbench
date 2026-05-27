import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { FinancialsService } from '@/lib/services/financials';
import { loadServerEnv } from '@/lib/env';
import type { PeriodType, StatementType } from '@/lib/providers/types';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const STATEMENT_TYPES: readonly StatementType[] = ['income', 'balance', 'cash_flow'];
const PERIOD_TYPES: readonly PeriodType[] = ['annual', 'quarterly'];

interface RouteContext { params: { symbol: string }; }

let svc: FinancialsService | null = null;
function service(): FinancialsService {
  if (svc) return svc;
  const env = loadServerEnv();
  svc = new FinancialsService({
    db: getServiceDb(),
    // Slice 4: yfinance is primary (free + unlimited); FD is fallback (paid, quota-capped)
    primary: new YFinanceProvider(),
    fallback: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY }),
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
    const type = (url.searchParams.get('type') ?? 'income') as StatementType;
    const period = (url.searchParams.get('period') ?? 'annual') as PeriodType;
    if (!STATEMENT_TYPES.includes(type)) {
      throw new ValidationError(`Invalid type: ${type}`);
    }
    if (!PERIOD_TYPES.includes(period)) {
      throw new ValidationError(`Invalid period: ${period}`);
    }
    const bundle = await service().get(symbol, type, period);
    return ok(bundle);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/financials' });
  }
}
