import { eq } from 'drizzle-orm';
import { snapshots } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import { isFresh, upsertSnapshot } from '@/lib/cache/postgres';
import { TTL, isUSMarketOpen } from '@/lib/cache/ttls';
import { RedisCache } from '@/lib/cache/redis';
import {
  NotFoundError,
  Provider,
  ProviderError,
  ProviderName,
  RateLimitError,
  SnapshotData,
  ValidationError
} from '@/lib/providers/types';
import { logger } from '@/lib/logger';

interface Deps {
  db: ServiceDb;
  primary: Provider;
  fallback: Provider;
  redis: RedisCache;
}

type SnapshotDTO = Omit<SnapshotData, 'asOf'> & { asOf: string };

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

export class SnapshotService {
  constructor(private readonly deps: Deps) {}

  async get(ticker: string): Promise<SnapshotData | null> {
    const t = ticker.toUpperCase();
    const key = `ticker:snapshot:${t}`;
    const ttl = isUSMarketOpen() ? TTL.snapshotInMarket : TTL.snapshotOffMarket;

    const cached = await cacheGet<SnapshotDTO>(this.deps.redis, key);
    if (cached) return hydrate(cached);

    if (await isFresh(this.deps.db, 'snapshots', t, ttl)) {
      const row = await this.readDb(t);
      if (row) {
        await this.deps.redis.set(key, dehydrate(row), ttl);
        return row;
      }
    }

    return this.refresh(t);
  }

  async refresh(ticker: string): Promise<SnapshotData> {
    const t = ticker.toUpperCase();
    const key = `ticker:snapshot:${t}`;
    let data: SnapshotData;
    let source: ProviderName;

    try {
      data = await this.deps.primary.snapshot(t);
      source = this.deps.primary.name;
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof ValidationError) throw err;
      if (err instanceof RateLimitError || err instanceof ProviderError) {
        logger.warn(
          { ticker: t, primary: this.deps.primary.name, fallback: this.deps.fallback.name, err: String(err) },
          'snapshot: falling back to secondary provider'
        );
        data = await this.deps.fallback.snapshot(t);
        source = this.deps.fallback.name;
      } else {
        throw err;
      }
    }

    await upsertSnapshot(this.deps.db, {
      ticker: t,
      price: data.price?.toString() ?? null,
      marketCap: data.marketCap?.toString() ?? null,
      week52High: data.week52High?.toString() ?? null,
      week52Low: data.week52Low?.toString() ?? null,
      pe: data.pe?.toString() ?? null,
      ps: data.ps?.toString() ?? null,
      pb: data.pb?.toString() ?? null,
      evEbitda: data.evEbitda?.toString() ?? null,
      peg: data.peg?.toString() ?? null,
      asOf: data.asOf,
      source
    });

    const ttl = isUSMarketOpen() ? TTL.snapshotInMarket : TTL.snapshotOffMarket;
    await this.deps.redis.set(key, dehydrate(data), ttl);
    return data;
  }

  private async readDb(ticker: string): Promise<SnapshotData | null> {
    const rows = await this.deps.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.ticker, ticker))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      ticker: r.ticker,
      price: r.price ? Number(r.price) : null,
      marketCap: r.marketCap ? Number(r.marketCap) : null,
      week52High: r.week52High ? Number(r.week52High) : null,
      week52Low: r.week52Low ? Number(r.week52Low) : null,
      pe: r.pe ? Number(r.pe) : null,
      ps: r.ps ? Number(r.ps) : null,
      pb: r.pb ? Number(r.pb) : null,
      evEbitda: r.evEbitda ? Number(r.evEbitda) : null,
      peg: r.peg ? Number(r.peg) : null,
      asOf: r.asOf
    };
  }
}

function dehydrate(s: SnapshotData): SnapshotDTO {
  return { ...s, asOf: s.asOf.toISOString() };
}
function hydrate(s: SnapshotDTO): SnapshotData {
  return { ...s, asOf: new Date(s.asOf) };
}
