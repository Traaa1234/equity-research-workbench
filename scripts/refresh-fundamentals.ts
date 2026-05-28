#!/usr/bin/env tsx
/**
 * One-off backfill: delete fundamentals rows for a ticker (or all watched
 * tickers) and re-fetch via FinancialsService. Used after extending the
 * yfinance line-item mappings — existing fundamentals rows are stale.
 *
 * Usage: pnpm refresh-fundamentals <TICKER>
 *        pnpm refresh-fundamentals --all   (refreshes every company in DB)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { and, eq } from 'drizzle-orm';
import { getServiceDb } from '@/lib/db/client';
import { companies, fundamentals } from '@/lib/db/schema';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { FinancialsService } from '@/lib/services/financials';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';

async function main() {
  const arg = process.argv[2] ?? '';
  const env = loadServerEnv();
  const db = getServiceDb();
  const yf = new YFinanceProvider();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const redis = getRedisCache();
  const svc = new FinancialsService({ db, primary: yf, fallback: fd, redis });

  let tickers: string[];
  if (arg === '--all') {
    const rows = await db.select({ ticker: companies.ticker }).from(companies);
    tickers = rows.map((r) => r.ticker);
  } else if (/^[A-Z][A-Z.]{0,5}$/.test(arg.toUpperCase())) {
    tickers = [arg.toUpperCase()];
  } else {
    console.error('Usage: pnpm refresh-fundamentals <TICKER> | --all');
    process.exit(2);
  }

  console.log(`Refreshing fundamentals for ${tickers.length} ticker(s)...\n`);
  for (const t of tickers) {
    process.stdout.write(`${t}: `);
    const t0 = Date.now();
    try {
      // Delete existing rows for this ticker — re-fetch will repopulate
      await db.delete(fundamentals).where(eq(fundamentals.ticker, t));
      // Refresh all three statement types
      await svc.refresh(t, 'income', 'annual');
      await svc.refresh(t, 'balance', 'annual');
      await svc.refresh(t, 'cash_flow', 'annual');
      const count = await db
        .select({ c: fundamentals.lineItem })
        .from(fundamentals)
        .where(and(eq(fundamentals.ticker, t), eq(fundamentals.periodType, 'annual')));
      console.log(`${count.length} rows in ${Date.now() - t0}ms`);
    } catch (err) {
      console.log(`FAIL: ${String(err).slice(0, 200)}`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('refresh-fundamentals failed:', err);
  process.exit(1);
});
