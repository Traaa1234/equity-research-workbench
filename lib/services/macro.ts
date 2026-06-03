import { asc, eq, sql } from 'drizzle-orm';
import { macroSeries, macroFreshness } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type { FredProvider } from '@/lib/providers/fred';
import type { YFinanceProvider } from '@/lib/providers/yfinance';
import {
  yoySeries, weatherFromVotes, type SeriesPoint, type SignalLevel, type WeatherVerdict,
} from '@/lib/compute/macro-signals';
import {
  MACRO_REGISTRY, ASSET_CLASS_ORDER, ASSET_CLASS_LABEL, type AssetClass, type MacroSeriesDef,
} from '@/lib/compute/macro-registry';
import { logger } from '@/lib/logger';

interface Deps {
  db: ServiceDb;
  fred?: FredProvider;
  yf?: YFinanceProvider;
  /** Delay (ms) between FRED requests to avoid keyless rate-limiting. Default 500; pass 0 in tests. */
  fredDelayMs?: number;
}

export interface MacroRefreshSummary { attempted: number; ok: number; failed: number }

export interface BoardTile {
  seriesId: string; label: string; assetClass: AssetClass;
  value: number | null; unit: string; decimals: number; change: number | null;
  role: 'vote' | 'context'; badge: string; level: SignalLevel; explain: string;
}
export interface BoardGroup { assetClass: AssetClass; label: string; tiles: BoardTile[] }
export interface MacroBoard {
  weather: WeatherVerdict & { benign: number; neutral: number; caution: number; flashing: string[] };
  asOf: string | null;
  groups: BoardGroup[];
}

function isoDaysAgo(days: number): string {
  const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10);
}
function isoYearsAgo(years: number): string {
  const d = new Date(); d.setFullYear(d.getFullYear() - years); return d.toISOString().slice(0, 10);
}
function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

export class MacroService {
  constructor(private readonly deps: Deps) {}

  async refreshAll(mode: 'daily' | 'backfill'): Promise<MacroRefreshSummary> {
    if (!this.deps.fred || !this.deps.yf) throw new Error('MacroService.refreshAll requires fred + yf providers');
    const fredStart = mode === 'backfill' ? isoYearsAgo(5) : isoDaysAgo(35);
    const yfRange: '1Y' | '5Y' = mode === 'backfill' ? '5Y' : '1Y';
    const fredDelayMs = this.deps.fredDelayMs ?? 500;
    let ok = 0, failed = 0;

    for (const def of MACRO_REGISTRY) {
      try {
        let points: SeriesPoint[];
        if (def.source === 'fred') {
          // Space out keyless FRED requests to avoid HTTP 429. A FRED_API_KEY
          // uses the JSON API (no rate-limit at this volume), so this is a cheap no-op there.
          await sleep(fredDelayMs);
          points = await this.deps.fred.fetchSeries(def.seriesId, { start: fredStart });
        } else {
          points = (await this.deps.yf.prices(def.seriesId, yfRange)).map((p) => ({ date: p.date, value: p.close }));
        }
        await this.upsert(def.seriesId, def.source, points);
        await this.setFreshness(def.seriesId, points, 'ok', null);
        ok++;
      } catch (err) {
        logger.warn({ seriesId: def.seriesId, err: String(err) }, 'macro: series refresh failed');
        await this.setFreshness(def.seriesId, [], 'error', String(err).slice(0, 500));
        failed++;
      }
    }
    return { attempted: MACRO_REGISTRY.length, ok, failed };
  }

  private async upsert(seriesId: string, source: string, points: SeriesPoint[]): Promise<void> {
    if (points.length === 0) return;
    const rows = points.map((p) => ({ seriesId, obsDate: p.date, value: String(p.value), source }));
    await this.deps.db
      .insert(macroSeries)
      .values(rows)
      .onConflictDoUpdate({
        target: [macroSeries.seriesId, macroSeries.obsDate],
        set: { value: sql`excluded.value`, source: sql`excluded.source` },
      });
  }

  private async setFreshness(seriesId: string, points: SeriesPoint[], status: string, error: string | null): Promise<void> {
    const lastObsDate = points.length ? points[points.length - 1]!.date : null;
    await this.deps.db
      .insert(macroFreshness)
      .values({ seriesId, lastObsDate, status, error })
      .onConflictDoUpdate({
        target: macroFreshness.seriesId,
        set: { lastFetchedAt: sql`now()`, lastObsDate: sql`excluded.last_obs_date`, status, error },
      });
  }

  async getBoard(): Promise<MacroBoard> {
    const rows = await this.deps.db.select().from(macroSeries).orderBy(asc(macroSeries.obsDate));
    const bySeries = new Map<string, SeriesPoint[]>();
    for (const r of rows) {
      const arr = bySeries.get(r.seriesId) ?? [];
      arr.push({ date: r.obsDate, value: Number(r.value) });
      bySeries.set(r.seriesId, arr);
    }

    const tiles: BoardTile[] = MACRO_REGISTRY.map((def) => this.buildTile(def, bySeries.get(def.seriesId) ?? []));

    const voters = tiles.filter((t) => t.role === 'vote');
    const weather = weatherFromVotes(voters.map((t) => t.level));
    const counts = { benign: 0, neutral: 0, caution: 0 };
    const flashing: string[] = [];
    for (const v of voters) {
      if (v.level > 0) counts.benign++;
      else if (v.level < 0) { counts.caution++; flashing.push(v.label); }
      else counts.neutral++;
    }

    const freshRows = await this.deps.db.select().from(macroFreshness);
    const asOf = freshRows
      .map((r) => r.lastObsDate)
      .filter((d): d is string => !!d)
      .sort()
      .pop() ?? null;

    const groups: BoardGroup[] = ASSET_CLASS_ORDER.map((ac) => ({
      assetClass: ac,
      label: ASSET_CLASS_LABEL[ac],
      tiles: tiles.filter((t) => t.assetClass === ac),
    })).filter((g) => g.tiles.length > 0);

    return { weather: { ...weather, ...counts, flashing }, asOf, groups };
  }

  private buildTile(def: MacroSeriesDef, raw: SeriesPoint[]): BoardTile {
    const display = def.derive === 'yoy' ? yoySeries(raw) : raw;
    const n = display.length;
    const value = n ? display[n - 1]!.value : null;
    const change = n >= 2 ? display[n - 1]!.value - display[n - 2]!.value : null;
    const sig = value == null
      ? { badge: 'NO DATA', level: 0 as SignalLevel, explain: 'No data yet.' }
      : def.classify({ value, series: display });
    return {
      seriesId: def.seriesId, label: def.label, assetClass: def.assetClass,
      value, unit: def.unit, decimals: def.decimals, change,
      role: def.role, badge: sig.badge, level: sig.level, explain: sig.explain,
    };
  }

  async getSeriesDetail(seriesId: string, range: '1y' | '3y' | '5y'): Promise<{
    seriesId: string; label: string; unit: string; decimals: number;
    points: SeriesPoint[]; badge: string; explain: string; asOf: string | null;
  }> {
    const def = MACRO_REGISTRY.find((d) => d.seriesId === seriesId);
    if (!def) throw new Error('unknown series'); // mapped to 404 by the route
    const years = range === '1y' ? 1 : range === '3y' ? 3 : 5;
    const cutoff = isoYearsAgo(years);
    const rows = await this.deps.db
      .select()
      .from(macroSeries)
      .where(eq(macroSeries.seriesId, seriesId))
      .orderBy(asc(macroSeries.obsDate));
    const raw: SeriesPoint[] = rows.map((r) => ({ date: r.obsDate, value: Number(r.value) }));
    const display = def.derive === 'yoy' ? yoySeries(raw) : raw;
    const windowed = display.filter((p) => p.date >= cutoff);
    const value = display.length ? display[display.length - 1]!.value : null;
    const sig = value == null ? { badge: 'NO DATA', explain: 'No data yet.' } : def.classify({ value, series: display });
    const asOf = display.length ? display[display.length - 1]!.date : null;
    return { seriesId, label: def.label, unit: def.unit, decimals: def.decimals, points: windowed, badge: sig.badge, explain: sig.explain, asOf };
  }
}
