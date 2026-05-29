#!/usr/bin/env tsx
/**
 * One-shot universe seeder for the discovery feature.
 * Re-runnable; idempotent. Logs progress every 100 tickers.
 *
 * Usage: pnpm seed-universe
 *
 * Phase 1 (this file): skeleton merge from Nasdaq screener + ETF holdings.
 * Phases 2-4 (T9): yfinance enrichment, batch embed, upsert.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { sql as drizzleSql } from 'drizzle-orm';
import { getServiceDb } from '@/lib/db/client';
import { companiesUniverse } from '@/lib/db/schema';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';

// ----- Public types -----

export interface SkeletonRow {
  ticker: string;
  name: string;
  exchange: string | null;
  country: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: string | null;
  sources: string[];
}

export interface EnrichedRow extends SkeletonRow {
  description: string | null;
}

export interface EmbeddedRow extends EnrichedRow {
  embedding: number[] | null;
}

interface YfInfoLike {
  info(ticker: string): Promise<{
    longBusinessSummary: string | null;
    country: string | null;
    sector: string | null;
    industry: string | null;
    exchange: string | null;
    marketCap: number | null;
    longName: string | null;
  }>;
}

interface EmbProviderLike {
  embed(req: { model: string; texts: string[] }): Promise<{ vectors: number[][]; inputTokens: number }>;
}

interface RawRow {
  ticker: string;
  name: string;
  country: string | null;
  sector: string | null;
  industry: string | null;
  exchange: string | null;
  marketCap: string | null;
  source: string;
}

interface BuildOptions {
  fetch?: typeof fetch;
  etfs?: Array<{ id: string; issuer: 'ishares' | 'ark' | 'sectorspdr' | 'vaneck' | 'unknown'; url: string }>;
}

// ----- Curated ETF list -----

export const DEFAULT_ETFS = [
  { id: 'BOTZ', issuer: 'ishares' as const, url: 'https://www.ishares.com/us/products/239738/ishares-robotics-and-artificial-intelligence-multisector-etf/1467271812596.ajax?fileType=csv&fileName=BOTZ_holdings&dataType=fund' },
  { id: 'KWEB', issuer: 'ishares' as const, url: 'https://www.ishares.com/us/products/271281/kraneshares-csi-china-internet-etf/1467271812596.ajax?fileType=csv&fileName=KWEB_holdings&dataType=fund' },
  { id: 'EWZ',  issuer: 'ishares' as const, url: 'https://www.ishares.com/us/products/239630/ishares-msci-brazil-etf/1467271812596.ajax?fileType=csv&fileName=EWZ_holdings&dataType=fund' },
  { id: 'ARKK', issuer: 'ark' as const,     url: 'https://ark-funds.com/wp-content/uploads/funds-etf-csv/ARK_INNOVATION_ETF_ARKK_HOLDINGS.csv' },
  { id: 'ARKQ', issuer: 'ark' as const,     url: 'https://ark-funds.com/wp-content/uploads/funds-etf-csv/ARK_AUTONOMOUS_TECHNOLOGY_&_ROBOTICS_ETF_ARKQ_HOLDINGS.csv' },
  { id: 'ARKW', issuer: 'ark' as const,     url: 'https://ark-funds.com/wp-content/uploads/funds-etf-csv/ARK_NEXT_GENERATION_INTERNET_ETF_ARKW_HOLDINGS.csv' },
  { id: 'ARKG', issuer: 'ark' as const,     url: 'https://ark-funds.com/wp-content/uploads/funds-etf-csv/ARK_GENOMIC_REVOLUTION_ETF_ARKG_HOLDINGS.csv' },
  { id: 'SOXX', issuer: 'ishares' as const, url: 'https://www.ishares.com/us/products/239705/ishares-phlx-semiconductor-etf/1467271812596.ajax?fileType=csv&fileName=SOXX_holdings&dataType=fund' },
  { id: 'SMH',  issuer: 'vaneck' as const,  url: 'https://www.vaneck.com/etf/equity/smh/holdings/' },
  { id: 'XLK',  issuer: 'sectorspdr' as const, url: 'https://www.sectorspdrs.com/sectorspdr/IDCO.Client.Spdrs.Holdings/Export/ExcelExport?symbol=XLK' },
  { id: 'XBI',  issuer: 'sectorspdr' as const, url: 'https://www.sectorspdrs.com/sectorspdr/IDCO.Client.Spdrs.Holdings/Export/ExcelExport?symbol=XBI' },
  { id: 'ITA',  issuer: 'ishares' as const, url: 'https://www.ishares.com/us/products/239502/ishares-us-aerospace-defense-etf/1467271812596.ajax?fileType=csv&fileName=ITA_holdings&dataType=fund' }
];

// ----- Country name normalization -----

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  'United States': 'US', 'USA': 'US', 'US': 'US',
  'Brazil': 'BR', 'BR': 'BR',
  'China': 'CN', 'CN': 'CN',
  'Japan': 'JP', 'JP': 'JP',
  'United Kingdom': 'GB', 'UK': 'GB', 'GB': 'GB',
  'Germany': 'DE', 'DE': 'DE',
  'France': 'FR', 'FR': 'FR',
  'India': 'IN', 'IN': 'IN',
  'Taiwan': 'TW', 'TW': 'TW',
  'South Korea': 'KR', 'Korea': 'KR', 'KR': 'KR',
  'Hong Kong': 'HK', 'HK': 'HK',
  'Mexico': 'MX', 'MX': 'MX',
  'Italy': 'IT', 'IT': 'IT',
  'Spain': 'ES', 'ES': 'ES'
};

export function normalizeCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return COUNTRY_NAME_TO_CODE[trimmed] ?? (trimmed.length === 2 ? trimmed.toUpperCase() : null);
}

// ----- Source fetchers -----

async function fetchNasdaqScreener(exchange: 'NYSE' | 'NASDAQ', fetchImpl: typeof fetch): Promise<RawRow[]> {
  const url = `https://api.nasdaq.com/api/screener/stocks?download=true&exchange=${exchange}`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 EquityResearchWorkbench/1.0' }
  } as any);
  if (!res.ok) {
    throw new Error(`Nasdaq screener ${exchange} fetch failed: ${res.status}`);
  }
  const json = await res.json() as any;
  const rows: any[] = json?.data?.table?.rows ?? json?.data?.rows ?? [];
  return rows.map((r) => ({
    ticker: String(r.symbol ?? '').toUpperCase().trim(),
    name: String(r.name ?? ''),
    country: normalizeCountry(r.country),
    sector: r.sector ?? null,
    industry: r.industry ?? null,
    exchange,
    marketCap: r.marketCap ? String(r.marketCap).replace(/[$,]/g, '') : null,
    source: exchange.toLowerCase()
  })).filter((r) => r.ticker && /^[A-Z][A-Z.]{0,5}$/.test(r.ticker));
}

async function fetchIsharesEtf(etfId: string, url: string, fetchImpl: typeof fetch): Promise<RawRow[]> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 EquityResearchWorkbench/1.0' }
  } as any);
  if (!res.ok) throw new Error(`ETF ${etfId} fetch failed: ${res.status}`);
  const text = await res.text();
  return parseIsharesCsv(text, etfId);
}

async function fetchArkEtf(etfId: string, url: string, fetchImpl: typeof fetch): Promise<RawRow[]> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 EquityResearchWorkbench/1.0' }
  } as any);
  if (!res.ok) throw new Error(`ETF ${etfId} fetch failed: ${res.status}`);
  const text = await res.text();
  return parseArkCsv(text, etfId);
}

// ----- ETF CSV parsers -----

export function parseIsharesCsv(text: string, etfId: string): RawRow[] {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.toLowerCase().includes('ticker') && l.toLowerCase().includes('name'));
  if (headerIdx < 0) return [];
  const header = parseCsvRow(lines[headerIdx]!);
  const tickerCol = header.findIndex((h) => /^ticker$/i.test(h));
  const nameCol = header.findIndex((h) => /^name$/i.test(h));
  if (tickerCol < 0) return [];
  const out: RawRow[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    const cols = parseCsvRow(line);
    const ticker = (cols[tickerCol] ?? '').toUpperCase().trim();
    if (!ticker || !/^[A-Z][A-Z.]{0,5}$/.test(ticker)) continue;
    const name = nameCol >= 0 ? (cols[nameCol] ?? '') : '';
    out.push({
      ticker, name,
      country: null, sector: null, industry: null,
      exchange: null, marketCap: null,
      source: `etf:${etfId}`
    });
  }
  return out;
}

export function parseArkCsv(text: string, etfId: string): RawRow[] {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = parseCsvRow(lines[0]!);
  const tickerCol = header.findIndex((h) => /ticker/i.test(h));
  const nameCol = header.findIndex((h) => /company/i.test(h));
  if (tickerCol < 0) return [];
  const out: RawRow[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = parseCsvRow(line);
    const ticker = (cols[tickerCol] ?? '').toUpperCase().trim();
    if (!ticker || !/^[A-Z][A-Z.]{0,5}$/.test(ticker)) continue;
    const name = nameCol >= 0 ? (cols[nameCol] ?? '') : '';
    out.push({
      ticker, name,
      country: null, sector: null, industry: null,
      exchange: null, marketCap: null,
      source: `etf:${etfId}`
    });
  }
  return out;
}

function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// ----- Merge logic -----

export function mergeSources(rows: RawRow[]): Map<string, SkeletonRow> {
  const merged = new Map<string, SkeletonRow>();
  for (const row of rows) {
    const ticker = row.ticker.toUpperCase();
    if (!ticker) continue;
    const existing = merged.get(ticker);
    if (!existing) {
      merged.set(ticker, {
        ticker, name: row.name,
        exchange: row.exchange, country: row.country, sector: row.sector, industry: row.industry,
        marketCap: row.marketCap, sources: [row.source]
      });
    } else {
      if (!existing.sources.includes(row.source)) existing.sources.push(row.source);
      existing.exchange ??= row.exchange;
      existing.country ??= row.country;
      existing.sector ??= row.sector;
      existing.industry ??= row.industry;
      existing.marketCap ??= row.marketCap;
    }
  }
  return merged;
}

// ----- Phase 2: yfinance enrichment -----

export async function enrichWithYfinance(
  skeleton: Map<string, SkeletonRow>,
  yf: YfInfoLike,
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, EnrichedRow>> {
  const out = new Map<string, EnrichedRow>();
  let done = 0;
  for (const [ticker, row] of skeleton) {
    let info: Awaited<ReturnType<YfInfoLike['info']>> | null = null;
    try {
      info = await yf.info(ticker);
    } catch {
      // delisted/malformed — fall through with skeleton-only row
    }
    out.set(ticker, {
      ...row,
      name: info?.longName ?? row.name,
      description: info?.longBusinessSummary ?? null,
      country: normalizeCountry(info?.country ?? null) ?? row.country,
      sector: info?.sector ?? row.sector,
      industry: info?.industry ?? row.industry,
      exchange: info?.exchange ?? row.exchange,
      marketCap: info?.marketCap != null ? String(info.marketCap) : row.marketCap
    });
    done++;
    if (onProgress && done % 100 === 0) onProgress(done, skeleton.size);
  }
  return out;
}

// ----- Phase 3: batch embed descriptions -----

const EMBED_BATCH = 25;

export async function batchEmbedDescriptions(
  enriched: Map<string, EnrichedRow>,
  emb: EmbProviderLike,
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, EmbeddedRow>> {
  const withEmbeddable = Array.from(enriched.entries()).filter(([, r]) => r.description && r.description.trim().length > 0);
  const out = new Map<string, EmbeddedRow>();
  for (const [t, r] of enriched) {
    if (!r.description || !r.description.trim()) out.set(t, { ...r, embedding: null });
  }
  for (let i = 0; i < withEmbeddable.length; i += EMBED_BATCH) {
    const batch = withEmbeddable.slice(i, i + EMBED_BATCH);
    const result = await emb.embed({
      model: 'text-embedding-v4',
      texts: batch.map(([, r]) => r.description!)
    });
    for (let j = 0; j < batch.length; j++) {
      const [ticker, row] = batch[j]!;
      const vec = result.vectors[j];
      out.set(ticker, { ...row, embedding: vec ?? null });
    }
    if (onProgress) onProgress(Math.min(i + EMBED_BATCH, withEmbeddable.length), withEmbeddable.length);
  }
  return out;
}

// ----- Phase 4: upsert into companies_universe -----

export async function upsertUniverse(
  embedded: Map<string, EmbeddedRow>
): Promise<{ inserted: number; skipped: number }> {
  const db = getServiceDb();
  let inserted = 0;
  let skipped = 0;
  const allRows = Array.from(embedded.values());

  const CHUNK = 100;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    const chunk = allRows.slice(i, i + CHUNK);
    const values = chunk.map((r) => ({
      ticker: r.ticker,
      name: r.name,
      exchange: r.exchange,
      country: r.country,
      sector: r.sector,
      industry: r.industry,
      description: r.description,
      descriptionEmbedding: r.embedding,
      marketCap: r.marketCap,
      sources: r.sources,
      lastRefreshedAt: new Date()
    }));
    try {
      await db.insert(companiesUniverse).values(values).onConflictDoUpdate({
        target: companiesUniverse.ticker,
        set: {
          name: drizzleSql`excluded.name`,
          exchange: drizzleSql`excluded.exchange`,
          country: drizzleSql`excluded.country`,
          sector: drizzleSql`excluded.sector`,
          industry: drizzleSql`excluded.industry`,
          description: drizzleSql`excluded.description`,
          descriptionEmbedding: drizzleSql`excluded.description_embedding`,
          marketCap: drizzleSql`excluded.market_cap`,
          sources: drizzleSql`excluded.sources`,
          lastRefreshedAt: drizzleSql`excluded.last_refreshed_at`
        }
      });
      inserted += chunk.length;
    } catch (err) {
      console.warn(`  upsert chunk ${i / CHUNK} failed: ${String(err)}`);
      skipped += chunk.length;
    }
  }
  return { inserted, skipped };
}

// ----- Chunked orchestrator (enrich → embed → upsert per chunk) -----

const CHUNK_SIZE = 100;

export interface ChunkedProgress {
  chunksDone: number;
  chunksTotal: number;
  totalProcessed: number;
  totalSucceeded: number;       // count with non-null description
  totalEmbedded: number;
  totalUpserted: number;
}

/**
 * Process the skeleton in 100-ticker chunks: enrich → embed → upsert → repeat.
 * Discover queries start returning results once the first chunk lands, instead
 * of waiting for the whole 6500-ticker crawl to finish.
 */
/**
 * Sort tickers by market cap descending so big-name companies (AAPL, NVDA,
 * MSFT, BABA, …) land in the first chunks. Tickers with unknown / zero
 * market cap go to the end. Returns ticker strings sorted in process order.
 */
export function tickersByMarketCapDesc(skeleton: Map<string, SkeletonRow>): string[] {
  const entries = Array.from(skeleton.entries());
  entries.sort(([, a], [, b]) => {
    const aCap = a.marketCap == null ? 0 : Number(a.marketCap);
    const bCap = b.marketCap == null ? 0 : Number(b.marketCap);
    if (!Number.isFinite(aCap) && !Number.isFinite(bCap)) return 0;
    if (!Number.isFinite(aCap)) return 1;
    if (!Number.isFinite(bCap)) return -1;
    return bCap - aCap;
  });
  return entries.map(([t]) => t);
}

export async function enrichEmbedUpsertChunked(
  skeleton: Map<string, SkeletonRow>,
  yf: YfInfoLike,
  emb: EmbProviderLike,
  onProgress?: (p: ChunkedProgress) => void
): Promise<ChunkedProgress> {
  // Process biggest-cap names first so discover queries become useful within
  // the first chunk or two instead of waiting for the alphabetical-A
  // warrants/units cluster to clear.
  const tickers = tickersByMarketCapDesc(skeleton);
  const totals: ChunkedProgress = {
    chunksDone: 0,
    chunksTotal: Math.ceil(tickers.length / CHUNK_SIZE),
    totalProcessed: 0,
    totalSucceeded: 0,
    totalEmbedded: 0,
    totalUpserted: 0
  };

  for (let i = 0; i < tickers.length; i += CHUNK_SIZE) {
    const chunkTickers = tickers.slice(i, i + CHUNK_SIZE);
    const chunkSkeleton = new Map<string, SkeletonRow>();
    for (const t of chunkTickers) {
      const row = skeleton.get(t);
      if (row) chunkSkeleton.set(t, row);
    }

    // Enrich this chunk
    const enriched = await enrichWithYfinance(chunkSkeleton, yf);
    const descCount = Array.from(enriched.values()).filter((r) => r.description).length;

    // Embed this chunk
    const embedded = await batchEmbedDescriptions(enriched, emb);
    const embCount = Array.from(embedded.values()).filter((r) => r.embedding).length;

    // Upsert this chunk
    const { inserted } = await upsertUniverse(embedded);

    totals.chunksDone++;
    totals.totalProcessed += chunkTickers.length;
    totals.totalSucceeded += descCount;
    totals.totalEmbedded += embCount;
    totals.totalUpserted += inserted;

    if (onProgress) onProgress({ ...totals });
  }

  return totals;
}

// ----- Orchestrator -----

export async function buildSkeleton(opts: BuildOptions = {}): Promise<Map<string, SkeletonRow>> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const etfs = opts.etfs ?? DEFAULT_ETFS;

  const allRows: RawRow[] = [];

  for (const exch of ['NYSE', 'NASDAQ'] as const) {
    try {
      const rows = await fetchNasdaqScreener(exch, fetchImpl);
      allRows.push(...rows);
      console.log(`  [${exch}] fetched ${rows.length} rows`);
    } catch (err) {
      console.warn(`  [${exch}] fetch failed: ${String(err)}`);
    }
  }

  for (const etf of etfs) {
    try {
      let rows: RawRow[] = [];
      if (etf.issuer === 'ishares' || etf.issuer === 'sectorspdr' || etf.issuer === 'vaneck') {
        rows = await fetchIsharesEtf(etf.id, etf.url, fetchImpl);
      } else if (etf.issuer === 'ark') {
        rows = await fetchArkEtf(etf.id, etf.url, fetchImpl);
      }
      allRows.push(...rows);
      console.log(`  [etf:${etf.id}] fetched ${rows.length} rows`);
    } catch (err) {
      console.warn(`  [etf:${etf.id}] fetch failed: ${String(err)}`);
    }
  }

  return mergeSources(allRows);
}

// ----- CLI entry -----

async function main() {
  console.log('Phase 1: building skeleton from public sources...');
  const skeleton = await buildSkeleton();
  console.log(`  → ${skeleton.size} unique tickers`);

  console.log('\nPhases 2-4 (chunked): enrich → embed → upsert in batches of 100...');
  console.log('  → discover queries become available as chunks land');

  const yf = new YFinanceProvider();
  const emb = new EmbeddingsProviderImpl();
  const t0 = Date.now();
  const totals = await enrichEmbedUpsertChunked(skeleton, yf as any, emb as any, (p) => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    const pctDone = ((p.chunksDone / p.chunksTotal) * 100).toFixed(0);
    console.log(
      `  [${pctDone}%] chunk ${p.chunksDone}/${p.chunksTotal} | ` +
      `processed=${p.totalProcessed} desc=${p.totalSucceeded} embedded=${p.totalEmbedded} upserted=${p.totalUpserted} | ` +
      `${elapsed}s elapsed`
    );
  });

  console.log('\nDone.');
  console.log(`  processed: ${totals.totalProcessed}`);
  console.log(`  with description: ${totals.totalSucceeded}`);
  console.log(`  embedded: ${totals.totalEmbedded}`);
  console.log(`  upserted: ${totals.totalUpserted}`);
  process.exit(0);
}

// Tsx normalizes paths so the strict import.meta.url === file://argv[1] match
// can fail on Windows; check via filename suffix instead so the script always
// runs when invoked via `pnpm seed-universe`.
if (process.argv[1] && /seed-universe\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error('seed-universe failed:', err);
    process.exit(1);
  });
}
