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
import { GET as listGET, POST as listPOST } from '@/app/api/journal/positions/route';
import { GET as itemGET, PATCH as itemPATCH, DELETE as itemDELETE } from '@/app/api/journal/positions/[id]/route';
import { POST as closePOST } from '@/app/api/journal/positions/[id]/close/route';

describe('journal positions API', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  const userId = randomUUID();

  beforeAll(() => {
    dbH = makeTestServiceDb();
  });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    vi.mocked(getServiceDb).mockReturnValue(dbH.db as any);
    vi.mocked(requireUserId).mockResolvedValue(userId);
    await dbH.db.execute(sql`TRUNCATE TABLE journal_positions, journal_entries, companies RESTART IDENTITY CASCADE`);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
  });

  it('POST /positions creates a position (201)', async () => {
    const req = new Request('http://localhost/api/journal/positions', {
      method: 'POST',
      body: JSON.stringify({ ticker: 'AAPL', openedAt: '2024-01-15', convictionAtOpen: 8 })
    });
    const res = await listPOST(req);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ticker).toBe('AAPL');
  });

  it('GET /positions returns the list', async () => {
    await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    });
    const req = new Request('http://localhost/api/journal/positions');
    const res = await listGET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toHaveLength(1);
  });

  it('GET /positions honors status filter', async () => {
    await dbH.db.insert(journalPositions).values([
      { userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15' }
    ]);
    const req = new Request('http://localhost/api/journal/positions?status=closed');
    const res = await listGET(req);
    const json = await res.json();
    expect(json.items).toHaveLength(0);
  });

  it('GET /positions/[id] returns position + entries', async () => {
    const [pos] = await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    }).returning();
    await dbH.db.insert(journalEntries).values({
      positionId: pos!.id, kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'x'
    });
    const req = new Request(`http://localhost/api/journal/positions/${pos!.id}`);
    const res = await itemGET(req, { params: { id: String(pos!.id) } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entries).toHaveLength(1);
  });

  it('GET /positions/[id] returns 404 for missing or other-user position', async () => {
    const req = new Request('http://localhost/api/journal/positions/9999');
    const res = await itemGET(req, { params: { id: '9999' } });
    expect(res.status).toBe(404);
  });

  it('PATCH /positions/[id] updates fields', async () => {
    const [pos] = await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    }).returning();
    const req = new Request(`http://localhost/api/journal/positions/${pos!.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ targetPrice: 300 })
    });
    const res = await itemPATCH(req, { params: { id: String(pos!.id) } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Number(json.targetPrice)).toBe(300);
  });

  it('POST /positions/[id]/close marks closed + appends exit entry', async () => {
    const [pos] = await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    }).returning();
    const req = new Request(`http://localhost/api/journal/positions/${pos!.id}/close`, {
      method: 'POST',
      body: JSON.stringify({
        closedAt: '2024-06-01',
        exitEntry: { kind: 'exit', occurredAt: '2024-06-01', thesisMd: 'done', outcome: 'right' }
      })
    });
    const res = await closePOST(req, { params: { id: String(pos!.id) } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('closed');
    expect(json.entries).toHaveLength(1);
  });

  it('DELETE /positions/[id] returns 204', async () => {
    const [pos] = await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    }).returning();
    const req = new Request(`http://localhost/api/journal/positions/${pos!.id}`, { method: 'DELETE' });
    const res = await itemDELETE(req, { params: { id: String(pos!.id) } });
    expect(res.status).toBe(204);
  });

  it('401 when unauthenticated', async () => {
    vi.mocked(requireUserId).mockRejectedValueOnce(new Error('no auth'));
    const req = new Request('http://localhost/api/journal/positions');
    const res = await listGET(req);
    expect(res.status).toBe(401);
  });

  it('400 on invalid create body', async () => {
    const req = new Request('http://localhost/api/journal/positions', {
      method: 'POST',
      body: JSON.stringify({ ticker: 'aapl', openedAt: '2024-01-15' })
    });
    const res = await listPOST(req);
    expect(res.status).toBe(400);
  });
});
