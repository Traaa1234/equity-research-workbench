import { errorResponse } from '@/lib/api/errors';
import { created, ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { WatchlistService } from '@/lib/services/watchlist';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

let svc: WatchlistService | null = null;
function service() {
  if (!svc) svc = new WatchlistService(getServiceDb());
  return svc;
}

export async function GET(_req: Request) {
  try {
    const userId = await requireUserId();
    const rows = await service().list(userId);
    return ok(rows);
  } catch (err) {
    return errorResponse(err, { route: 'watchlist GET' });
  }
}

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const body = (await req.json().catch(() => ({}))) as { ticker?: unknown };
    if (typeof body.ticker !== 'string') {
      throw new ValidationError('ticker is required');
    }
    const ticker = body.ticker.toUpperCase();
    if (!TICKER_RE.test(ticker)) {
      throw new ValidationError(`Invalid ticker: ${body.ticker}`);
    }
    await service().add(userId, ticker);
    return created({ ticker });
  } catch (err) {
    return errorResponse(err, { route: 'watchlist POST' });
  }
}
