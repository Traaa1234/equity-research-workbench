import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { journalPositions, journalEntries, companies } from '@/lib/db/schema';
import { randomUUID } from 'node:crypto';

config({ path: '.env.local' });

describe('journal schema', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await dbH.db.execute(sql`TRUNCATE TABLE journal_positions, journal_entries, companies RESTART IDENTITY CASCADE`);
  });

  it('inserts a position + entries and reads them back', async () => {
    const userId = randomUUID();
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    const [pos] = await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15',
      convictionAtOpen: 8, targetPrice: '250.00', stopPrice: '180.00', expectedHoldingDays: 365
    }).returning();
    expect(pos!.id).toBeDefined();
    expect(pos!.status).toBe('open');

    await dbH.db.insert(journalEntries).values({
      positionId: pos!.id, kind: 'entry', occurredAt: '2024-01-15',
      thesisMd: 'AI-capex thesis', convictionAtTime: 8
    });
    const entries = await dbH.db.select().from(journalEntries);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.thesisMd).toBe('AI-capex thesis');
  });

  it('cascade-deletes entries when position is dropped', async () => {
    const userId = randomUUID();
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    const [pos] = await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    }).returning();
    await dbH.db.insert(journalEntries).values({
      positionId: pos!.id, kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'x'
    });
    await dbH.db.delete(journalPositions).where(sql`id = ${pos!.id}`);
    const entries = await dbH.db.select().from(journalEntries);
    expect(entries).toHaveLength(0);
  });

  it('cascade-deletes positions when ticker is dropped from companies', async () => {
    const userId = randomUUID();
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    });
    await dbH.db.delete(companies).where(sql`ticker = 'AAPL'`);
    const positions = await dbH.db.select().from(journalPositions);
    expect(positions).toHaveLength(0);
  });
});
