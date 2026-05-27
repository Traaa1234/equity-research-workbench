#!/usr/bin/env tsx
/**
 * One-off: re-parse already-ingested filings with the current parser.
 * Usage: pnpm reparse <TICKER>
 *
 * Used when parser logic changes (Slice 3.5: table-aware text rendering).
 * Re-fetches HTML from SEC via the stored primaryDocUrl, runs the current
 * parser via SecEdgarProvider, transactionally overwrites filing_chunks +
 * deletes stale chunk_embeddings, then re-embeds via EmbeddingsService.
 *
 * Pre-existing alternatives:
 *   - scripts/try-filings.ts ingests NEW filings (no overwrite)
 *   - scripts/embed-existing.ts re-embeds existing chunks (no re-parse)
 * This script combines BOTH: re-parse + re-embed.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { eq } from 'drizzle-orm';
import { getServiceDb } from '@/lib/db/client';
import { filings, filingChunks, chunkEmbeddings } from '@/lib/db/schema';
import { FilingsService } from '@/lib/services/filings';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';
import { EmbeddingsService } from '@/lib/services/embeddings';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';

async function main() {
  const ticker = (process.argv[2] ?? '').toUpperCase();
  if (!/^[A-Z][A-Z.]{0,5}$/.test(ticker)) {
    console.error('Usage: pnpm reparse <TICKER>');
    process.exit(2);
  }

  const db = getServiceDb();
  const secProvider = new SecEdgarProviderImpl();
  const embeddingsProvider = new EmbeddingsProviderImpl();
  const filingsSvc = new FilingsService({ db, provider: secProvider });
  const embSvc = new EmbeddingsService({
    db,
    provider: embeddingsProvider,
    filingsService: filingsSvc
  });

  const rows = await db
    .select({
      accessionNo: filings.accessionNo,
      formType: filings.formType,
      filingDate: filings.filingDate,
      primaryDocUrl: filings.primaryDocUrl
    })
    .from(filings)
    .where(eq(filings.ticker, ticker));

  if (rows.length === 0) {
    console.error(`No filings in DB for ${ticker}. Ingest first via "pnpm try-filings ${ticker}".`);
    process.exit(2);
  }

  console.log(`Re-parsing ${rows.length} ${ticker} filings…\n`);

  let totalSections = 0;
  let totalEmbeddings = 0;
  let failed = 0;
  const overallT0 = Date.now();

  for (const r of rows) {
    const t0 = Date.now();
    try {
      const parsed = await secProvider.fetchFiling(r.primaryDocUrl, r.formType);
      if (parsed.sections.length === 0) {
        console.error(`  [${r.formType} ${r.filingDate}] ${r.accessionNo} → no sections parsed (SKIP)`);
        failed++;
        continue;
      }

      // Transactional: delete old chunks + their embeddings, insert fresh chunks.
      // Embeddings deleted explicitly because there's no FK cascade between them.
      await db.transaction(async (tx) => {
        await tx.delete(chunkEmbeddings).where(eq(chunkEmbeddings.filingId, r.accessionNo));
        await tx.delete(filingChunks).where(eq(filingChunks.filingId, r.accessionNo));
        await tx.insert(filingChunks).values(
          parsed.sections.map((s) => ({
            filingId: r.accessionNo,
            sectionKey: s.section_key,
            sectionTitle: s.section_title,
            text: s.text,
            charCount: s.text.length,
            charOffsetStart: s.char_offset_start,
            charOffsetEnd: s.char_offset_end
          }))
        );
      });

      // Re-embed OUTSIDE the transaction (slow API call; idempotent via ON CONFLICT DO NOTHING)
      const embedResult = await embSvc.embedFiling(r.accessionNo);

      const elapsed = Date.now() - t0;
      console.log(
        `  [${r.formType} ${r.filingDate}] ${r.accessionNo} → ${parsed.sections.length} sections, ${embedResult.count} chunks (${elapsed}ms)`
      );
      totalSections += parsed.sections.length;
      totalEmbeddings += embedResult.count;
    } catch (err) {
      failed++;
      console.error(`  [${r.formType} ${r.filingDate}] ${r.accessionNo} → FAILED: ${err}`);
    }
  }

  const overallElapsed = Date.now() - overallT0;
  console.log(
    `\nDone. ${totalSections} sections re-parsed + ${totalEmbeddings} embeddings rewritten across ${rows.length - failed}/${rows.length} filings in ${overallElapsed}ms.`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('reparse failed:', err);
  process.exit(1);
});
