import {
  CompanyData,
  EarningsPoint,
  NotFoundError,
  PeriodType,
  PricePoint,
  Provider,
  ProviderError,
  ProviderName,
  RateLimitError,
  SnapshotData,
  StatementBundle,
  StatementType,
  UnknownProviderError,
  ValidationError
} from './types';

interface RetryConfig {
  attempts: number;
  baseDelayMs: number;
}

interface Options {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  retry?: RetryConfig;
}

const DEFAULT_RETRY: RetryConfig = { attempts: 3, baseDelayMs: 250 };

export class FinancialDatasetsProvider implements Provider {
  readonly name: ProviderName = 'financial_datasets';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retry: RetryConfig;

  constructor(opts: Options) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.financialdatasets.ai';
    this.fetchImpl = opts.fetch ?? fetch;
    this.retry = opts.retry ?? DEFAULT_RETRY;
  }

  async company(ticker: string): Promise<CompanyData> {
    const t = ticker.toUpperCase();
    const body = await this.request<{ company_facts: any }>(`/company/facts?ticker=${t}`);
    const c = body.company_facts;
    return {
      ticker: c.ticker,
      name: c.name,
      cik: c.cik ?? null,
      exchange: c.exchange ?? null,
      sector: c.sector ?? null,
      industry: c.industry ?? null
    };
  }

  async snapshot(ticker: string): Promise<SnapshotData> {
    const t = ticker.toUpperCase();
    const body = await this.request<{ snapshot: any }>(
      `/financial-metrics/snapshot?ticker=${t}`
    );
    const s = body.snapshot;
    return {
      ticker: s.ticker,
      price: numOrNull(s.latest_price),
      marketCap: numOrNull(s.market_cap),
      week52High: numOrNull(s.fifty_two_week_high),
      week52Low: numOrNull(s.fifty_two_week_low),
      pe: numOrNull(s.price_to_earnings_ratio),
      ps: numOrNull(s.price_to_sales_ratio),
      pb: numOrNull(s.price_to_book_ratio),
      evEbitda: numOrNull(s.enterprise_value_to_ebitda_ratio),
      peg: numOrNull(s.peg_ratio),
      asOf: new Date(s.as_of)
    };
  }

  async statements(
    _ticker: string,
    _statementType: StatementType,
    _periodType: PeriodType
  ): Promise<StatementBundle> {
    throw new Error('Not yet implemented');
  }
  async prices(_ticker: string, _range: '1Y' | '5Y'): Promise<PricePoint[]> {
    throw new Error('Not yet implemented');
  }
  async earnings(_ticker: string, _count: number): Promise<EarningsPoint[]> {
    throw new Error('Not yet implemented');
  }

  // ----- HTTP plumbing -----

  private async request<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          headers: { 'X-API-KEY': this.apiKey, accept: 'application/json' }
        });

        if (res.status === 404) throw new NotFoundError(`Not found: ${path}`);
        if (res.status === 429) throw new RateLimitError(`Rate limited: ${path}`);
        if (res.status === 400 || res.status === 422) {
          throw new ValidationError(`Bad request: ${path} (status ${res.status})`);
        }
        if (res.status >= 500) throw new ProviderError(`Server error ${res.status}: ${path}`);
        if (!res.ok) throw new UnknownProviderError(`Unexpected ${res.status}: ${path}`);

        return (await res.json()) as T;
      } catch (err) {
        lastError = err;
        // Only retry transient errors.
        const transient = err instanceof RateLimitError || err instanceof ProviderError;
        if (!transient || attempt === this.retry.attempts) throw err;
        await sleep(this.retry.baseDelayMs * Math.pow(4, attempt - 1));
      }
    }
    throw lastError;
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
