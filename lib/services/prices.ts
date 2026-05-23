import { asc, eq } from 'drizzle-orm';
import { prices as pricesTable } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import { isFresh, upsertPrices } from '@/lib/cache/postgres';
import { TTL } from '@/lib/cache/ttls';
import { RedisCache } from '@/lib/cache/redis';
import {
  NotFoundError,
  Provider,
  ProviderError,
  PricePoint,
  RateLimitError,
  ValidationError
} from '@/lib/providers/types';
import { logger } from '@/lib/logger';

interface Deps {
  db: ServiceDb;
  primary: Provider;
  fallback: Provider;
  redis: RedisCache;
}

/**
 * Read from `deps.redis.get(key)`. Works with either:
 *  - a real `RedisCache` (returns parsed object), or
 *  - a low-level `RedisLike` fake from tests (returns JSON string).
 */
async function cacheGet<T>(
  redis: { get(key: string): Promise<unknown> },
  key: string
): Promise<T | null> {
  const raw = await redis.get(key);
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return raw as T;
}

export class PricesService {
  constructor(private readonly deps: Deps) {}

  async get(ticker: string, range: '1Y' | '5Y'): Promise<PricePoint[]> {
    const t = ticker.toUpperCase();
    const key = `ticker:prices:${t}:${range}`;
    const ttl = range === '1Y' ? TTL.prices1Y : TTL.prices5Y;

    const cached = await cacheGet<PricePoint[]>(this.deps.redis, key);
    if (cached) return cached;

    if (await isFresh(this.deps.db, 'prices', t, ttl)) {
      const rows = await this.readDb(t, range);
      if (rows.length > 0) {
        await this.deps.redis.set(key, rows, ttl);
        return rows;
      }
    }

    return this.refresh(t, range);
  }

  async refresh(ticker: string, range: '1Y' | '5Y'): Promise<PricePoint[]> {
    const t = ticker.toUpperCase();
    const key = `ticker:prices:${t}:${range}`;
    let data: PricePoint[];
    let source: 'financial_datasets' | 'yfinance';

    try {
      data = await this.deps.primary.prices(t, range);
      source = 'financial_datasets';
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof ValidationError) throw err;
      if (err instanceof RateLimitError || err instanceof ProviderError) {
        logger.warn(
          { ticker: t, err: String(err) },
          'prices: falling back to yfinance'
        );
        data = await this.deps.fallback.prices(t, range);
        source = 'yfinance';
      } else {
        throw err;
      }
    }

    await upsertPrices(
      this.deps.db,
      data.map((p) => ({
        ticker: t,
        date: p.date,
        open: p.open?.toString() ?? null,
        high: p.high?.toString() ?? null,
        low: p.low?.toString() ?? null,
        close: p.close.toString(),
        adjClose: p.adjClose?.toString() ?? null,
        volume: p.volume != null ? BigInt(Math.trunc(p.volume)) : null,
        source
      }))
    );

    const ttl = range === '1Y' ? TTL.prices1Y : TTL.prices5Y;
    await this.deps.redis.set(key, data, ttl);
    return data;
  }

  private async readDb(ticker: string, range: '1Y' | '5Y'): Promise<PricePoint[]> {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - (range === '1Y' ? 1 : 5));
    const rows = await this.deps.db
      .select()
      .from(pricesTable)
      .where(eq(pricesTable.ticker, ticker))
      .orderBy(asc(pricesTable.date));
    return rows
      .filter((r) => new Date(r.date) >= cutoff)
      .map((r) => ({
        date: r.date,
        open: r.open ? Number(r.open) : null,
        high: r.high ? Number(r.high) : null,
        low: r.low ? Number(r.low) : null,
        close: Number(r.close),
        adjClose: r.adjClose ? Number(r.adjClose) : null,
        volume: r.volume != null ? Number(r.volume) : null
      }));
  }
}
