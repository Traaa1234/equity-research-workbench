import { ProviderError } from './types';

export interface FredPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

interface Options {
  apiKey?: string | undefined;
  fetch?: typeof fetch;
}

/**
 * FRED data provider — pure TypeScript (FRED is a plain REST/CSV GET).
 * Prefers the keyed JSON API when an api key is available; otherwise uses the
 * keyless fredgraph CSV endpoint. Always bound by `start` (cosd / observation_start).
 */
// Intentionally does NOT implement the stock-centric `Provider` interface —
// FRED returns raw macro time-series, not company/price/statement shapes.
export class FredProvider {
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: Options = {}) {
    this.apiKey = opts.apiKey ?? process.env.FRED_API_KEY;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async fetchSeries(seriesId: string, opts: { start: string }): Promise<FredPoint[]> {
    const url = this.apiKey
      ? `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(seriesId)}` +
        `&observation_start=${opts.start}&file_type=json&api_key=${this.apiKey}`
      : `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}&cosd=${opts.start}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url);
    } catch (err) {
      throw new ProviderError(`FRED fetch failed for ${seriesId}: ${String(err)}`);
    }
    if (!res.ok) throw new ProviderError(`FRED ${seriesId} HTTP ${res.status}`);

    let body: string;
    try {
      body = await res.text();
    } catch (err) {
      throw new ProviderError(`FRED ${seriesId} body read failed: ${String(err)}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    try {
      return contentType.includes('json') ? parseJson(body) : parseCsv(body);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`FRED ${seriesId} parse failed: ${String(err)}`);
    }
  }
}

function num(raw: string): number | null {
  const v = raw.trim();
  if (v === '' || v === '.') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseCsv(body: string): FredPoint[] {
  const lines = body.trim().split(/\r?\n/);
  const out: FredPoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const date = line.slice(0, comma).trim();
    const value = num(line.slice(comma + 1));
    if (date && value != null) out.push({ date, value });
  }
  return out;
}

export function parseJson(body: string): FredPoint[] {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null || !('observations' in parsed)) {
    throw new ProviderError(`FRED JSON response missing 'observations'`);
  }
  const obs = (parsed as { observations?: { date: string; value: string }[] }).observations ?? [];
  const out: FredPoint[] = [];
  for (const o of obs) {
    const value = num(o.value);
    if (o.date && value != null) out.push({ date: o.date, value });
  }
  return out;
}
