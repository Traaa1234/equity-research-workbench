import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb, makeTestUserDb, newUserId } from '../helpers/test-db';
import { journalPositions, journalEntries, companies } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('journal RLS', () => {
  let svcH: ReturnType<typeof makeTestServiceDb>;
  let userH: ReturnType<typeof makeTestUserDb>;
  beforeAll(() => { svcH = makeTestServiceDb(); userH = makeTestUserDb(); });
  afterAll(async () => { await svcH.close(); await userH.close(); });
  beforeEach(async () => {
    await svcH.db.execute(sql`TRUNCATE TABLE journal_positions, journal_entries, companies RESTART IDENTITY CASCADE`);
    await svcH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
  });

  it('user A can SELECT own positions, not user Bs', async () => {
    const userA = newUserId();
    const userB = newUserId();
    const [posA] = await svcH.db.insert(journalPositions).values({
      userId: userA, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    }).returning();
    const [posB] = await svcH.db.insert(journalPositions).values({
      userId: userB, ticker: 'AAPL', status: 'open', openedAt: '2024-02-01'
    }).returning();
    expect(posA!.id).toBeDefined();
    expect(posB!.id).toBeDefined();

    const aRows = await userH.asUser(userA, async (tx) => tx.select().from(journalPositions));
    expect(aRows).toHaveLength(1);
    expect(aRows[0]!.userId).toBe(userA);

    const bRows = await userH.asUser(userB, async (tx) => tx.select().from(journalPositions));
    expect(bRows).toHaveLength(1);
    expect(bRows[0]!.userId).toBe(userB);
  });

  it('user A can SELECT entries on own positions, not user Bs', async () => {
    const userA = newUserId();
    const userB = newUserId();
    const [posA] = await svcH.db.insert(journalPositions).values({
      userId: userA, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    }).returning();
    const [posB] = await svcH.db.insert(journalPositions).values({
      userId: userB, ticker: 'AAPL', status: 'open', openedAt: '2024-02-01'
    }).returning();
    await svcH.db.insert(journalEntries).values([
      { positionId: posA!.id, kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'A thesis' },
      { positionId: posB!.id, kind: 'entry', occurredAt: '2024-02-01', thesisMd: 'B thesis' }
    ]);

    const aEntries = await userH.asUser(userA, async (tx) => tx.select().from(journalEntries));
    expect(aEntries).toHaveLength(1);
    expect(aEntries[0]!.thesisMd).toBe('A thesis');
  });

  it('authenticated user cannot INSERT positions directly', async () => {
    const userA = newUserId();
    let caught: unknown;
    try {
      await userH.asUser(userA, async (tx) =>
        tx.insert(journalPositions).values({
          userId: userA, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
        })
      );
    } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    const msg = (caught as Error).message + String((caught as { cause?: unknown })?.cause ?? '');
    expect(msg).toMatch(/permission denied|policy/i);
  });
});
