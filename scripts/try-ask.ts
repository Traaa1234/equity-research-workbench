#!/usr/bin/env tsx
/**
 * End-to-end smoke: `pnpm try-ask "<query>" [--ticker AAPL]`
 *
 * Runs RagService.answer() against the live Gemini API + local DB.
 * Prints the 8 sources and the streaming answer to stdout.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { count } from 'drizzle-orm';
import { getServiceDb } from '@/lib/db/client';
import { watchlist } from '@/lib/db/schema';
import { SearchService } from '@/lib/services/search';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';
import { RagService } from '@/lib/services/rag';
import { createGemini, GEMINI_MODEL } from '@/lib/providers/gemini';

async function main() {
  const args = process.argv.slice(2);
  const tickerFlag = args.indexOf('--ticker');
  const ticker = tickerFlag >= 0 ? args[tickerFlag + 1]?.toUpperCase() : null;
  const userIdFlag = args.indexOf('--user-id');
  const userIdOverride = userIdFlag >= 0 ? args[userIdFlag + 1] : null;
  const queryParts = args.filter((a, i) => {
    if (a === '--ticker' || a === '--user-id') return false;
    if (args[i - 1] === '--ticker' || args[i - 1] === '--user-id') return false;
    return true;
  });
  const query = queryParts.join(' ').trim();

  if (!query) {
    console.error('Usage: pnpm try-ask "<query>" [--ticker AAPL] [--user-id <uuid>]');
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
      console.error('No users with watchlists in DB. Pass --user-id <uuid> or seed first.');
      process.exit(2);
    }
    userId = candidates[0]!.uid;
    console.log(`(using user ${userId} with ${candidates[0]!.c} watched tickers)`);
  }

  const searchService = new SearchService({ db, provider: new EmbeddingsProviderImpl() });
  const gemini = createGemini();
  const model = gemini(GEMINI_MODEL);
  const rag = new RagService({ db, searchService, model });

  console.log(`\nQuerying: "${query}"${ticker ? ` (scope: ${ticker})` : ''}…`);

  const t0 = Date.now();
  const result = await rag.answer({
    userId,
    query,
    scope: ticker ? { type: 'ticker', ticker } : { type: 'watchlist' }
  });
  console.log(`\nRetrieved ${result.sources.length} sources in ${Date.now() - t0}ms`);

  console.log('\n--- Sources ---');
  for (const s of result.sources) {
    const snippet = s.snippet.length > 150 ? s.snippet.slice(0, 150) + '…' : s.snippet;
    console.log(`[${s.marker}] ${s.ticker} · ${s.formType} · ${s.filingDate} · ${s.sectionTitle} (cosine ${s.distance.toFixed(3)})`);
    console.log(`    ${snippet.replace(/\s+/g, ' ')}`);
  }

  console.log('\n--- Answer (streaming) ---');
  let accumulated = '';
  for await (const delta of result.streamResult.textStream) {
    process.stdout.write(delta);
    accumulated += delta;
  }
  console.log('\n--- End ---');

  const usage = await result.streamResult.usage;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cost = (inputTokens * 0.075 + outputTokens * 0.3) / 1_000_000;
  console.log(`\nTokens: ${inputTokens} in, ${outputTokens} out (~$${cost.toFixed(5)})`);

  await result.finalize(accumulated, { input: inputTokens, output: outputTokens });
  console.log(`Total elapsed: ${Date.now() - t0}ms`);

  process.exit(0);
}

main().catch((err) => {
  console.error('try-ask failed:', err);
  process.exit(1);
});
