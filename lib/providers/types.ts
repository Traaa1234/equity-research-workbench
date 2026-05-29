/* Error taxonomy — see spec §"Error handling". */
export class NotFoundError extends Error {
  readonly kind = 'NotFoundError' as const;
}
export class RateLimitError extends Error {
  readonly kind = 'RateLimitError' as const;
}
export class ProviderError extends Error {
  readonly kind = 'ProviderError' as const;
}
export class ValidationError extends Error {
  readonly kind = 'ValidationError' as const;
}
export class UnknownProviderError extends ProviderError {
}

export type ProviderName = 'financial_datasets' | 'yfinance';

/* Normalized shapes — every provider returns these regardless of wire format. */

export interface SnapshotData {
  ticker: string;
  price: number | null;
  marketCap: number | null;
  week52High: number | null;
  week52Low: number | null;
  pe: number | null;
  ps: number | null;
  pb: number | null;
  evEbitda: number | null;
  peg: number | null;
  asOf: Date;
}

export interface CompanyData {
  ticker: string;
  name: string;
  cik: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
}

export interface PricePoint {
  date: string; // ISO YYYY-MM-DD
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  adjClose: number | null;
  volume: number | null;
}

export type StatementType = 'income' | 'balance' | 'cash_flow';
export type PeriodType    = 'annual' | 'quarterly';

export interface FundamentalRow {
  periodEnd: string; // ISO YYYY-MM-DD
  lineItem: string;
  value: number | null;
  currency: string;
}

export interface StatementBundle {
  ticker: string;
  statementType: StatementType;
  periodType: PeriodType;
  rows: FundamentalRow[];
}

export interface EarningsPoint {
  periodEnd: string;
  reportedDate: string | null;
  epsActual: number | null;
  price1dPct: number | null;
  price5dPct: number | null;
}

export interface Provider {
  name: ProviderName;
  company(ticker: string): Promise<CompanyData>;
  snapshot(ticker: string): Promise<SnapshotData>;
  statements(
    ticker: string,
    statementType: StatementType,
    periodType: PeriodType
  ): Promise<StatementBundle>;
  prices(ticker: string, range: '1Y' | '5Y'): Promise<PricePoint[]>;
  earnings(ticker: string, count: number): Promise<EarningsPoint[]>;
}

// SEC EDGAR provider types — used by SecEdgarProvider.
export interface SecFilingMeta {
  accessionNo: string;
  formType: '10-K' | '10-Q' | string; // string for forward compat (8-K etc.)
  filingDate: string;                  // ISO date YYYY-MM-DD
  periodEnd: string | null;
  primaryDocUrl: string;
}

export interface SecFilingsList {
  cik: string;
  filings: SecFilingMeta[];
}

// One structured table from a filing section. Empty cells preserved.
// colspans parallel rows: 1=normal, n>1=spans n cols, 0=covered by prev span.
// head_row_count = how many leading rows came from <thead> or were all-<th>.
// Field names use snake_case to match the Python API wire format.
export interface SecTable {
  id: number;
  rows: string[][];
  colspans: number[][];
  head_row_count: number;
}

export interface SecSection {
  section_key: string;
  section_title: string;
  text: string;
  char_offset_start: number;
  char_offset_end: number;
  tables: SecTable[];
}

export interface SecFilingFull {
  formType: string;
  primaryDocUrl: string;
  sections: SecSection[];
  totalChars: number;
}

// 13F filings — used by SecEdgarProvider.thirteenFFilings.
export interface ThirteenFPosition {
  cusip: string;
  issuerName: string;
  classTitle: string;
  valueUsd: number;
  shares: number;
  sharesType: string;
}

export interface ThirteenFFiling {
  accession: string;
  filingDate: string;          // YYYY-MM-DD
  reportPeriod: string;        // YYYY-MM-DD
  formType: string;
  positions: ThirteenFPosition[];
}

export interface ThirteenFInvestor {
  cik: string;
  investorName: string;
  filings: ThirteenFFiling[];
}

export interface SecEdgarProvider {
  resolveCik(ticker: string): Promise<string>;
  listFilings(cik: string, forms: string[], yearsBack: number): Promise<SecFilingsList>;
  fetchFiling(primaryDocUrl: string, formType: string): Promise<SecFilingFull>;
  thirteenFFilings(cik: string): Promise<ThirteenFInvestor>;
}

// Qwen / DashScope provider types — used by QwenProvider.
export interface QwenSummarizeRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
}

export interface QwenSummarizeResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export type SentimentLabel = 'bullish' | 'neutral' | 'bearish';

export interface SentimentScore {
  sentiment: SentimentLabel;
  confidence: number;   // clamped to [0, 1]
}

export interface SentimentBatchRequest {
  titles: string[];
  ticker?: string;
  model?: string;            // default 'qwen-turbo'
  promptVersion?: string;    // default 'v1'
}

export interface QwenProvider {
  summarize(req: QwenSummarizeRequest): Promise<QwenSummarizeResult>;
  sentimentBatch(req: SentimentBatchRequest): Promise<SentimentScore[]>;
}

// DashScope embeddings provider — used by EmbeddingsProvider.
export interface EmbeddingsRequest {
  model: string;
  texts: string[];   // up to 25 texts per call (DashScope limit)
}

export interface EmbeddingsResult {
  vectors: number[][];   // one per input text, all same dimensionality
  inputTokens: number;
}

export interface EmbeddingsProvider {
  embed(req: EmbeddingsRequest): Promise<EmbeddingsResult>;
}

// News article metadata as returned by Financial Datasets /news endpoint.
// FD provides metadata only — no article body.
export interface NewsArticleMeta {
  ticker: string;
  title: string;
  source: string;
  date: string;   // ISO 8601 with timezone, e.g. "2026-05-27T11:53:25+00:00"
  url: string;
}

// Insider trade transaction as returned by Financial Datasets /insider-trades/ endpoint.
// Field names use snake_case to match the API wire format.
export interface InsiderTradeMeta {
  ticker: string;
  issuer: string;
  name: string;
  title: string | null;
  is_board_director: boolean;
  transaction_date: string;          // ISO YYYY-MM-DD
  transaction_type: string;          // 'Open market sale', 'Open market purchase', 'Award', etc.
  transaction_shares: number;
  transaction_price_per_share: number | null;
  transaction_value: number | null;
  shares_owned_before_transaction: number | null;
  shares_owned_after_transaction: number | null;
  security_title: string | null;
  filing_date: string;
}
