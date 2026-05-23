import { errorResponse } from '@/lib/api/errors';
import { noContent, ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { NotesService } from '@/lib/services/notes';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const MAX_NOTE_BYTES = 50_000;

interface RouteContext { params: { ticker: string }; }

let svc: NotesService | null = null;
function service() {
  if (!svc) svc = new NotesService(getServiceDb());
  return svc;
}

export async function GET(_req: Request, ctx: RouteContext) {
  try {
    const userId = await requireUserId();
    const { ticker } = ctx.params;
    if (!TICKER_RE.test(ticker)) {
      throw new ValidationError(`Invalid ticker: ${ticker}`);
    }
    const body = await service().get(userId, ticker);
    return ok({ ticker, body });
  } catch (err) {
    return errorResponse(err, { route: 'notes GET' });
  }
}

export async function PUT(req: Request, ctx: RouteContext) {
  try {
    const userId = await requireUserId();
    const { ticker } = ctx.params;
    if (!TICKER_RE.test(ticker)) {
      throw new ValidationError(`Invalid ticker: ${ticker}`);
    }
    const parsed = (await req.json().catch(() => ({}))) as { body?: unknown };
    if (typeof parsed.body !== 'string') {
      throw new ValidationError('body is required');
    }
    if (parsed.body.length > MAX_NOTE_BYTES) {
      throw new ValidationError(`Note body exceeds ${MAX_NOTE_BYTES} bytes`);
    }
    await service().upsert(userId, ticker, parsed.body);
    return noContent();
  } catch (err) {
    return errorResponse(err, { route: 'notes PUT' });
  }
}
