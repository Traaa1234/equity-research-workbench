import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { journalPositions, journalEntries, companies } from '@/lib/db/schema';
import { JournalService } from '@/lib/services/journal';
import { randomUUID } from 'node:crypto';

config({ path: '.env.local' });

describe('JournalService — positions', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  let svc: JournalService;
  beforeAll(() => {
    dbH = makeTestServiceDb();
    svc = new JournalService({ db: dbH.db });
  });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await dbH.db.execute(sql`TRUNCATE TABLE journal_positions, journal_entries, companies RESTART IDENTITY CASCADE`);
    await dbH.db.insert(companies).values([
      { ticker: 'AAPL', name: 'Apple Inc.' },
      { ticker: 'NVDA', name: 'NVIDIA Corporation' }
    ]);
  });

  it('createPosition + listPositions round trip', async () => {
    const userId = randomUUID();
    const created = await svc.createPosition(userId, {
      ticker: 'AAPL', openedAt: '2024-01-15', convictionAtOpen: 8, targetPrice: 250
    });
    expect(created.userId).toBe(userId);
    expect(created.status).toBe('open');
    const list = await svc.listPositions(userId);
    expect(list).toHaveLength(1);
    expect(list[0]!.ticker).toBe('AAPL');
    expect(Number(list[0]!.targetPrice)).toBe(250);
  });

  it('listPositions does not return another users positions', async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    await svc.createPosition(userA, { ticker: 'AAPL', openedAt: '2024-01-15' });
    await svc.createPosition(userB, { ticker: 'NVDA', openedAt: '2024-02-01' });
    const aList = await svc.listPositions(userA);
    expect(aList).toHaveLength(1);
    expect(aList[0]!.ticker).toBe('AAPL');
  });

  it('listPositions filters by status', async () => {
    const userId = randomUUID();
    const p1 = await svc.createPosition(userId, { ticker: 'AAPL', openedAt: '2024-01-15' });
    await svc.createPosition(userId, { ticker: 'NVDA', openedAt: '2024-02-01' });
    await svc.closePosition(userId, p1.id, { closedAt: '2024-06-01' });
    const open = await svc.listPositions(userId, { status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]!.ticker).toBe('NVDA');
    const closed = await svc.listPositions(userId, { status: 'closed' });
    expect(closed).toHaveLength(1);
    expect(closed[0]!.ticker).toBe('AAPL');
  });

  it('listPositions filters by minConviction', async () => {
    const userId = randomUUID();
    await svc.createPosition(userId, { ticker: 'AAPL', openedAt: '2024-01-15', convictionAtOpen: 9 });
    await svc.createPosition(userId, { ticker: 'NVDA', openedAt: '2024-02-01', convictionAtOpen: 5 });
    const high = await svc.listPositions(userId, { minConviction: 8 });
    expect(high).toHaveLength(1);
    expect(high[0]!.ticker).toBe('AAPL');
  });

  it('updatePosition updates target/stop', async () => {
    const userId = randomUUID();
    const created = await svc.createPosition(userId, { ticker: 'AAPL', openedAt: '2024-01-15' });
    const updated = await svc.updatePosition(userId, created.id, { targetPrice: 300, stopPrice: 150 });
    expect(Number(updated.targetPrice)).toBe(300);
    expect(Number(updated.stopPrice)).toBe(150);
  });

  it('updatePosition does not affect other user positions', async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    const a = await svc.createPosition(userA, { ticker: 'AAPL', openedAt: '2024-01-15' });
    await expect(svc.updatePosition(userB, a.id, { targetPrice: 999 })).rejects.toThrow(/not found|permission/i);
  });

  it('closePosition sets status + closedAt + optional exit entry', async () => {
    const userId = randomUUID();
    const created = await svc.createPosition(userId, { ticker: 'AAPL', openedAt: '2024-01-15' });
    const result = await svc.closePosition(userId, created.id, {
      closedAt: '2024-06-01',
      exitEntry: { kind: 'exit', occurredAt: '2024-06-01', thesisMd: 'Took profits.', outcome: 'right' }
    });
    expect(result.status).toBe('closed');
    expect(result.closedAt).toBe('2024-06-01');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.outcome).toBe('right');
  });

  it('deletePosition removes the row (cascade removes entries)', async () => {
    const userId = randomUUID();
    const created = await svc.createPosition(userId, { ticker: 'AAPL', openedAt: '2024-01-15' });
    await svc.createEntry(userId, created.id, { kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'x' });
    await svc.deletePosition(userId, created.id);
    const list = await svc.listPositions(userId);
    expect(list).toHaveLength(0);
    const entries = await dbH.db.select().from(journalEntries);
    expect(entries).toHaveLength(0);
  });
});
