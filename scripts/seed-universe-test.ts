#!/usr/bin/env tsx
/**
 * Tiny test seeder: 50 hand-picked tickers, skips Phase 1 entirely.
 * Used to validate Phases 2-4 end-to-end without the 6,500-row crawl.
 *
 * Usage: pnpm exec tsx scripts/seed-universe-test.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { YFinanceProvider } from '@/lib/providers/yfinance';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';
import {
  enrichWithYfinance,
  batchEmbedDescriptions,
  upsertUniverse,
  type SkeletonRow
} from './seed-universe';

// 50 hand-picked tickers spanning the three sample-query categories
const TEST_TICKERS: Array<[string, string, string]> = [
  // AI infrastructure
  ['NVDA',  'NVIDIA Corporation',                 'US'],
  ['AVGO',  'Broadcom Inc.',                      'US'],
  ['AMD',   'Advanced Micro Devices, Inc.',       'US'],
  ['TSM',   'Taiwan Semiconductor Manufacturing', 'TW'],
  ['MU',    'Micron Technology, Inc.',            'US'],
  ['ANET',  'Arista Networks, Inc.',              'US'],
  ['SMCI',  'Super Micro Computer, Inc.',         'US'],
  ['ARM',   'Arm Holdings plc',                   'GB'],
  ['ASML',  'ASML Holding N.V.',                  'NL'],
  ['VRT',   'Vertiv Holdings Co',                 'US'],
  // Big tech / mega caps
  ['AAPL',  'Apple Inc.',                         'US'],
  ['MSFT',  'Microsoft Corporation',              'US'],
  ['GOOGL', 'Alphabet Inc. Class A',              'US'],
  ['AMZN',  'Amazon.com, Inc.',                   'US'],
  ['META',  'Meta Platforms, Inc.',               'US'],
  ['TSLA',  'Tesla, Inc.',                        'US'],
  ['NFLX',  'Netflix, Inc.',                      'US'],
  // Chinese internet ADRs
  ['BABA',  'Alibaba Group Holding Limited',      'CN'],
  ['JD',    'JD.com, Inc.',                       'CN'],
  ['PDD',   'PDD Holdings Inc.',                  'CN'],
  ['BIDU',  'Baidu, Inc.',                        'CN'],
  ['NTES',  'NetEase, Inc.',                      'CN'],
  ['TCOM',  'Trip.com Group Limited',             'CN'],
  ['BILI',  'Bilibili Inc.',                      'CN'],
  ['IQ',    'iQIYI, Inc.',                        'CN'],
  // Brazilian ADRs (CPG + others)
  ['ABEV',  'Ambev S.A.',                         'BR'],
  ['NTCO',  'Natura & Co Holding S.A.',           'BR'],
  ['PBR',   'Petroleo Brasileiro S.A.',           'BR'],
  ['VALE',  'Vale S.A.',                          'BR'],
  ['ITUB',  'Itau Unibanco Holding S.A.',         'BR'],
  ['BBD',   'Banco Bradesco S.A.',                'BR'],
  ['XP',    'XP Inc.',                            'BR'],
  ['ERJ',   'Embraer S.A.',                       'BR'],
  // Healthcare AI / biotech
  ['ISRG',  'Intuitive Surgical, Inc.',           'US'],
  ['VEEV',  'Veeva Systems Inc.',                 'US'],
  ['TMDX',  'TransMedics Group, Inc.',            'US'],
  ['EXAS',  'Exact Sciences Corporation',         'US'],
  // Financials
  ['JPM',   'JPMorgan Chase & Co.',               'US'],
  ['BRK.B', 'Berkshire Hathaway Inc.',            'US'],
  ['V',     'Visa Inc.',                          'US'],
  ['MA',    'Mastercard Incorporated',            'US'],
  // Energy / industrials
  ['XOM',   'Exxon Mobil Corporation',            'US'],
  ['CAT',   'Caterpillar Inc.',                   'US'],
  ['BA',    'The Boeing Company',                 'US'],
  // CPG (consumer defensive)
  ['KO',    'The Coca-Cola Company',              'US'],
  ['PG',    'The Procter & Gamble Company',       'US'],
  ['UNH',   'UnitedHealth Group Incorporated',    'US'],
  // Japan / Korea ADRs
  ['TM',    'Toyota Motor Corporation',           'JP'],
  ['SONY',  'Sony Group Corporation',             'JP'],
  ['HMC',   'Honda Motor Co., Ltd.',              'JP']
];

async function main() {
  console.log(`Test seeder: ${TEST_TICKERS.length} hand-picked tickers`);
  console.log('Skipping Phase 1; building skeleton directly from hardcoded list.\n');

  // Build a minimal skeleton from the hardcoded list
  const skeleton = new Map<string, SkeletonRow>();
  for (const [ticker, name, country] of TEST_TICKERS) {
    skeleton.set(ticker, {
      ticker, name,
      country,
      exchange: country === 'US' || country === 'CN' || country === 'BR' || country === 'TW' || country === 'JP' || country === 'KR'
        ? (ticker.length <= 4 ? 'NYSE' : 'NASDAQ')  // rough guess; yfinance will overwrite
        : 'NASDAQ',
      sector: null,
      industry: null,
      marketCap: null,
      sources: ['test:hand_picked']
    });
  }

  console.log('Phase 2: enriching with yfinance .info()...');
  const yf = new YFinanceProvider();
  const t0 = Date.now();
  let enrichedCount = 0;
  const enriched = await enrichWithYfinance(skeleton, yf as any, (done, total) => {
    enrichedCount = done;
    if (done % 10 === 0) console.log(`  ${done}/${total} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  });
  const descCount = Array.from(enriched.values()).filter((r) => r.description).length;
  console.log(`  → ${descCount}/${enriched.size} have descriptions (${((Date.now() - t0) / 1000).toFixed(0)}s elapsed)\n`);

  console.log('Phase 3: batch-embedding descriptions...');
  const emb = new EmbeddingsProviderImpl();
  const embedded = await batchEmbedDescriptions(enriched, emb as any, (done, total) => {
    console.log(`  embed ${done}/${total}`);
  });
  const embeddedCount = Array.from(embedded.values()).filter((r) => r.embedding).length;
  console.log(`  → ${embeddedCount} embedded\n`);

  console.log('Phase 4: upserting...');
  const { inserted, skipped } = await upsertUniverse(embedded);
  console.log(`  → upserted ${inserted}, skipped ${skipped}`);

  console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error('test seeder failed:', err);
  console.error(err.stack);
  process.exit(1);
});
