import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import {
  NotFoundError,
  ProviderError,
  RateLimitError,
  SecEdgarProvider,
  SecFilingFull,
  SecFilingsList,
  ThirteenFInvestor,
  UnknownProviderError,
  ValidationError
} from './types';

interface Options {
  pythonBin?: string;
  scriptPath?: string;
  spawn?: typeof nodeSpawn;
  timeoutMs?: number;
  useHttp?: boolean;
  httpEndpoint?: string;
  fetch?: typeof fetch;
}

const DEFAULT_SCRIPT = path.resolve(process.cwd(), 'scripts/sec_fetch.py');

function defaultHttpEndpoint(): string {
  const vercelUrl = process.env.VERCEL_URL;
  const base = vercelUrl ? `https://${vercelUrl}` : 'http://localhost:3000';
  return `${base}/api/fallback/sec`;
}

export class SecEdgarProviderImpl implements SecEdgarProvider {
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
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.useHttp = opts.useHttp ?? (process.env.VERCEL === '1');
    this.httpEndpoint = opts.httpEndpoint ?? defaultHttpEndpoint();
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async resolveCik(ticker: string): Promise<string> {
    const out = await this.run({ kind: 'resolve_cik', ticker: ticker.toUpperCase() });
    return out.cik as string;
  }

  async listFilings(cik: string, forms: string[], yearsBack: number): Promise<SecFilingsList> {
    const out = await this.run({
      kind: 'index',
      cik,
      forms: forms.join(','),
      years: String(yearsBack)
    });
    return out as SecFilingsList;
  }

  async fetchFiling(primaryDocUrl: string, formType: string): Promise<SecFilingFull> {
    const out = await this.run({
      kind: 'filing',
      primary_url: primaryDocUrl,
      form_type: formType
    });
    return out as SecFilingFull;
  }

  async thirteenFFilings(cik: string): Promise<ThirteenFInvestor> {
    const body = await this.run({ kind: 'thirteen_f_filings', cik }) as {
      cik: string;
      investor_name: string;
      filings: Array<{
        accession: string;
        filing_date: string;
        report_period: string;
        form_type: string;
        positions: Array<{
          cusip: string;
          issuer_name: string;
          class_title: string;
          value_usd: number;
          shares: number;
          shares_type: string;
        }>;
      }>;
    };
    return {
      cik: body.cik,
      investorName: body.investor_name,
      filings: body.filings.map((f) => ({
        accession: f.accession,
        filingDate: f.filing_date,
        reportPeriod: f.report_period,
        formType: f.form_type,
        positions: f.positions.map((p) => ({
          cusip: p.cusip,
          issuerName: p.issuer_name,
          classTitle: p.class_title,
          valueUsd: p.value_usd,
          shares: p.shares,
          sharesType: p.shares_type
        }))
      }))
    };
  }

  // ----- Dispatch -----

  private run(params: Record<string, string>): Promise<any> {
    return this.useHttp ? this.runHttp(params) : this.runSubprocess(params);
  }

  private async runHttp(params: Record<string, string>): Promise<any> {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.httpEndpoint}?${qs}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal });
      const body = (await res.json().catch(() => null)) as { error?: string; kind?: string } | null;
      if (res.ok) return body;
      if (!body) throw new UnknownProviderError(`SEC HTTP ${res.status}: empty body`);
      throw toTypedError(body);
    } finally {
      clearTimeout(timer);
    }
  }

  private runSubprocess(params: Record<string, string>): Promise<any> {
    return new Promise((resolve, reject) => {
      const argv: string[] = [this.scriptPath, params.kind!];
      for (const [k, v] of Object.entries(params)) {
        if (k === 'kind') continue;
        argv.push(`--${k.replace(/_/g, '-')}`, v);
      }
      const proc = this.spawnImpl(this.pythonBin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill?.('SIGKILL');
        reject(new ProviderError(`SEC script timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      proc.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
      proc.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
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
          return reject(new UnknownProviderError(`SEC script returned non-JSON. exit=${code} stderr=${stderr}`));
        }
        if (code === 0) resolve(body);
        else reject(toTypedError(body));
      });
    });
  }
}

function toTypedError(body: { error?: string; kind?: string }): Error {
  const msg = body.error ?? 'Unknown SEC error';
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
