import { errorResponse } from '@/lib/api/errors';
import { noContent } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { WatchlistService } from '@/lib/services/watchlist';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface RouteContext { params: { ticker: string }; }

let svc: WatchlistService | null = null;
function service() {
  if (!svc) svc = new WatchlistService(getServiceDb());
  return svc;
}

export async function DELETE(_req: Request, ctx: RouteContext) {
  try {
    const userId = await requireUserId();
    const { ticker } = ctx.params;
    if (!TICKER_RE.test(ticker)) {
      throw new ValidationError(`Invalid ticker: ${ticker}`);
    }
    await service().remove(userId, ticker);
    return noContent();
  } catch (err) {
    return errorResponse(err, { route: 'watchlist DELETE' });
  }
}
