import { and, desc, eq } from 'drizzle-orm';
import { watchlist } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';

export interface WatchlistEntry {
  ticker: string;
}

export class WatchlistService {
  constructor(private readonly db: ServiceDb) {}

  async list(userId: string): Promise<WatchlistEntry[]> {
    const rows = await this.db
      .select({ ticker: watchlist.ticker })
      .from(watchlist)
      .where(eq(watchlist.userId, userId))
      .orderBy(desc(watchlist.addedAt));
    return rows;
  }

  async add(userId: string, ticker: string): Promise<void> {
    await this.db
      .insert(watchlist)
      .values({ userId, ticker: ticker.toUpperCase() })
      .onConflictDoNothing();
  }

  async remove(userId: string, ticker: string): Promise<void> {
    await this.db
      .delete(watchlist)
      .where(and(eq(watchlist.userId, userId), eq(watchlist.ticker, ticker.toUpperCase())));
  }

  async has(userId: string, ticker: string): Promise<boolean> {
    const rows = await this.db
      .select({ ticker: watchlist.ticker })
      .from(watchlist)
      .where(and(eq(watchlist.userId, userId), eq(watchlist.ticker, ticker.toUpperCase())))
      .limit(1);
    return rows.length > 0;
  }
}
