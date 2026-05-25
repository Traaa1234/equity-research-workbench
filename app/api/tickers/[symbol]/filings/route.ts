import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FilingsService } from '@/lib/services/filings';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface RouteContext { params: { symbol: string }; }

let svc: FilingsService | null = null;
function service() {
  if (svc) return svc;
  svc = new FilingsService({ db: getServiceDb(), provider: new SecEdgarProviderImpl() });
  return svc;
}

export async function GET(_req: Request, ctx: RouteContext) {
  try {
    await requireUserId();
    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid ticker: ${symbol}`);
    const result = await service().getList(symbol);
    return ok(result);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/filings GET' });
  }
}

export async function POST(_req: Request, ctx: RouteContext) {
  try {
    await requireUserId();
    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid ticker: ${symbol}`);
    const summary = await service().ingest(symbol);
    return ok(summary);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/filings POST' });
  }
}

export const maxDuration = 90; // ingest can take ~30-90s
