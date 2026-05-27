#!/usr/bin/env tsx
/**
 * End-to-end smoke test: `pnpm try TSLA`
 *
 * Fetches snapshot + financials + prices for one ticker through the service
 * layer (cache + provider + fallback). Prints the result so a human can sanity-check.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { getServiceDb } from '@/lib/db/client';
import { companies } from '@/lib/db/schema';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { SnapshotService } from '@/lib/services/snapshot';
import { FinancialsService } from '@/lib/services/financials';
import { PricesService } from '@/lib/services/prices';
import { loadServerEnv } from '@/lib/env';

async function main() {
  const ticker = (process.argv[2] ?? '').toUpperCase();
  if (!/^[A-Z.]{1,6}$/.test(ticker)) {
    console.error('Usage: pnpm try <TICKER>');
    process.exit(2);
  }

  const env = loadServerEnv();
  const db = getServiceDb();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const redis = getRedisCache();

  // Ensure the company row exists.
  await db
    .insert(companies)
    .values({ ticker, name: ticker })
    .onConflictDoNothing();

  // Slice 4: yfinance is primary (free + unlimited); FD is fallback (paid, quota-capped)
  const snapshot = new SnapshotService({ db, primary: yf, fallback: fd, redis });
  const financials = new FinancialsService({ db, primary: yf, fallback: fd, redis });
  const prices = new PricesService({ db, primary: yf, fallback: fd, redis });

  console.log(`\n=== Snapshot ${ticker} ===`);
  console.log(await snapshot.get(ticker));

  console.log(`\n=== Income (annual, last 2 periods) ===`);
  const income = await financials.get(ticker, 'income', 'annual');
  console.log(income.rows.slice(0, 14));

  console.log(`\n=== Prices 1Y (first 3 + last 3) ===`);
  const px = await prices.get(ticker, '1Y');
  console.log([...px.slice(0, 3), '…', ...px.slice(-3)]);

  process.exit(0);
}

main().catch((err) => {
  console.error('try-snapshot failed:', err);
  process.exit(1);
});
