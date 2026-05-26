#!/usr/bin/env tsx
/**
 * End-to-end smoke: `pnpm try-summarize AAPL <accession>`
 *
 * Pulls a filing's section text from the local Postgres (the filing must
 * already be ingested via Slice 2A), assembles the prompt, calls Qwen, and
 * prints the summary + token counts. Used for prompt iteration before
 * locking prompt_version = 'v1' into lib/services/summaries.ts.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { eq } from 'drizzle-orm';
import { getServiceDb } from '@/lib/db/client';
import { companies, filings, filingChunks } from '@/lib/db/schema';
import { QwenProviderImpl } from '@/lib/providers/qwen';

const SYSTEM_PROMPT = `You are a senior equity research analyst writing concise investor briefings on SEC filings.
Your output is read by investors who want the signal, not the boilerplate. Be specific:
quote numbers and names directly from the filing when they support the point. Avoid hedging
language ("the company believes…", "it appears…"). Do not invent facts not in the source.`;

function buildUserPrompt(meta: {
  ticker: string;
  companyName: string;
  formType: string;
  filingDate: string;
  periodEnd: string | null;
}, sections: Array<{ sectionTitle: string; text: string }>): string {
  const filingText = sections.map((s) => `=== ${s.sectionTitle} ===\n${s.text}`).join('\n\n');

  return `Below is the text of an SEC filing. Produce a structured briefing in this EXACT markdown format:

## What they do
[1-2 sentences. The business in plain English. No marketing language.]

## This period's highlights
- [Specific revenue/margin/segment numbers from MD&A. 2-3 bullets.]
- [If guidance changed, say so.]
- [If there's a material event (acquisition, restructure, lawsuit), include it.]

## Key risks
- [The 2-3 most material risks from Risk Factors. Specific risks tied to this company, not generic boilerplate like "competition" or "regulation in general".]

## Bottom line
[One sentence: what an investor should take away from this filing.]

Filing context:
- Ticker: ${meta.ticker}
- Company: ${meta.companyName}
- Form: ${meta.formType}
- Filed: ${meta.filingDate}
- Period ending: ${meta.periodEnd ?? '—'}

Filing text follows:
---
${filingText}
---`;
}

async function main() {
  const ticker = (process.argv[2] ?? '').toUpperCase();
  const accession = process.argv[3] ?? '';
  if (!/^[A-Z][A-Z.]{0,5}$/.test(ticker) || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) {
    console.error('Usage: pnpm try-summarize <TICKER> <ACCESSION>');
    console.error('  e.g. pnpm try-summarize AAPL 0000320193-25-000123');
    process.exit(2);
  }

  const db = getServiceDb();

  const companyRows = await db.select().from(companies).where(eq(companies.ticker, ticker)).limit(1);
  if (companyRows.length === 0) {
    console.error(`Company ${ticker} not in DB. Add via /api/tickers/add first.`);
    process.exit(2);
  }
  const company = companyRows[0]!;

  const filingRows = await db.select().from(filings).where(eq(filings.accessionNo, accession)).limit(1);
  if (filingRows.length === 0) {
    console.error(`Filing ${accession} not ingested. Run pnpm try-filings ${ticker} first.`);
    process.exit(2);
  }
  const filing = filingRows[0]!;

  const chunks = await db
    .select({ sectionKey: filingChunks.sectionKey, sectionTitle: filingChunks.sectionTitle, text: filingChunks.text })
    .from(filingChunks)
    .where(eq(filingChunks.filingId, accession))
    .orderBy(filingChunks.id);

  if (chunks.length === 0) {
    console.error(`Filing ${accession} has no parsed chunks. Re-ingest via the Filings page.`);
    process.exit(2);
  }

  console.log(`\n[${filing.formType} ${filing.filingDate}] ${ticker} ${accession}`);
  console.log(`Sections: ${chunks.map((c) => c.sectionTitle).join(', ')}`);
  const totalChars = chunks.reduce((sum, c) => sum + c.text.length, 0);
  console.log(`Total chars: ${totalChars}`);

  const userPrompt = buildUserPrompt(
    { ticker, companyName: company.name, formType: filing.formType, filingDate: filing.filingDate, periodEnd: filing.periodEnd },
    chunks
  );

  console.log(`\nCalling qwen-plus…`);
  const t0 = Date.now();
  const provider = new QwenProviderImpl();
  const result = await provider.summarize({
    model: 'qwen-plus',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 800
  });
  const elapsed = Date.now() - t0;

  console.log(`\n--- Briefing (${elapsed}ms, ${result.inputTokens} in, ${result.outputTokens} out) ---`);
  console.log(result.text);
  console.log(`\n--- End ---`);
  process.exit(0);
}

main().catch((err) => {
  console.error('try-summarize failed:', err);
  process.exit(1);
});
