import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FilingsService } from '@/lib/services/filings';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/;

interface RouteContext { params: { symbol: string; accession: string }; }

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
    const accession = ctx.params.accession;
    if (!ACCESSION_RE.test(accession)) throw new ValidationError(`Invalid accession: ${accession}`);
    const result = await service().getFiling(symbol, accession);
    if (!result) throw new NotFoundError(`Filing not found: ${accession}`);
    return ok(result);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/filings/[accession] GET' });
  }
}
