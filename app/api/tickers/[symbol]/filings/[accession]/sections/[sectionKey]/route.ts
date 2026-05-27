import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FilingsService } from '@/lib/services/filings';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';

const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/;
const SECTION_KEY_RE = /^[a-z0-9_]+$/;

interface RouteContext { params: { symbol: string; accession: string; sectionKey: string }; }

let svc: FilingsService | null = null;
function service() {
  if (svc) return svc;
  svc = new FilingsService({ db: getServiceDb(), provider: new SecEdgarProviderImpl() });
  return svc;
}

export async function GET(_req: Request, ctx: RouteContext) {
  try {
    await requireUserId();
    const { accession, sectionKey } = ctx.params;
    if (!ACCESSION_RE.test(accession)) throw new ValidationError(`Invalid accession: ${accession}`);
    if (!SECTION_KEY_RE.test(sectionKey)) throw new ValidationError(`Invalid section key: ${sectionKey}`);
    const result = await service().getSectionFull(accession, sectionKey);
    if (result == null) throw new NotFoundError(`Section not found: ${sectionKey}`);
    return ok({ text: result.text, tables: result.tables });
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/filings/[accession]/sections/[sectionKey] GET' });
  }
}
