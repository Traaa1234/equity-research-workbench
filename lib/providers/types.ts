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
