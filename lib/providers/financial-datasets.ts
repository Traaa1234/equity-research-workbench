import {
  CompanyData,
  EarningsPoint,
  NewsArticleMeta,
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
      asOf: parseDateOrNow(s.as_of)
    };
  }

  async statements(
    ticker: string,
    statementType: StatementType,
    periodType: PeriodType
  ): Promise<StatementBundle> {
    const t = ticker.toUpperCase();
    const endpointMap: Record<StatementType, { path: string; arrayKey: string; lineItems: string[] }> = {
      income: {
        path: 'income-statements',
        arrayKey: 'income_statements',
        lineItems: [
          'revenue',
          'cost_of_revenue',
          'gross_profit',
          'operating_expense',
          'operating_income',
          'net_income',
          'earnings_per_share'
        ]
      },
      balance: {
        path: 'balance-sheets',
        arrayKey: 'balance_sheets',
        lineItems: [
          'total_assets',
          'total_liabilities',
          'total_equity',
          'cash_and_equivalents',
          'long_term_debt',
          'short_term_debt'
        ]
      },
      cash_flow: {
        path: 'cash-flow-statements',
        arrayKey: 'cash_flow_statements',
        lineItems: [
          'operating_cash_flow',
          'investing_cash_flow',
          'financing_cash_flow',
          'capital_expenditure',
          'free_cash_flow'
        ]
      }
    };
    const spec = endpointMap[statementType];
    const body = await this.request<Record<string, any[]>>(
      `/financials/${spec.path}?ticker=${t}&period=${periodType}&limit=5`
    );
    const items = body[spec.arrayKey] ?? [];
    const rows = items.flatMap((item: any) =>
      spec.lineItems.map((lineItem) => ({
        periodEnd: item.report_period,
        lineItem,
        value: numOrNull(item[lineItem]),
        currency: item.currency ?? 'USD'
      }))
    );
    return { ticker: t, statementType, periodType, rows };
  }
  async prices(ticker: string, range: '1Y' | '5Y'): Promise<PricePoint[]> {
    const t = ticker.toUpperCase();
    const end = new Date();
    const start = new Date();
    start.setFullYear(start.getFullYear() - (range === '1Y' ? 1 : 5));
    const startDate = start.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);

    const body = await this.request<{ prices: any[] }>(
      `/prices?ticker=${t}&interval=day&interval_multiplier=1&start_date=${startDate}&end_date=${endDate}`
    );
    return (body.prices ?? []).map((p) => ({
      date: p.time,
      open: numOrNull(p.open),
      high: numOrNull(p.high),
      low: numOrNull(p.low),
      close: numOrNull(p.close) ?? 0,
      adjClose: numOrNull(p.adj_close),
      volume: numOrNull(p.volume)
    }));
  }

  async earnings(ticker: string, count: number): Promise<EarningsPoint[]> {
    const t = ticker.toUpperCase();
    const body = await this.request<{ earnings: any[] }>(
      `/earnings?ticker=${t}&limit=${count}`
    );
    return (body.earnings ?? []).map((e) => ({
      periodEnd: e.period,
      reportedDate: e.reported_date ?? null,
      epsActual: numOrNull(e.eps),
      price1dPct: null,
      price5dPct: null
    }));
  }

  async news(ticker: string, limit: number): Promise<NewsArticleMeta[]> {
    const out = await this.request<{ news?: NewsArticleMeta[] }>(
      `/news?ticker=${encodeURIComponent(ticker.toUpperCase())}&limit=${limit}`
    );
    return out.news ?? [];
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

function parseDateOrNow(v: unknown): Date {
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
