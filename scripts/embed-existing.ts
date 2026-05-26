#!/usr/bin/env tsx
/**
 * One-off: embed already-ingested filings for a ticker.
 * Usage: pnpm exec tsx scripts/embed-existing.ts AAPL
 *
 * Hits ONLY DashScope embeddings — bypasses SEC EDGAR and Financial Datasets.
 * Useful when filings are already in DB (from earlier slices) but chunk_embeddings
 * hasn't been populated yet (Slice 2C added embedding to the ingest path, but
 * older filings predate that).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { eq } from 'drizzle-orm';
import { getServiceDb } from '@/lib/db/client';
import { filings } from '@/lib/db/schema';
import { FilingsService } from '@/lib/services/filings';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';
import { EmbeddingsService } from '@/lib/services/embeddings';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';

async function main() {
  const ticker = (process.argv[2] ?? '').toUpperCase();
  if (!/^[A-Z][A-Z.]{0,5}$/.test(ticker)) {
    console.error('Usage: pnpm exec tsx scripts/embed-existing.ts <TICKER>');
    process.exit(2);
  }

  const db = getServiceDb();
  const filingsSvc = new FilingsService({ db, provider: new SecEdgarProviderImpl() });
  const embSvc = new EmbeddingsService({
    db,
    provider: new EmbeddingsProviderImpl(),
    filingsService: filingsSvc
  });

  const rows = await db
    .select({ accessionNo: filings.accessionNo, formType: filings.formType, filingDate: filings.filingDate })
    .from(filings)
    .where(eq(filings.ticker, ticker));

  if (rows.length === 0) {
    console.error(`No filings in DB for ${ticker}. Run pnpm try-filings ${ticker} first.`);
    process.exit(2);
  }

  console.log(`Embedding ${rows.length} ${ticker} filings…\n`);

  let totalChunks = 0;
  let failed = 0;
  const overallT0 = Date.now();

  for (const r of rows) {
    const t0 = Date.now();
    try {
      const result = await embSvc.embedFiling(r.accessionNo);
      const elapsed = Date.now() - t0;
      const status = result.count === 0 ? '(already embedded)' : `${result.count} chunks`;
      console.log(`  [${r.formType} ${r.filingDate}] ${r.accessionNo} → ${status} (${elapsed}ms)`);
      totalChunks += result.count;
    } catch (err) {
      failed++;
      const elapsed = Date.now() - t0;
      console.error(`  [${r.formType} ${r.filingDate}] ${r.accessionNo} → FAILED (${elapsed}ms): ${err}`);
    }
  }

  const overallElapsed = Date.now() - overallT0;
  console.log(
    `\nDone. ${totalChunks} new chunks across ${rows.length - failed}/${rows.length} filings in ${overallElapsed}ms.`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('embed-existing failed:', err);
  process.exit(1);
});
