import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FilingsService } from '@/lib/services/filings';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';
import { SummariesService } from '@/lib/services/summaries';
import { QwenProviderImpl } from '@/lib/providers/qwen';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/;

interface RouteContext { params: { symbol: string; accession: string }; }

let svc: SummariesService | null = null;
function service() {
  if (svc) return svc;
  const db = getServiceDb();
  const filingsSvc = new FilingsService({ db, provider: new SecEdgarProviderImpl() });
  svc = new SummariesService({
    db,
    provider: new QwenProviderImpl(),
    filingsService: filingsSvc
  });
  return svc;
}

export async function GET(_req: Request, ctx: RouteContext) {
  try {
    await requireUserId();
    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid ticker: ${symbol}`);
    const accession = ctx.params.accession;
    if (!ACCESSION_RE.test(accession)) throw new ValidationError(`Invalid accession: ${accession}`);
    const result = await service().getOrGenerate(accession);
    return ok(result);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/filings/[accession]/summary GET' });
  }
}

export async function POST(req: Request, ctx: RouteContext) {
  try {
    await requireUserId();
    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid ticker: ${symbol}`);
    const accession = ctx.params.accession;
    if (!ACCESSION_RE.test(accession)) throw new ValidationError(`Invalid accession: ${accession}`);
    const url = new URL(req.url);
    if (url.searchParams.get('regenerate') !== '1') {
      throw new ValidationError('POST requires ?regenerate=1 to avoid accidental triggers');
    }
    const result = await service().regenerate(accession);
    return ok(result);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/filings/[accession]/summary POST' });
  }
}

export const maxDuration = 60;
