import { eq, sql } from 'drizzle-orm';
import type { ServiceDb } from '@/lib/db/client';
import type { Provider } from '@/lib/providers/types';
import type { RedisCache } from '@/lib/cache/redis';
import { companies, companiesUniverse, snapshots } from '@/lib/db/schema';
import { SnapshotService } from '@/lib/services/snapshot';
import { FinancialsService } from '@/lib/services/financials';
import { loadQuality } from '@/lib/services/quality';
import {
  selectFallback,
  type FallbackLevel,
  type FilterSet
} from '@/lib/compute/peer-fallback';
import { logger } from '@/lib/logger';

const STALENESS_MS = 24 * 60 * 60 * 1000;
const SIZE_BAND_LOW = 0.3;
const SIZE_BAND_HIGH = 3.0;
const PEER_TIMEOUT_MS = 30_000;

export type PeerFallback = FallbackLevel | 'target_missing';

export interface PeerRow {
  ticker: string;
  name: string;
  country: string | null;
  sector: string | null;
  marketCap: number | null;
  pe: number | null;
  evEbitda: number | null;
  revGrowthYoy: number | null;
  grossMargin: number | null;
  roe: number | null;
  fScore: number | null;
  similarity: number | null;
  dataStatus: 'available' | 'unavailable';
}

export interface PeersResult {
  target: PeerRow;
  peers: PeerRow[];
  fallback: PeerFallback;
  k: number;
}

interface Deps {
  db: ServiceDb;
  primary: Provider;
  fallback: Provider;
  redis: RedisCache;
}

interface TargetMeta {
  ticker: string;
  name: string;
  country: string | null;
  marketCap: number | null;
  embeddingLiteral: string;
}

export class PeersService {
  private snapshotSvc: SnapshotService;
  private financialsSvc: FinancialsService;

  constructor(private readonly deps: Deps) {
    this.snapshotSvc = new SnapshotService({
      db: deps.db, primary: deps.primary, fallback: deps.fallback, redis: deps.redis
    });
    this.financialsSvc = new FinancialsService({
      db: deps.db, primary: deps.primary, fallback: deps.fallback, redis: deps.redis
    });
  }

  async getPeers(targetTicker: string, k = 5): Promise<PeersResult> {
    const target = targetTicker.toUpperCase();

    const meta = await this.lookupTarget(target);
    if (!meta) {
      return {
        target: emptyRow(target),
        peers: [],
        fallback: 'target_missing',
        k
      };
    }

    const peerTickers = await this.findCandidates(meta, k);

    const allTickers = [meta.ticker, ...peerTickers.tickers];
    await Promise.allSettled(allTickers.map((t) => this.ensureDeepData(t)));

    const target_row = await this.buildRow(meta.ticker, meta.name, meta.country, meta.marketCap, null);
    const peer_rows = await Promise.all(
      peerTickers.tickers.map(async (t) => {
        const m = await this.readUniverseMeta(t);
        const sim = await this.computeSimilarity(meta.embeddingLiteral, t);
        return this.buildRow(t, m?.name ?? t, m?.country ?? null, m?.marketCap ?? null, sim);
      })
    );

    return {
      target: target_row,
      peers: peer_rows,
      fallback: peerTickers.level,
      k
    };
  }

  private async lookupTarget(ticker: string): Promise<TargetMeta | null> {
    const rows = await this.deps.db.execute(sql`
      SELECT
        ticker, name, country,
        market_cap::text AS market_cap_text,
        description_embedding::text AS embedding_text
      FROM companies_universe
      WHERE ticker = ${ticker}
        AND description_embedding IS NOT NULL
      LIMIT 1
    `);
    const r = (rows as unknown as Array<Record<string, unknown>>)[0];
    if (!r) return null;
    return {
      ticker: r.ticker as string,
      name: r.name as string,
      country: (r.country as string | null) ?? null,
      marketCap: r.market_cap_text != null ? Number(r.market_cap_text) : null,
      embeddingLiteral: r.embedding_text as string
    };
  }

  private async findCandidates(
    meta: TargetMeta,
    k: number
  ): Promise<{ level: FallbackLevel; tickers: string[] }> {
    const sizeBand =
      meta.marketCap != null
        ? { min: meta.marketCap * SIZE_BAND_LOW, max: meta.marketCap * SIZE_BAND_HIGH }
        : null;
    const filters: FilterSet = { country: meta.country, sizeBand };
    return selectFallback({
      k,
      filters,
      tryQuery: (f) => this.runVectorQuery(meta.ticker, meta.embeddingLiteral, f, k)
    });
  }

  private async runVectorQuery(
    targetTicker: string,
    embeddingLiteral: string,
    filters: FilterSet,
    k: number
  ): Promise<string[]> {
    const countryFilter = filters.country ? sql`AND country = ${filters.country}` : sql``;
    const sizeFilter = filters.sizeBand
      ? sql`AND market_cap BETWEEN ${filters.sizeBand.min} AND ${filters.sizeBand.max}`
      : sql``;

    const rows = await this.deps.db.execute(sql`
      SELECT ticker
      FROM companies_universe
      WHERE description_embedding IS NOT NULL
        AND ticker != ${targetTicker}
        ${countryFilter}
        ${sizeFilter}
      ORDER BY description_embedding <=> ${embeddingLiteral}::vector, ticker
      LIMIT ${k}
    `);
    return (rows as unknown as Array<{ ticker: string }>).map((r) => r.ticker);
  }

  private async readUniverseMeta(
    ticker: string
  ): Promise<{ name: string; country: string | null; marketCap: number | null } | null> {
    const rows = await this.deps.db
      .select({
        name: companiesUniverse.name,
        country: companiesUniverse.country,
        marketCap: companiesUniverse.marketCap
      })
      .from(companiesUniverse)
      .where(eq(companiesUniverse.ticker, ticker))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      name: r.name,
      country: r.country ?? null,
      marketCap: r.marketCap != null ? Number(r.marketCap) : null
    };
  }

  private async computeSimilarity(
    targetEmbeddingLiteral: string,
    peerTicker: string
  ): Promise<number | null> {
    const rows = await this.deps.db.execute(sql`
      SELECT 1 - (description_embedding <=> ${targetEmbeddingLiteral}::vector) AS sim
      FROM companies_universe
      WHERE ticker = ${peerTicker}
      LIMIT 1
    `);
    const r = (rows as unknown as Array<{ sim: number | string }>)[0];
    if (!r) return null;
    return Number(r.sim);
  }

  private async ensureDeepData(ticker: string): Promise<void> {
    const t = ticker.toUpperCase();

    const existing = await this.deps.db
      .select({ lastRefreshedAt: companies.lastRefreshedAt })
      .from(companies)
      .where(eq(companies.ticker, t))
      .limit(1);
    const row = existing[0];

    if (row?.lastRefreshedAt) {
      const age = Date.now() - new Date(row.lastRefreshedAt).getTime();
      if (age < STALENESS_MS) return;
    }

    if (!row) {
      await this.deps.db.insert(companies).values({ ticker: t, name: t }).onConflictDoNothing();
    }

    const work = Promise.allSettled([
      this.snapshotSvc.refresh(t),
      this.financialsSvc.refresh(t, 'income', 'annual'),
      this.financialsSvc.refresh(t, 'balance', 'annual'),
      this.financialsSvc.refresh(t, 'cash_flow', 'annual')
    ]);
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), PEER_TIMEOUT_MS)
    );
    const winner = await Promise.race([work, timeout]);
    if (winner === 'timeout') {
      logger.warn({ ticker: t }, 'peers: ensureDeepData timed out');
      return;
    }

    await this.deps.db
      .update(companies)
      .set({ lastRefreshedAt: new Date() })
      .where(eq(companies.ticker, t));
  }

  private async buildRow(
    ticker: string,
    name: string,
    country: string | null,
    universeMarketCap: number | null,
    similarity: number | null
  ): Promise<PeerRow> {
    const snap = await this.deps.db
      .select({
        marketCap: snapshots.marketCap,
        pe: snapshots.pe,
        evEbitda: snapshots.evEbitda,
        sector: companies.sector
      })
      .from(snapshots)
      .leftJoin(companies, eq(companies.ticker, snapshots.ticker))
      .where(eq(snapshots.ticker, ticker))
      .limit(1);
    const s = snap[0];

    if (!s) {
      return {
        ticker, name, country,
        sector: null,
        marketCap: universeMarketCap,
        pe: null, evEbitda: null,
        revGrowthYoy: null, grossMargin: null, roe: null, fScore: null,
        similarity, dataStatus: 'unavailable'
      };
    }

    const [revGrowthYoy, grossMargin, roe] = await this.computeFundamentalsMetrics(ticker);

    let fScore: number | null = null;
    try {
      const q = await loadQuality(this.deps.db, ticker);
      fScore = q.current.piotroskiF?.score ?? null;
    } catch {
      fScore = null;
    }

    return {
      ticker,
      name,
      country,
      sector: (s.sector as string | null) ?? null,
      marketCap: s.marketCap != null ? Number(s.marketCap) : universeMarketCap,
      pe: s.pe != null ? Number(s.pe) : null,
      evEbitda: s.evEbitda != null ? Number(s.evEbitda) : null,
      revGrowthYoy, grossMargin, roe, fScore,
      similarity,
      dataStatus: 'available'
    };
  }

  private async computeFundamentalsMetrics(
    ticker: string
  ): Promise<[number | null, number | null, number | null]> {
    const rows = await this.deps.db.execute(sql`
      SELECT period_end, line_item, value::float8 AS value
      FROM fundamentals
      WHERE ticker = ${ticker}
        AND period_type = 'annual'
        AND line_item IN ('revenue', 'gross_profit', 'net_income', 'total_assets', 'total_liabilities')
      ORDER BY period_end DESC
    `);
    const data = rows as unknown as Array<{ period_end: string; line_item: string; value: number | null }>;

    const byPeriod = new Map<string, Record<string, number | null>>();
    for (const r of data) {
      if (!byPeriod.has(r.period_end)) byPeriod.set(r.period_end, {});
      byPeriod.get(r.period_end)![r.line_item] = r.value;
    }
    const periods = Array.from(byPeriod.keys()).sort().reverse();
    if (periods.length < 1) return [null, null, null];

    const latest = byPeriod.get(periods[0]!)!;
    const prior = periods.length >= 2 ? byPeriod.get(periods[1]!)! : null;

    const rev = latest.revenue;
    const priorRev = prior?.revenue ?? null;
    const revGrowth = (rev != null && priorRev != null && priorRev !== 0)
      ? (rev - priorRev) / priorRev
      : null;

    const gp = latest.gross_profit;
    const grossMargin = (gp != null && rev != null && rev !== 0) ? gp / rev : null;

    const ni = latest.net_income;
    const equity = (latest.total_assets != null && latest.total_liabilities != null)
      ? latest.total_assets - latest.total_liabilities
      : null;
    const roe = (ni != null && equity != null && equity !== 0) ? ni / equity : null;

    return [revGrowth, grossMargin, roe];
  }
}

function emptyRow(ticker: string): PeerRow {
  return {
    ticker, name: ticker, country: null, sector: null,
    marketCap: null, pe: null, evEbitda: null,
    revGrowthYoy: null, grossMargin: null, roe: null, fScore: null,
    similarity: null, dataStatus: 'unavailable'
  };
}
