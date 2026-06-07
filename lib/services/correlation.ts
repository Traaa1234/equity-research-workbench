import { asc, inArray } from 'drizzle-orm';
import { macroSeries } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import { CORR_ASSETS, corrSeriesIds } from '@/lib/compute/correlation-registry';
import { dailyChange, alignByDate, correlationMatrix, type SeriesPoint } from '@/lib/compute/correlation';

interface Deps { db: ServiceDb }
export interface CorrMatrices {
  assets: { seriesId: string; label: string }[];
  windows: Record<'30' | '60' | '90', (number | null)[][]>;
  asOf: string | null;
}

export class CorrelationService {
  constructor(private readonly deps: Deps) {}

  async getMatrices(): Promise<CorrMatrices> {
    const ids = corrSeriesIds();
    const rows = await this.deps.db.select().from(macroSeries).where(inArray(macroSeries.seriesId, ids)).orderBy(asc(macroSeries.obsDate));
    const by = new Map<string, SeriesPoint[]>();
    for (const r of rows) { const a = by.get(r.seriesId) ?? []; a.push({ date: r.obsDate, value: Number(r.value) }); by.set(r.seriesId, a); }

    const changeSeries = CORR_ASSETS.map((a) => dailyChange(by.get(a.seriesId) ?? [], a.transform));
    const aligned = alignByDate(changeSeries);
    const windows = {
      '30': correlationMatrix(aligned.values, 30),
      '60': correlationMatrix(aligned.values, 60),
      '90': correlationMatrix(aligned.values, 90),
    } as CorrMatrices['windows'];
    const asOf = aligned.dates.length ? aligned.dates[aligned.dates.length - 1]! : null;
    return { assets: CORR_ASSETS.map((a) => ({ seriesId: a.seriesId, label: a.label })), windows, asOf };
  }
}
