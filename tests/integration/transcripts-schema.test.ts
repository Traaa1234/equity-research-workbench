import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { transcripts, transcriptChunks, transcriptFreshness, companies } from '@/lib/db/schema';

config({ path: '.env.local' });

function vec(): number[] {
  const v = new Array(1024).fill(0);
  v[0] = 1;
  return v;
}

describe('transcripts schema', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await dbH.db.execute(sql`TRUNCATE TABLE transcripts, transcript_chunks, transcript_freshness, companies RESTART IDENTITY CASCADE`);
  });

  it('inserts a transcript + chunks and reads them back', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    await dbH.db.insert(transcripts).values({
      id: 'AAPL-2024-Q3',
      ticker: 'AAPL',
      fiscalYear: 2024,
      fiscalQuarter: 3,
      callDate: '2024-10-31',
      sourceUrl: 'https://example.com/aapl-q3-2024'
    });
    await dbH.db.insert(transcriptChunks).values({
      transcriptId: 'AAPL-2024-Q3',
      sectionIndex: 0,
      sectionKind: 'prepared',
      speaker: 'Tim Cook',
      role: 'CEO',
      text: 'Thanks for joining us today.',
      embedding: vec(),
      model: 'text-embedding-v4'
    });
    const rows = await dbH.db.select().from(transcripts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('AAPL-2024-Q3');
    const chunks = await dbH.db.select().from(transcriptChunks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.speaker).toBe('Tim Cook');
  });

  it('cascade-deletes chunks when transcript is dropped', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    await dbH.db.insert(transcripts).values({
      id: 'AAPL-2024-Q3', ticker: 'AAPL', fiscalYear: 2024, fiscalQuarter: 3,
      callDate: '2024-10-31', sourceUrl: 'https://example.com/x'
    });
    await dbH.db.insert(transcriptChunks).values({
      transcriptId: 'AAPL-2024-Q3', sectionIndex: 0, sectionKind: 'prepared',
      speaker: 'X', role: null, text: 'x', embedding: vec(), model: 'text-embedding-v4'
    });
    await dbH.db.delete(transcripts).where(sql`id = 'AAPL-2024-Q3'`);
    const chunks = await dbH.db.select().from(transcriptChunks);
    expect(chunks).toHaveLength(0);
  });

  it('upserts freshness rows', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    await dbH.db.insert(transcriptFreshness).values({ ticker: 'AAPL', lastUrlSeen: 'https://x' });
    const rows = await dbH.db.select().from(transcriptFreshness);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastUrlSeen).toBe('https://x');
  });
});
