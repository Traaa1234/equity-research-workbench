import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { verifyCronAuth } from '@/lib/api/auth-cron';
import { runRefresh, type RefreshKind } from '@/lib/ingest/refresh-runner';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { SnapshotService } from '@/lib/services/snapshot';
import { FinancialsService } from '@/lib/services/financials';
import { PricesService } from '@/lib/services/prices';
import { MacroService } from '@/lib/services/macro';
import { FredProvider } from '@/lib/providers/fred';
import { CountryScorecardService } from '@/lib/services/country-scorecard';
import { loadServerEnv } from '@/lib/env';

const VALID_KINDS: readonly RefreshKind[] = ['snapshot', 'fundamentals', 'prices', 'earnings', 'macro', 'countries'];

let cachedDeps: {
  snapshot: SnapshotService;
  financials: FinancialsService;
  prices: PricesService;
  macro: MacroService;
  country: CountryScorecardService;
} | null = null;

function buildDeps() {
  if (cachedDeps) return cachedDeps;
  const env = loadServerEnv();
  const db = getServiceDb();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const redis = getRedisCache();
  const macro = new MacroService({ db, fred: new FredProvider(), yf });
  const country = new CountryScorecardService({ db, fred: new FredProvider(), yf });
  // Slice 4: yfinance is primary (free + unlimited); FD is fallback (paid, quota-capped)
  cachedDeps = {
    snapshot: new SnapshotService({ db, primary: yf, fallback: fd, redis }),
    financials: new FinancialsService({ db, primary: yf, fallback: fd, redis }),
    prices: new PricesService({ db, primary: yf, fallback: fd, redis }),
    macro,
    country
  };
  return cachedDeps;
}

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  try {
    if (!verifyCronAuth(req)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const url = new URL(req.url);
    const kind = url.searchParams.get('kind') as RefreshKind | null;
    if (!kind || !VALID_KINDS.includes(kind)) {
      throw new ValidationError(`kind must be one of: ${VALID_KINDS.join(', ')}`);
    }
    const deps = buildDeps();
    const summary = await runRefresh({
      db: getServiceDb(),
      kind,
      snapshotSvc: deps.snapshot,
      financialsSvc: deps.financials,
      pricesSvc: deps.prices,
      macroSvc: deps.macro,
      countrySvc: deps.country,
      budgetMs: 50_000
    });
    return ok(summary);
  } catch (err) {
    return errorResponse(err, { route: 'cron/refresh' });
  }
}
