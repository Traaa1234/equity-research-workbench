import { and, eq, sql } from 'drizzle-orm';
import { filings, chunkEmbeddings, refreshRuns } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import { EmbeddingsProvider, ValidationError } from '@/lib/providers/types';
import { logger } from '@/lib/logger';
import { FilingsService } from './filings';
import { subChunk } from './chunking';

export const CURRENT_EMBED_MODEL = 'text-embedding-v3';
// DashScope text-embedding-v3 caps batches at 10 texts per /embeddings call
// (returns InternalError.Algo.InvalidParameter for batches >10). The spec
// originally listed 25 based on an older docs version — corrected here.
const BATCH_SIZE = 10;
const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 50;

interface Deps {
  db: ServiceDb;
  provider: EmbeddingsProvider;
  filingsService: FilingsService;
}

export interface EmbedFilingResult {
  filingId: string;
  count: number;
  durationMs: number;
}

export class EmbeddingsService {
  constructor(private readonly deps: Deps) {}

  async embedFiling(filingId: string): Promise<EmbedFilingResult> {
    const started = Date.now();

    // Cache check: do current-model rows exist?
    const existing = await this.deps.db
      .select({ c: sql<number>`count(*)::int` })
      .from(chunkEmbeddings)
      .where(and(eq(chunkEmbeddings.filingId, filingId), eq(chunkEmbeddings.model, CURRENT_EMBED_MODEL)));
    const existingCount = existing[0]?.c ?? 0;
    if (existingCount > 0) {
      return { filingId, count: 0, durationMs: Date.now() - started };
    }

    // Look up filing for ticker (needed for refresh_runs)
    const filingRows = await this.deps.db.select().from(filings).where(eq(filings.accessionNo, filingId)).limit(1);
    if (filingRows.length === 0) {
      throw new ValidationError(`Filing not found: ${filingId}`);
    }
    const filing = filingRows[0]!;

    // Fetch sections + sub-chunk
    const sections = await this.deps.filingsService.getAllSectionTexts(filingId);
    if (sections.length === 0) {
      return { filingId, count: 0, durationMs: Date.now() - started };
    }

    interface PreparedChunk {
      sectionKey: string;
      subChunkIndex: number;
      text: string;
      charOffsetStart: number;
      charOffsetEnd: number;
    }
    const prepared: PreparedChunk[] = [];
    for (const section of sections) {
      const windows = subChunk(section.text, { targetTokens: TARGET_TOKENS, overlapTokens: OVERLAP_TOKENS });
      for (let i = 0; i < windows.length; i++) {
        const w = windows[i]!;
        prepared.push({
          sectionKey: section.sectionKey,
          subChunkIndex: i,
          text: w.text,
          charOffsetStart: w.charOffsetStart,
          charOffsetEnd: w.charOffsetEnd
        });
      }
    }

    if (prepared.length === 0) {
      return { filingId, count: 0, durationMs: Date.now() - started };
    }

    try {
      // Batch + embed + insert
      for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
        const batch = prepared.slice(i, i + BATCH_SIZE);
        const result = await this.deps.provider.embed({
          model: CURRENT_EMBED_MODEL,
          texts: batch.map((p) => p.text)
        });
        if (result.vectors.length !== batch.length) {
          throw new Error(`Provider returned ${result.vectors.length} vectors for ${batch.length} inputs`);
        }
        const rows = batch.map((p, j) => ({
          filingId,
          sectionKey: p.sectionKey,
          subChunkIndex: p.subChunkIndex,
          text: p.text,
          embedding: result.vectors[j]!,
          charOffsetStart: p.charOffsetStart,
          charOffsetEnd: p.charOffsetEnd,
          model: CURRENT_EMBED_MODEL
        }));
        await this.deps.db.insert(chunkEmbeddings).values(rows).onConflictDoNothing();
      }

      await this.deps.db.insert(refreshRuns).values({
        ticker: filing.ticker,
        kind: `embed:${filingId}`,
        startedAt: new Date(started),
        completedAt: new Date(),
        ok: true,
        sourceUsed: 'dashscope_embed'
      });

      return { filingId, count: prepared.length, durationMs: Date.now() - started };
    } catch (err) {
      await this.deps.db.insert(refreshRuns).values({
        ticker: filing.ticker,
        kind: `embed:${filingId}`,
        startedAt: new Date(started),
        completedAt: new Date(),
        ok: false,
        sourceUsed: 'dashscope_embed',
        error: String(err).slice(0, 1000)
      });
      logger.warn({ filingId, err: String(err) }, 'embeddings: embedFiling failed');
      throw err;
    }
  }
}
