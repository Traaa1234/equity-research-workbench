import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { journalPositions, journalEntries, companies } from '@/lib/db/schema';
import { randomUUID } from 'node:crypto';

config({ path: '.env.local' });

vi.mock('@/lib/auth/current-user', () => ({
  requireUserId: vi.fn(),
  UnauthorizedError: class UnauthorizedError extends Error {}
}));
vi.mock('@/lib/db/client', () => ({ getServiceDb: vi.fn() }));

import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { POST as listEntriesPOST } from '@/app/api/journal/positions/[id]/entries/route';
import { PATCH as entryPATCH, DELETE as entryDELETE } from '@/app/api/journal/entries/[id]/route';

describe('journal entries API', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  const userId = randomUUID();
  let positionId: bigint;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    vi.mocked(getServiceDb).mockReturnValue(dbH.db as any);
    vi.mocked(requireUserId).mockResolvedValue(userId);
    await dbH.db.execute(sql`TRUNCATE TABLE journal_positions, journal_entries, companies RESTART IDENTITY CASCADE`);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    const [pos] = await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    }).returning();
    positionId = pos!.id;
  });

  it('POST /positions/[id]/entries creates an entry (201)', async () => {
    const req = new Request(`http://localhost/api/journal/positions/${positionId}/entries`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'review', occurredAt: '2024-03-01', thesisMd: 'still bullish' })
    });
    const res = await listEntriesPOST(req, { params: { id: String(positionId) } });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.kind).toBe('review');
  });

  it('PATCH /entries/[id] updates fields', async () => {
    const [e] = await dbH.db.insert(journalEntries).values({
      positionId, kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'original'
    }).returning();
    const req = new Request(`http://localhost/api/journal/entries/${e!.id}`, {
      method: 'PATCH', body: JSON.stringify({ thesisMd: 'updated' })
    });
    const res = await entryPATCH(req, { params: { id: String(e!.id) } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.thesisMd).toBe('updated');
  });

  it('DELETE /entries/[id] returns 204', async () => {
    const [e] = await dbH.db.insert(journalEntries).values({
      positionId, kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'x'
    }).returning();
    const req = new Request(`http://localhost/api/journal/entries/${e!.id}`, { method: 'DELETE' });
    const res = await entryDELETE(req, { params: { id: String(e!.id) } });
    expect(res.status).toBe(204);
  });

  it('POST entry rejects with 400 on invalid kind', async () => {
    const req = new Request(`http://localhost/api/journal/positions/${positionId}/entries`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'invalid', occurredAt: '2024-03-01', thesisMd: 'x' })
    });
    const res = await listEntriesPOST(req, { params: { id: String(positionId) } });
    expect(res.status).toBe(400);
  });

  it('POST entry rejects with 401 unauthenticated', async () => {
    vi.mocked(requireUserId).mockRejectedValueOnce(new Error('no auth'));
    const req = new Request(`http://localhost/api/journal/positions/${positionId}/entries`, {
      method: 'POST', body: JSON.stringify({ kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'x' })
    });
    const res = await listEntriesPOST(req, { params: { id: String(positionId) } });
    expect(res.status).toBe(401);
  });

  it('PATCH entry rejects on another users entry', async () => {
    const otherUser = randomUUID();
    const [otherPos] = await dbH.db.insert(journalPositions).values({
      userId: otherUser, ticker: 'AAPL', status: 'open', openedAt: '2024-02-01'
    }).returning();
    const [theirEntry] = await dbH.db.insert(journalEntries).values({
      positionId: otherPos!.id, kind: 'entry', occurredAt: '2024-02-01', thesisMd: 'theirs'
    }).returning();
    const req = new Request(`http://localhost/api/journal/entries/${theirEntry!.id}`, {
      method: 'PATCH', body: JSON.stringify({ thesisMd: 'overwrite' })
    });
    const res = await entryPATCH(req, { params: { id: String(theirEntry!.id) } });
    expect([403, 404]).toContain(res.status);
  });
});
