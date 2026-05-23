#!/usr/bin/env tsx
/**
 * Seed script: ensures the 10 seed tickers exist in `companies` and performs
 * an initial fetch of snapshot + financials + prices via the service layer
 * (so cache and DB are populated).
 *
 * Run: `pnpm seed`
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { getServiceDb } from '@/lib/db/client';
import { companies } from '@/lib/db/schema';
import { SEED_TICKERS } from '@/lib/seed/tickers';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { SnapshotService } from '@/lib/services/snapshot';
import { FinancialsService } from '@/lib/services/financials';
import { PricesService } from '@/lib/services/prices';
import { loadServerEnv } from '@/lib/env';
import { logger } from '@/lib/logger';

async function main() {
  const env = loadServerEnv();
  const db = getServiceDb();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const redis = getRedisCache();

  const snapshot = new SnapshotService({ db, primary: fd, fallback: yf, redis });
  const financials = new FinancialsService({ db, primary: fd, fallback: yf, redis });
  const prices = new PricesService({ db, primary: fd, fallback: yf, redis });

  logger.info({ count: SEED_TICKERS.length }, 'seed: inserting companies');
  for (const t of SEED_TICKERS) {
    await db
      .insert(companies)
      .values({ ticker: t.ticker, name: t.name, sector: t.sector, isSeed: true })
      .onConflictDoUpdate({
        target: companies.ticker,
        set: { name: t.name, sector: t.sector, isSeed: true }
      });
  }

  for (const t of SEED_TICKERS) {
    const ticker = t.ticker;
    try {
      logger.info({ ticker }, 'seed: snapshot');
      await snapshot.refresh(ticker);

      logger.info({ ticker }, 'seed: income annual');
      await financials.refresh(ticker, 'income', 'annual');
      logger.info({ ticker }, 'seed: balance annual');
      await financials.refresh(ticker, 'balance', 'annual');
      logger.info({ ticker }, 'seed: cash_flow annual');
      await financials.refresh(ticker, 'cash_flow', 'annual');

      logger.info({ ticker }, 'seed: prices 1Y');
      await prices.refresh(ticker, '1Y');
    } catch (err) {
      logger.error({ ticker, err: String(err) }, 'seed: ticker failed; continuing');
    }
  }

  logger.info('seed: done');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: String(err) }, 'seed: fatal');
  process.exit(1);
});
