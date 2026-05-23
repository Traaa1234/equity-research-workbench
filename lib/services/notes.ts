import { and, eq } from 'drizzle-orm';
import { notes } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';

const MAX_NOTE_BYTES = 50_000;

export class NotesService {
  constructor(private readonly db: ServiceDb) {}

  async get(userId: string, ticker: string): Promise<string> {
    const rows = await this.db
      .select({ body: notes.body })
      .from(notes)
      .where(and(eq(notes.userId, userId), eq(notes.ticker, ticker.toUpperCase())))
      .limit(1);
    return rows[0]?.body ?? '';
  }

  async upsert(userId: string, ticker: string, body: string): Promise<void> {
    if (body.length > MAX_NOTE_BYTES) {
      throw new Error(`Note body exceeds ${MAX_NOTE_BYTES} bytes`);
    }
    await this.db
      .insert(notes)
      .values({ userId, ticker: ticker.toUpperCase(), body, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [notes.userId, notes.ticker],
        set: { body, updatedAt: new Date() }
      });
  }
}
