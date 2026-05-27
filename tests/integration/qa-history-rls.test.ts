// tests/integration/qa-history-rls.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, makeTestUserDb, newUserId, resetDb } from '../helpers/test-db';
import { qaHistory } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('RLS: qa_history (user-scoped)', () => {
  let svc: ReturnType<typeof makeTestServiceDb>;
  let user: ReturnType<typeof makeTestUserDb>;
  let aliceUid: string;
  let bobUid: string;

  beforeAll(() => { svc = makeTestServiceDb(); user = makeTestUserDb(); });
  afterAll(async () => { await svc.close(); await user.close(); });

  beforeEach(async () => {
    await resetDb(svc.db);
    aliceUid = newUserId();
    bobUid = newUserId();
    // Seed one row per user as service_role (BYPASSRLS)
    await svc.db.insert(qaHistory).values([
      {
        userId: aliceUid,
        scopeType: 'watchlist',
        scopeTicker: null,
        query: "Alice's question",
        answerText: "Alice's answer",
        citations: [],
        model: 'gemini-2.5-flash',
        promptVersion: 'v1'
      },
      {
        userId: bobUid,
        scopeType: 'watchlist',
        scopeTicker: null,
        query: "Bob's question",
        answerText: "Bob's answer",
        citations: [],
        model: 'gemini-2.5-flash',
        promptVersion: 'v1'
      }
    ]);
  });

  it('alice can SELECT her own qa_history row', async () => {
    const rows = await user.asUser(aliceUid, async (tx) => {
      return tx.select().from(qaHistory);
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(aliceUid);
    expect(rows[0]!.query).toBe("Alice's question");
  });

  it("alice CANNOT see bob's qa_history row", async () => {
    const rows = await user.asUser(aliceUid, async (tx) => {
      return tx.select().from(qaHistory);
    });
    expect(rows.every((r) => r.userId === aliceUid)).toBe(true);
    expect(rows.some((r) => r.userId === bobUid)).toBe(false);
  });

  it('authenticated role cannot INSERT into qa_history', async () => {
    await expect(
      user.asUser(aliceUid, async (tx) =>
        tx.insert(qaHistory).values({
          userId: aliceUid,
          scopeType: 'watchlist',
          scopeTicker: null,
          query: 'should fail',
          answerText: 'should fail',
          citations: [],
          model: 'gemini-2.5-flash',
          promptVersion: 'v1'
        })
      )
    ).rejects.toThrow();
  });
});
