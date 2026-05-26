#!/usr/bin/env tsx
/**
 * End-to-end smoke: `pnpm try-search "<query>" [--user-id <uuid>]`
 *
 * Picks a user with a non-empty watchlist (or accepts --user-id) and runs
 * SearchService end-to-end against live DashScope + Postgres. Prints the
 * top 10 results with ticker + filing + 200-char snippet + distance.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { count } from 'drizzle-orm';
import { getServiceDb } from '@/lib/db/client';
import { watchlist } from '@/lib/db/schema';
import { SearchService } from '@/lib/services/search';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';

async function main() {
  const args = process.argv.slice(2);
  const userIdFlag = args.indexOf('--user-id');
  const userIdOverride = userIdFlag >= 0 ? args[userIdFlag + 1] : null;
  const queryParts = args.filter((a, i) => a !== '--user-id' && args[i - 1] !== '--user-id');
  const query = queryParts.join(' ').trim();

  if (!query) {
    console.error('Usage: pnpm try-search "<query>" [--user-id <uuid>]');
    process.exit(2);
  }

  const db = getServiceDb();

  let userId = userIdOverride;
  if (!userId) {
    const candidates = await db
      .select({ uid: watchlist.userId, c: count() })
      .from(watchlist)
      .groupBy(watchlist.userId)
      .limit(1);
    if (candidates.length === 0) {
      console.error('No users with watchlists in DB. Pass --user-id <uuid> or add a watchlist first.');
      process.exit(2);
    }
    userId = candidates[0]!.uid;
    console.log(`(no --user-id given; using ${userId} which has ${candidates[0]!.c} watchlist tickers)`);
  }

  const svc = new SearchService({ db, provider: new EmbeddingsProviderImpl() });

  console.log(`\nQuerying: "${query}"…`);
  const t0 = Date.now();
  const results = await svc.searchAcrossWatchlist({ userId, query, limit: 10 });
  const elapsed = Date.now() - t0;

  console.log(`\n${results.length} results in ${elapsed}ms:\n`);
  for (const r of results) {
    const snippet = r.snippet.length > 200 ? r.snippet.slice(0, 200) + '…' : r.snippet;
    console.log(`  [${r.ticker} ${r.formType} ${r.filingDate}] ${r.sectionTitle} · cosine ${r.distance.toFixed(3)}`);
    console.log(`    ${snippet.replace(/\s+/g, ' ')}`);
    console.log();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('try-search failed:', err);
  process.exit(1);
});
