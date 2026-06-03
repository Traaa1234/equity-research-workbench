import { asc, inArray, sql } from 'drizzle-orm';
import { macroSeries, macroFreshness } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type { FredProvider } from '@/lib/providers/fred';
import type { YFinanceProvider } from '@/lib/providers/yfinance';
import { COUNTRY_REGISTRY, countryFredIds, countryEtfs } from '@/lib/compute/country-registry';
import { scoreCountries, type SeriesPoint, type RankedRow } from '@/lib/compute/country-score';
import { logger } from '@/lib/logger';

interface Deps { db: ServiceDb; fred?: FredProvider; yf?: YFinanceProvider; fredDelayMs?: number }
export interface CountryRefreshSummary { fredOk: number; fredFailed: number; etfOk: number }

function isoDaysAgo(d: number): string { const x = new Date(); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10); }
function isoYearsAgo(y: number): string { const x = new Date(); x.setFullYear(x.getFullYear() - y); return x.toISOString().slice(0, 10); }
function sleep(ms: number): Promise<void> { return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve(); }

export class CountryScorecardService {
  constructor(private readonly deps: Deps) {}

  async refreshAll(mode: 'daily' | 'backfill'): Promise<CountryRefreshSummary> {
    if (!this.deps.fred || !this.deps.yf) throw new Error('refreshAll requires fred + yf');
    const start = mode === 'backfill' ? isoYearsAgo(5) : isoDaysAgo(40);
    const delay = this.deps.fredDelayMs ?? 500;
    let fredOk = 0, fredFailed = 0, etfOk = 0;

    for (const id of countryFredIds()) {
      try { await sleep(delay); const pts = await this.deps.fred.fetchSeries(id, { start }); await this.upsert(id, 'fred', pts); await this.fresh(id, pts, 'ok', null); fredOk++; }
      catch (err) { logger.warn({ id, err: String(err) }, 'country fred refresh failed'); await this.fresh(id, [], 'error', String(err).slice(0, 500)); fredFailed++; }
    }
    const batch = await this.deps.yf.pricesBatch(countryEtfs(), mode === 'backfill' ? '5Y' : '1Y');
    for (const [sym, pts] of Object.entries(batch)) {
      const sp = pts.map((p) => ({ date: p.date, value: p.close }));
      await this.upsert(sym, 'yfinance', sp); await this.fresh(sym, sp, 'ok', null); if (sp.length) etfOk++;
    }
    return { fredOk, fredFailed, etfOk };
  }

  private async upsert(seriesId: string, source: string, points: SeriesPoint[]): Promise<void> {
    if (!points.length) return;
    await this.deps.db.insert(macroSeries)
      .values(points.map((p) => ({ seriesId, obsDate: p.date, value: String(p.value), source })))
      .onConflictDoUpdate({ target: [macroSeries.seriesId, macroSeries.obsDate], set: { value: sql`excluded.value`, source: sql`excluded.source` } });
  }
  private async fresh(seriesId: string, pts: SeriesPoint[], status: string, error: string | null): Promise<void> {
    await this.deps.db.insert(macroFreshness)
      .values({ seriesId, lastObsDate: pts.length ? pts[pts.length - 1]!.date : null, status, error })
      .onConflictDoUpdate({ target: macroFreshness.seriesId, set: { lastFetchedAt: sql`now()`, lastObsDate: sql`excluded.last_obs_date`, status, error } });
  }

  private async loadInputs() {
    const ids = [...countryFredIds(), ...countryEtfs()];
    const rows = ids.length ? await this.deps.db.select().from(macroSeries).where(inArray(macroSeries.seriesId, ids)).orderBy(asc(macroSeries.obsDate)) : [];
    const by = new Map<string, SeriesPoint[]>();
    for (const r of rows) { const a = by.get(r.seriesId) ?? []; a.push({ date: r.obsDate, value: Number(r.value) }); by.set(r.seriesId, a); }
    const get = (id: string | null) => (id ? by.get(id) ?? [] : []);
    return COUNTRY_REGISTRY.map((c) => ({
      code: c.code, name: c.name, flag: c.flag,
      series: { cli: get(c.series.cli), unemployment: get(c.series.unemployment), longRate: get(c.series.longRate), cpi: get(c.series.cpi), etf: get(c.etf) },
    }));
  }

  async getScorecard(): Promise<{ asOf: string | null; countries: RankedRow[] }> {
    const rows = scoreCountries(await this.loadInputs());
    const fresh = await this.deps.db.select().from(macroFreshness);
    const asOf = fresh.map((r) => r.lastObsDate).filter((d): d is string => !!d).sort().pop() ?? null;
    return { asOf, countries: rows };
  }

  async getCountryDetail(code: string): Promise<{ code: string; name: string; flag: string; row: RankedRow | null; series: Record<string, SeriesPoint[]> }> {
    const def = COUNTRY_REGISTRY.find((c) => c.code === code);
    if (!def) throw new Error('unknown country');
    const inputs = await this.loadInputs();
    const ranked = scoreCountries(inputs);
    const row = ranked.find((r) => r.code === code) ?? null;
    const me = inputs.find((c) => c.code === code)!;
    return { code: def.code, name: def.name, flag: def.flag, row, series: me.series as unknown as Record<string, SeriesPoint[]> };
  }
}
