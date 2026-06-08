import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { macroSeries, macroFreshness } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type { YFinanceProvider } from '@/lib/providers/yfinance';
import { NotFoundError } from '@/lib/providers/types';
import {
  SECTOR_REGISTRY, sectorSeriesIds, displaySectors,
} from '@/lib/compute/sector-registry';
import {
  sectorReturns, relativeReturn, WINDOWS,
  type PricePoint, type ReturnWindow,
} from '@/lib/compute/sector-analytics';
import { logger } from '@/lib/logger';

interface Deps { db: ServiceDb; yf?: YFinanceProvider }

export type { ReturnWindow };

export interface SectorRow {
  seriesId: string;
  label: string;
  shortLabel: string;
  latestPrice: number | null;
  priceDate: string | null;
  returns: Record<ReturnWindow, number | null>;
  vsSpy: Record<ReturnWindow, number | null>;
}

export interface SectorData {
  sectors: SectorRow[];  // 11 rows, default sorted by 1M return desc
  asOf: string | null;   // max latest date across the batch
  stale: boolean;        // true if asOf > 3 calendar days ago (~2 trading days)
}

function isoYearsAgo(y: number): string {
  const d = new Date(); d.setFullYear(d.getFullYear() - y); return d.toISOString().slice(0, 10);
}

function nullReturns(): Record<ReturnWindow, null> {
  return { '1D': null, '1W': null, '1M': null, '3M': null, '1Y': null };
}

export class SectorRotationService {
  constructor(private readonly deps: Deps) {}

  async refreshAll(mode: 'daily' | 'backfill'): Promise<{ ok: number; failed: number }> {
    if (!this.deps.yf) throw new Error('SectorRotationService.refreshAll requires yf');
    const range: '1Y' | '5Y' = mode === 'backfill' ? '5Y' : '1Y';
    let ok = 0, failed = 0;

    let batch: Record<string, Array<{ date: string; close: number }>>;
    try {
      batch = await this.deps.yf.pricesBatch(sectorSeriesIds(), range) as Record<string, Array<{ date: string; close: number }>>;
    } catch (err) {
      logger.error({ err: String(err) }, 'sector pricesBatch failed');
      // Mark all as failed
      for (const id of sectorSeriesIds()) {
        await this.upsertFresh(id, [], 'error', String(err).slice(0, 500));
        failed++;
      }
      return { ok, failed };
    }

    for (const id of sectorSeriesIds()) {
      const pts = batch[id] ?? [];
      const sp = pts.map((p) => ({ date: p.date, value: p.close }));
      try {
        await this.upsertPrices(id, sp);
        await this.upsertFresh(id, sp, 'ok', null);
        ok++;
      } catch (err) {
        logger.warn({ id, err: String(err) }, 'sector upsert failed');
        await this.upsertFresh(id, [], 'error', String(err).slice(0, 500)).catch(() => {});
        failed++;
      }
    }
    return { ok, failed };
  }

  private async upsertPrices(seriesId: string, points: PricePoint[]): Promise<void> {
    if (!points.length) return;
    await this.deps.db.insert(macroSeries)
      .values(points.map((p) => ({ seriesId, obsDate: p.date, value: String(p.value), source: 'yfinance' })))
      .onConflictDoUpdate({
        target: [macroSeries.seriesId, macroSeries.obsDate],
        set: { value: sql`excluded.value`, source: sql`excluded.source` },
      });
  }

  private async upsertFresh(seriesId: string, pts: PricePoint[], status: string, error: string | null): Promise<void> {
    await this.deps.db.insert(macroFreshness)
      .values({ seriesId, lastObsDate: pts.length ? pts[pts.length - 1]!.date : null, status, error })
      .onConflictDoUpdate({
        target: macroFreshness.seriesId,
        set: { lastFetchedAt: sql`now()`, lastObsDate: sql`excluded.last_obs_date`, status, error },
      });
  }

  async getSectors(): Promise<SectorData> {
    const ids = sectorSeriesIds();
    const rows = await this.deps.db
      .select()
      .from(macroSeries)
      .where(inArray(macroSeries.seriesId, ids))
      .orderBy(asc(macroSeries.obsDate));

    // Build per-symbol price arrays
    const allPrices: Record<string, PricePoint[]> = {};
    for (const r of rows) {
      (allPrices[r.seriesId] ??= []).push({ date: r.obsDate, value: Number(r.value) });
    }

    const allReturns = sectorReturns(allPrices, WINDOWS);
    const spyRets = allReturns['SPY'] ?? nullReturns();

    const sectors: SectorRow[] = displaySectors().map((def) => {
      const prices = allPrices[def.seriesId] ?? [];
      const last = prices.length ? prices[prices.length - 1]! : null;
      const rets = allReturns[def.seriesId] ?? nullReturns();
      const vsSpy: Record<ReturnWindow, number | null> = {
        '1D': relativeReturn(rets['1D'] ?? null, spyRets['1D'] ?? null),
        '1W': relativeReturn(rets['1W'] ?? null, spyRets['1W'] ?? null),
        '1M': relativeReturn(rets['1M'] ?? null, spyRets['1M'] ?? null),
        '3M': relativeReturn(rets['3M'] ?? null, spyRets['3M'] ?? null),
        '1Y': relativeReturn(rets['1Y'] ?? null, spyRets['1Y'] ?? null),
      };
      return {
        seriesId: def.seriesId,
        label: def.label,
        shortLabel: def.shortLabel,
        latestPrice: last ? last.value : null,
        priceDate: last ? last.date : null,
        returns: {
          '1D': rets['1D'] ?? null,
          '1W': rets['1W'] ?? null,
          '1M': rets['1M'] ?? null,
          '3M': rets['3M'] ?? null,
          '1Y': rets['1Y'] ?? null,
        },
        vsSpy,
      };
    });

    // Default sort: 1M return desc (nulls last)
    sectors.sort((a, b) => {
      const av = a.returns['1M'] ?? -Infinity;
      const bv = b.returns['1M'] ?? -Infinity;
      return bv - av;
    });

    // asOf = max latest priceDate across all sectors (from macroFreshness)
    const fresh = ids.length
      ? await this.deps.db.select().from(macroFreshness).where(inArray(macroFreshness.seriesId, ids))
      : [];
    const asOf = fresh.map((r) => r.lastObsDate).filter((d): d is string => !!d).sort().pop() ?? null;
    const stale = asOf ? Date.now() - new Date(asOf).getTime() > 3 * 864e5 : false;

    return { sectors, asOf, stale };
  }

  async getSeriesHistory(
    seriesId: string,
    range: '1y' | '3y' | '5y',
  ): Promise<{ seriesId: string; label: string; history: PricePoint[] }> {
    const def = SECTOR_REGISTRY.find((s) => s.seriesId === seriesId && !s.isBenchmark);
    if (!def) throw new NotFoundError(`Unknown sector series: ${seriesId}`);
    const yearsBack = range === '1y' ? 1 : range === '3y' ? 3 : 5;
    const since = isoYearsAgo(yearsBack);
    const rows = await this.deps.db
      .select()
      .from(macroSeries)
      .where(and(eq(macroSeries.seriesId, seriesId), sql`${macroSeries.obsDate} >= ${since}`))
      .orderBy(asc(macroSeries.obsDate));
    return {
      seriesId,
      label: def.label,
      history: rows.map((r) => ({ date: r.obsDate, value: Number(r.value) })),
    };
  }
}
