#!/usr/bin/env tsx
/**
 * End-to-end smoke test: `pnpm try-filings AAPL`
 *
 * Resolves CIK, lists 10-K + 10-Q for last 5y, fetches+parses each,
 * prints per-filing section counts and the first 100 chars of MD&A.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';

async function main() {
  const ticker = (process.argv[2] ?? '').toUpperCase();
  if (!/^[A-Z][A-Z.]{0,5}$/.test(ticker)) {
    console.error('Usage: pnpm try-filings <TICKER>');
    process.exit(2);
  }

  const provider = new SecEdgarProviderImpl({ useHttp: false });

  console.log(`\nResolving CIK for ${ticker}…`);
  const cik = await provider.resolveCik(ticker);
  console.log(`  CIK: ${cik}`);

  console.log(`\nListing 10-K + 10-Q filings (last 5Y)…`);
  const list = await provider.listFilings(cik, ['10-K', '10-Q'], 5);
  console.log(`  ${list.filings.length} filings`);

  for (const f of list.filings.slice(0, 5)) {
    console.log(`\n[${f.formType} ${f.filingDate}] ${f.accessionNo}`);
    try {
      const full = await provider.fetchFiling(f.primaryDocUrl, f.formType);
      console.log(`  ${full.sections.length} sections, ${full.totalChars} total chars`);
      for (const s of full.sections) {
        console.log(`    • ${s.section_title} (${s.text.length} chars)`);
      }
      const mdna = full.sections.find((s) => s.section_key.endsWith('mdna'));
      if (mdna) {
        const preview = mdna.text.slice(0, 100).replace(/\s+/g, ' ');
        console.log(`  MD&A preview: ${preview}…`);
      }
    } catch (err) {
      console.error(`  FAILED: ${err}`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('try-filings failed:', err);
  process.exit(1);
});
