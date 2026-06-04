import { asc, eq, inArray, sql } from 'drizzle-orm';
import { macroSeries, macroFreshness } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type { FredProvider } from '@/lib/providers/fred';
import { curveSeriesIds, CURVE_MATURITIES } from '@/lib/compute/curve-registry';
import { buildCurve, type SeriesPoint, type CurveResult } from '@/lib/compute/curve-analytics';
import { logger } from '@/lib/logger';

interface Deps { db: ServiceDb; fred?: FredProvider; fredDelayMs?: number }
export interface CurveRefreshSummary { ok: number; failed: number }

function isoDaysAgo(d: number): string { const x = new Date(); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10); }
function isoYearsAgo(y: number): string { const x = new Date(); x.setFullYear(x.getFullYear() - y); return x.toISOString().slice(0, 10); }
function sleep(ms: number): Promise<void> { return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve(); }

export class YieldCurveService {
  constructor(private readonly deps: Deps) {}

  async refreshAll(mode: 'daily' | 'backfill'): Promise<CurveRefreshSummary> {
    if (!this.deps.fred) throw new Error('refreshAll requires fred');
    const start = mode === 'backfill' ? isoYearsAgo(5) : isoDaysAgo(40);
    const delay = this.deps.fredDelayMs ?? 500;
    let ok = 0, failed = 0;
    for (const id of curveSeriesIds()) {
      try { await sleep(delay); const pts = await this.deps.fred.fetchSeries(id, { start }); await this.upsert(id, pts); await this.fresh(id, pts, 'ok', null); ok++; }
      catch (err) { logger.warn({ id, err: String(err) }, 'curve refresh failed'); await this.fresh(id, [], 'error', String(err).slice(0, 500)); failed++; }
    }
    return { ok, failed };
  }

  private async upsert(seriesId: string, points: SeriesPoint[]): Promise<void> {
    if (!points.length) return;
    await this.deps.db.insert(macroSeries)
      .values(points.map((p) => ({ seriesId, obsDate: p.date, value: String(p.value), source: 'fred' })))
      .onConflictDoUpdate({ target: [macroSeries.seriesId, macroSeries.obsDate], set: { value: sql`excluded.value`, source: sql`excluded.source` } });
  }
  private async fresh(seriesId: string, pts: SeriesPoint[], status: string, error: string | null): Promise<void> {
    await this.deps.db.insert(macroFreshness)
      .values({ seriesId, lastObsDate: pts.length ? pts[pts.length - 1]!.date : null, status, error })
      .onConflictDoUpdate({ target: macroFreshness.seriesId, set: { lastFetchedAt: sql`now()`, lastObsDate: sql`excluded.last_obs_date`, status, error } });
  }

  private async histories(): Promise<Record<string, SeriesPoint[]>> {
    const ids = curveSeriesIds();
    const rows = await this.deps.db.select().from(macroSeries).where(inArray(macroSeries.seriesId, ids)).orderBy(asc(macroSeries.obsDate));
    const by: Record<string, SeriesPoint[]> = {};
    for (const r of rows) { (by[r.seriesId] ??= []).push({ date: r.obsDate, value: Number(r.value) }); }
    return by;
  }

  async getCurve(): Promise<CurveResult & { asOf: string | null }> {
    const result = buildCurve(await this.histories());
    const ids = curveSeriesIds();
    const fresh = await this.deps.db.select().from(macroFreshness).where(inArray(macroFreshness.seriesId, ids));
    const asOf = fresh.map((r) => r.lastObsDate).filter((d): d is string => !!d).sort().pop() ?? null;
    return { ...result, asOf };
  }

  async getMaturityDetail(seriesId: string): Promise<{ seriesId: string; label: string; points: SeriesPoint[] }> {
    const def = CURVE_MATURITIES.find((m) => m.seriesId === seriesId);
    if (!def) throw new Error('unknown maturity');
    const rows = await this.deps.db.select().from(macroSeries).where(eq(macroSeries.seriesId, seriesId)).orderBy(asc(macroSeries.obsDate));
    return { seriesId, label: def.label, points: rows.map((r) => ({ date: r.obsDate, value: Number(r.value) })) };
  }
}
