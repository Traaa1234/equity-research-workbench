import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
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

interface Options {
  pythonBin?: string;
  scriptPath?: string;
  spawn?: typeof nodeSpawn;
  timeoutMs?: number;
  // Force HTTP mode (Vercel Python function). Defaults to true on Vercel runtime (VERCEL=1).
  useHttp?: boolean;
  // Override the HTTP endpoint. Defaults to the Vercel deploy URL + /api/fallback/yfinance.
  httpEndpoint?: string;
  // HTTP client (defaults to global fetch); injectable for tests.
  fetch?: typeof fetch;
}

type Kind =
  | 'company'
  | 'snapshot'
  | 'prices_1y'
  | 'prices_5y'
  | 'earnings'
  | 'statements_income_annual'
  | 'statements_income_quarterly'
  | 'statements_balance_annual'
  | 'statements_balance_quarterly'
  | 'statements_cash_flow_annual'
  | 'statements_cash_flow_quarterly';

const DEFAULT_SCRIPT = path.resolve(process.cwd(), 'scripts/yfinance_fetch.py');

function defaultHttpEndpoint(): string {
  const vercelUrl = process.env.VERCEL_URL;
  const base = vercelUrl ? `https://${vercelUrl}` : 'http://localhost:3000';
  return `${base}/api/fallback/yfinance`;
}

export class YFinanceProvider implements Provider {
  readonly name: ProviderName = 'yfinance';
  private readonly pythonBin: string;
  private readonly scriptPath: string;
  private readonly spawnImpl: typeof nodeSpawn;
  private readonly timeoutMs: number;
  private readonly useHttp: boolean;
  private readonly httpEndpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: Options = {}) {
    this.pythonBin = opts.pythonBin ?? process.env.PYTHON_BIN ?? 'python';
    this.scriptPath = opts.scriptPath ?? DEFAULT_SCRIPT;
    this.spawnImpl = opts.spawn ?? nodeSpawn;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.useHttp = opts.useHttp ?? (process.env.VERCEL === '1');
    this.httpEndpoint = opts.httpEndpoint ?? defaultHttpEndpoint();
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async company(ticker: string): Promise<CompanyData> {
    const out = await this.run(ticker, 'company');
    return out as CompanyData;
  }

  async snapshot(ticker: string): Promise<SnapshotData> {
    const out = await this.run(ticker, 'snapshot');
    return { ...out, asOf: new Date(out.asOf) } as SnapshotData;
  }

  async prices(ticker: string, range: '1Y' | '5Y'): Promise<PricePoint[]> {
    const kind: Kind = range === '1Y' ? 'prices_1y' : 'prices_5y';
    const out = await this.run(ticker, kind);
    return (out.prices ?? []) as PricePoint[];
  }

  async earnings(ticker: string, _count: number): Promise<EarningsPoint[]> {
    const out = await this.run(ticker, 'earnings');
    return (out.earnings ?? []) as EarningsPoint[];
  }

  async statements(
    ticker: string,
    statementType: StatementType,
    periodType: PeriodType
  ): Promise<StatementBundle> {
    const kind = `statements_${statementType}_${periodType}` as Kind;
    const out = await this.run(ticker, kind);
    return {
      ticker: out.ticker ?? ticker.toUpperCase(),
      statementType,
      periodType,
      rows: Array.isArray(out.rows) ? out.rows : []
    };
  }

  // ----- Dispatch -----

  private run(ticker: string, kind: Kind): Promise<any> {
    return this.useHttp ? this.runHttp(ticker, kind) : this.runSubprocess(ticker, kind);
  }

  private async runHttp(ticker: string, kind: Kind): Promise<any> {
    const url = `${this.httpEndpoint}?ticker=${encodeURIComponent(ticker.toUpperCase())}&kind=${encodeURIComponent(kind)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal });
      const body = (await res.json().catch(() => null)) as { error?: string; kind?: string } | null;
      if (res.ok) {
        return body;
      }
      if (!body) {
        throw new UnknownProviderError(`yfinance HTTP ${res.status}: empty body`);
      }
      throw toTypedError(body);
    } finally {
      clearTimeout(timer);
    }
  }

  private runSubprocess(ticker: string, kind: Kind): Promise<any> {
    return new Promise((resolve, reject) => {
      const proc = this.spawnImpl(
        this.pythonBin,
        [this.scriptPath, ticker.toUpperCase(), kind],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill?.('SIGKILL');
        reject(new ProviderError(`yfinance script timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      proc.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(new ProviderError(`Failed to spawn Python: ${err.message}`));
      });

      proc.on('close', (code: number) => {
        clearTimeout(timer);
        let body: any;
        try {
          body = JSON.parse(stdout);
        } catch {
          return reject(
            new UnknownProviderError(
              `yfinance script returned non-JSON. exit=${code} stderr=${stderr}`
            )
          );
        }
        if (code === 0) {
          resolve(body);
        } else {
          reject(toTypedError(body));
        }
      });
    });
  }
}

function toTypedError(body: { error?: string; kind?: string }): Error {
  const msg = body.error ?? 'Unknown yfinance error';
  switch (body.kind) {
    case 'NotFound':
      return new NotFoundError(msg);
    case 'Validation':
      return new ValidationError(msg);
    case 'Provider':
      return new ProviderError(msg);
    case 'RateLimit':
      return new RateLimitError(msg);
    default:
      return new UnknownProviderError(msg);
  }
}
