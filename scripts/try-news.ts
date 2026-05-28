#!/usr/bin/env tsx
/**
 * Smoke: pull news for a ticker, score via Qwen, print results.
 * Usage: pnpm try-news <TICKER>
 *
 * Writes to prod Neon (companies row must already exist for the ticker).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { QwenProviderImpl } from '@/lib/providers/qwen';
import { NewsService } from '@/lib/services/news';
import { loadServerEnv } from '@/lib/env';

async function main() {
  const ticker = (process.argv[2] ?? '').toUpperCase();
  if (!/^[A-Z][A-Z.]{0,5}$/.test(ticker)) {
    console.error('Usage: pnpm try-news <TICKER>');
    process.exit(2);
  }

  const env = loadServerEnv();
  const db = getServiceDb();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const qwen = new QwenProviderImpl();
  const svc = new NewsService({ db, fdProvider: fd, qwenProvider: qwen });

  console.log(`Refreshing news for ${ticker}...`);
  const t0 = Date.now();
  const summary = await svc.refresh(ticker);
  console.log(`  fetched: ${summary.fetched}, new: ${summary.newArticles}, scored: ${summary.scored} (${Date.now() - t0}ms)`);

  console.log(`\nList (newest 10):`);
  const list = await svc.getList(ticker, 10);
  for (const a of list) {
    const badge = a.sentiment ? `[${a.sentiment.toUpperCase()} ${a.confidence?.toFixed(2)}]` : '[—]';
    console.log(`  ${a.publishedAt.toISOString().slice(0, 19)} ${badge.padEnd(20)} ${a.title.slice(0, 80)}`);
  }

  console.log(`\nAggregate (last 20):`);
  const agg = await svc.getAggregate(ticker, 20);
  console.log(`  bullish=${agg.bullish} neutral=${agg.neutral} bearish=${agg.bearish} score=${agg.score.toFixed(2)}`);

  process.exit(0);
}

main().catch((err) => {
  console.error('try-news failed:', err);
  process.exit(1);
});
