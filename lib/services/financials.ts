import { and, desc, eq } from 'drizzle-orm';
import { fundamentals } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import { isFresh, upsertFundamentals } from '@/lib/cache/postgres';
import { TTL } from '@/lib/cache/ttls';
import { RedisCache } from '@/lib/cache/redis';
import {
  NotFoundError,
  PeriodType,
  Provider,
  ProviderError,
  RateLimitError,
  StatementBundle,
  StatementType,
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

export class FinancialsService {
  constructor(private readonly deps: Deps) {}

  async get(
    ticker: string,
    type: StatementType,
    period: PeriodType
  ): Promise<StatementBundle> {
    const t = ticker.toUpperCase();
    const key = `ticker:financials:${t}:${type}:${period}`;
    const ttl = period === 'annual' ? TTL.financialsAnnual : TTL.financialsQuarterly;

    const cached = await cacheGet<StatementBundle>(this.deps.redis, key);
    if (cached) return cached;

    if (await isFresh(this.deps.db, 'fundamentals', t, ttl)) {
      const bundle = await this.readDb(t, type, period);
      if (bundle.rows.length > 0) {
        await this.deps.redis.set(key, bundle, ttl);
        return bundle;
      }
    }

    return this.refresh(t, type, period);
  }

  async refresh(
    ticker: string,
    type: StatementType,
    period: PeriodType
  ): Promise<StatementBundle> {
    const t = ticker.toUpperCase();
    const key = `ticker:financials:${t}:${type}:${period}`;
    let bundle: StatementBundle;
    let source: 'financial_datasets' | 'yfinance';

    try {
      bundle = await this.deps.primary.statements(t, type, period);
      source = 'financial_datasets';
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof ValidationError) throw err;
      if (err instanceof RateLimitError || err instanceof ProviderError) {
        logger.warn(
          { ticker: t, err: String(err) },
          'financials: falling back to yfinance'
        );
        bundle = await this.deps.fallback.statements(t, type, period);
        source = 'yfinance';
      } else {
        throw err;
      }
    }

    await upsertFundamentals(
      this.deps.db,
      bundle.rows.map((r) => ({
        ticker: t,
        periodEnd: r.periodEnd,
        periodType: period,
        statementType: type,
        lineItem: r.lineItem,
        value: r.value?.toString() ?? null,
        currency: r.currency,
        source
      }))
    );

    const ttl = period === 'annual' ? TTL.financialsAnnual : TTL.financialsQuarterly;
    await this.deps.redis.set(key, bundle, ttl);
    return bundle;
  }

  private async readDb(
    ticker: string,
    type: StatementType,
    period: PeriodType
  ): Promise<StatementBundle> {
    const rows = await this.deps.db
      .select()
      .from(fundamentals)
      .where(
        and(
          eq(fundamentals.ticker, ticker),
          eq(fundamentals.statementType, type),
          eq(fundamentals.periodType, period)
        )
      )
      .orderBy(desc(fundamentals.periodEnd));
    return {
      ticker,
      statementType: type,
      periodType: period,
      rows: rows.map((r) => ({
        periodEnd: r.periodEnd,
        lineItem: r.lineItem,
        value: r.value ? Number(r.value) : null,
        currency: r.currency
      }))
    };
  }
}
