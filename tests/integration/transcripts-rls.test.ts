import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb, makeTestUserDb, newUserId } from '../helpers/test-db';
import { transcripts, transcriptChunks, transcriptFreshness, companies } from '@/lib/db/schema';

config({ path: '.env.local' });

function vec(): number[] {
  const v = new Array(1024).fill(0);
  v[0] = 1;
  return v;
}

describe('transcripts RLS', () => {
  let svcH: ReturnType<typeof makeTestServiceDb>;
  let userH: ReturnType<typeof makeTestUserDb>;
  beforeAll(() => { svcH = makeTestServiceDb(); userH = makeTestUserDb(); });
  afterAll(async () => { await svcH.close(); await userH.close(); });
  beforeEach(async () => {
    await svcH.db.execute(sql`TRUNCATE TABLE transcripts, transcript_chunks, transcript_freshness, companies RESTART IDENTITY CASCADE`);
    await svcH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    await svcH.db.insert(transcripts).values({
      id: 'AAPL-2024-Q3', ticker: 'AAPL', fiscalYear: 2024, fiscalQuarter: 3,
      callDate: '2024-10-31', sourceUrl: 'https://x'
    });
    await svcH.db.insert(transcriptChunks).values({
      transcriptId: 'AAPL-2024-Q3', sectionIndex: 0, sectionKind: 'prepared',
      speaker: 'X', role: null, text: 'x', embedding: vec(), model: 'text-embedding-v4'
    });
  });

  it('authenticated user can SELECT transcripts', async () => {
    const userId = newUserId();
    const rows = await userH.asUser(userId, async (tx) => tx.select().from(transcripts));
    expect(rows).toHaveLength(1);
  });

  it('authenticated user can SELECT transcript_chunks', async () => {
    const userId = newUserId();
    const rows = await userH.asUser(userId, async (tx) => tx.select().from(transcriptChunks));
    expect(rows).toHaveLength(1);
  });

  it('authenticated user cannot INSERT transcripts', async () => {
    const userId = newUserId();
    let caught: unknown;
    try {
      await userH.asUser(userId, async (tx) =>
        tx.insert(transcripts).values({
          id: 'AAPL-2024-Q2', ticker: 'AAPL', fiscalYear: 2024, fiscalQuarter: 2,
          callDate: '2024-07-25', sourceUrl: 'https://y'
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // Drizzle 0.45+ wraps the PostgresError in a DrizzleQueryError (.cause).
    // The underlying Postgres message is "permission denied for table transcripts".
    const msg = (caught as Error).message + String((caught as { cause?: unknown })?.cause ?? '');
    expect(msg).toMatch(/permission denied|policy/i);
  });
});
