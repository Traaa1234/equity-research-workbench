import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';
import { HoldingsService } from '@/lib/services/holdings';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;

interface RouteContext { params: { symbol: string }; }

let svc: HoldingsService | null = null;
function service(): HoldingsService {
  if (svc) return svc;
  svc = new HoldingsService({
    db: getServiceDb(),
    secProvider: new SecEdgarProviderImpl()
  });
  return svc;
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
