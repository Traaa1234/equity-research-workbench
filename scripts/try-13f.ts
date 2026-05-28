#!/usr/bin/env tsx
/**
 * Smoke: pull 13F institutional holdings for a ticker, print summary + recent rows.
 * Usage: pnpm try-13f <TICKER>
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { HoldingsService } from '@/lib/services/holdings';
import { loadServerEnv } from '@/lib/env';

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
  const ticker = (process.argv[2] ?? '').toUpperCase();
  if (!/^[A-Z][A-Z.]{0,5}$/.test(ticker)) {
    console.error('Usage: pnpm try-13f <TICKER>');
    process.exit(2);
  }

  const env = loadServerEnv();
  const db = getServiceDb();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const svc = new HoldingsService({ db, fdProvider: fd });

  console.log(`Refreshing 13F holdings for ${ticker}...`);
  const t0 = Date.now();
  const summary = await svc.refresh(ticker);
  console.log(`  fetched: ${summary.fetched}, new: ${summary.newRows}, pruned: ${summary.prunedRows} (${Date.now() - t0}ms)\n`);

  const agg = await svc.getAggregate(ticker);
  if (agg.currentPeriod) {
    console.log(`Aggregate (as of ${agg.currentPeriod}):`);
    console.log(`  holders:           ${agg.totalHolders.toLocaleString()}`);
    console.log(`  total shares held: ${agg.totalSharesHeld.toLocaleString()}`);
    console.log(`  total mkt value:   ${fmtDollars(agg.totalMarketValue)}`);
    console.log(`  top-10 concentr:   ${(agg.top10Concentration * 100).toFixed(1)}%`);
    console.log(`  new positions:     ${agg.newPositions}`);
    console.log(`  exits:             ${agg.exits}`);
    console.log(`  smart-money +:     ${agg.smartMoneyMoves.additions.length}`);
    console.log(`  smart-money -:     ${agg.smartMoneyMoves.reductions.length}`);
    console.log(`\nBreadth trend (newest first):`);
    for (const t of agg.breadthTrend) {
      console.log(`  ${t.period}: ${t.holders.toLocaleString()} holders`);
    }
    if (agg.smartMoneyMoves.additions.length + agg.smartMoneyMoves.reductions.length > 0) {
      console.log(`\nSmart-money moves:`);
      for (const m of agg.smartMoneyMoves.additions) {
        const prev = m.sharesPrev?.toLocaleString() ?? '0';
        console.log(`  ▲ ${m.investorName.padEnd(40)} ${prev.padStart(12)} → ${m.shares.toLocaleString().padStart(12)} sh   (${m.delta}, ${m.smartMoneyCategory})`);
      }
      for (const m of agg.smartMoneyMoves.reductions) {
        const prev = m.sharesPrev?.toLocaleString() ?? '0';
        console.log(`  ▼ ${m.investorName.padEnd(40)} ${prev.padStart(12)} → ${m.shares.toLocaleString().padStart(12)} sh   (${m.delta}, ${m.smartMoneyCategory})`);
      }
    }
  } else {
    console.log(`No holdings rows for ${ticker} after refresh — likely FD coverage gap.`);
  }

  const list = await svc.getList(ticker, undefined, 10);
  if (list.length > 0) {
    console.log(`\nTop 10 holders:`);
    for (const h of list) {
      console.log(`  ${h.investorName.padEnd(40)} ${h.shares.toLocaleString().padStart(14)} sh   ${fmtDollars(h.marketValue)}`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('try-13f failed:', err);
  process.exit(1);
});
