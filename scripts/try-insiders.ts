#!/usr/bin/env tsx
/**
 * Smoke: pull insider trades for a ticker, print summary + recent rows.
 * Usage: pnpm try-insiders <TICKER>
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { InsidersService } from '@/lib/services/insiders';
import { loadServerEnv } from '@/lib/env';

async function main() {
  const ticker = (process.argv[2] ?? '').toUpperCase();
  if (!/^[A-Z][A-Z.]{0,5}$/.test(ticker)) {
    console.error('Usage: pnpm try-insiders <TICKER>');
    process.exit(2);
  }

  const env = loadServerEnv();
  const db = getServiceDb();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const svc = new InsidersService({ db, fdProvider: fd });

  console.log(`Refreshing insider trades for ${ticker}...`);
  const t0 = Date.now();
  const summary = await svc.refresh(ticker);
  console.log(`  fetched: ${summary.fetched}, new: ${summary.newRows} (${Date.now() - t0}ms)\n`);

  const agg = await svc.getAggregate(ticker, 90);
  console.log(`90-day aggregate:`);
  console.log(`  net shares:   ${agg.netShares.toLocaleString()}`);
  console.log(`  net dollar:   $${agg.netDollarValue.toLocaleString()}`);
  console.log(`  buys:         ${agg.buyCount} txns / ${agg.uniqueBuyers} unique insiders`);
  console.log(`  sells:        ${agg.sellCount} txns / ${agg.uniqueSellers} unique insiders`);
  console.log(`  cluster buy:  ${agg.hasClusterBuy ? 'YES (' + agg.clusterBuyDates.join(', ') + ')' : 'no'}`);
  if (agg.largestBuy)  console.log(`  largest buy:  ${agg.largestBuy.name} ${agg.largestBuy.date} $${agg.largestBuy.valueUsd.toLocaleString()}`);
  if (agg.largestSell) console.log(`  largest sell: ${agg.largestSell.name} ${agg.largestSell.date} $${agg.largestSell.valueUsd.toLocaleString()}`);

  const list = await svc.getList(ticker, 10);
  console.log(`\nRecent 10 transactions:`);
  for (const t of list) {
    const v = t.transactionValue == null ? '—' : `$${t.transactionValue.toLocaleString()}`;
    console.log(`  ${t.transactionDate} ${t.transactionType.padEnd(28)} ${t.insiderName.padEnd(28)} ${t.shares.toLocaleString().padStart(12)} sh   ${v}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('try-insiders failed:', err);
  process.exit(1);
});
