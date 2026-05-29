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
  console.log(`\nMerged skeleton: ${skeleton.size} unique tickers`);
  let nyseCount = 0, nasdaqCount = 0, etfOnly = 0;
  for (const row of skeleton.values()) {
    if (row.sources.includes('nyse')) nyseCount++;
    if (row.sources.includes('nasdaq')) nasdaqCount++;
    if (!row.sources.includes('nyse') && !row.sources.includes('nasdaq')) etfOnly++;
  }
  console.log(`  NYSE: ${nyseCount}, NASDAQ: ${nasdaqCount}, ETF-only: ${etfOnly}`);
  console.log('\n(Phase 2-4 land in Task 9)');
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('seed-universe failed:', err);
    process.exit(1);
  });
}
