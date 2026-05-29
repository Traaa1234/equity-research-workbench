#!/usr/bin/env tsx
/**
 * Smoke: refresh all tracked investors via SEC EDGAR, print aggregate
 * and top 10 holders per watchlist ticker. No args.
 *
 * Usage: pnpm try-13f
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { getServiceDb } from '@/lib/db/client';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';
import { HoldingsService } from '@/lib/services/holdings';
import { CUSIP_BY_TICKER } from '@/lib/compute/cusip-map';

function fmtDollars(n: number | null): string {
  if (n == null) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toLocaleString()}`;
}

async function main() {
  const db = getServiceDb();
  const sec = new SecEdgarProviderImpl();
  const svc = new HoldingsService({ db, secProvider: sec });

  console.log('Refreshing tracked investors via SEC EDGAR...');
  const t0 = Date.now();
  const summary = await svc.refreshTrackedInvestors();
  console.log(
    `  attempted: ${summary.investorsAttempted}, ` +
    `ok: ${summary.investorsSucceeded}, ` +
    `failed: ${summary.investorsFailed}, ` +
    `newRows: ${summary.newRows}, ` +
    `pruned: ${summary.prunedRows} ` +
    `(${Date.now() - t0}ms)\n`
  );

  for (const ticker of Object.keys(CUSIP_BY_TICKER)) {
    const agg = await svc.getAggregate(ticker);
    if (!agg.currentPeriod) {
      console.log(`=== ${ticker}: no tracked investors hold ===\n`);
      continue;
    }
    console.log(`=== ${ticker} (as of ${agg.currentPeriod}) ===`);
    console.log(`  tracked investors holding: ${agg.totalHolders} of 45`);
    console.log(`  total shares held: ${agg.totalSharesHeld.toLocaleString()}`);
    console.log(`  total mkt value:   ${fmtDollars(agg.totalMarketValue)}`);
    console.log(`  top-10 share-of:   ${(agg.top10Concentration * 100).toFixed(1)}%`);
    console.log(`  new positions:     ${agg.newPositions}`);
    console.log(`  exits:             ${agg.exits}`);
    console.log(`  smart-money +/-:   ${agg.smartMoneyMoves.additions.length}/${agg.smartMoneyMoves.reductions.length}`);
    const top10 = await svc.getList(ticker, undefined, 10);
    for (const h of top10) {
      const flag = h.isSmartMoney ? ` [${h.smartMoneyCategory}]` : '';
      console.log(`  ${h.investorName.padEnd(40)} ${h.shares.toLocaleString().padStart(14)} sh   ${fmtDollars(h.marketValue)}   ${h.delta}${flag}`);
    }
    console.log('');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('try-13f failed:', err);
  process.exit(1);
});
