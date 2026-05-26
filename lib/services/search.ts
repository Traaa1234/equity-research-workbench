import { sql } from 'drizzle-orm';
import type { ServiceDb } from '@/lib/db/client';
import { EmbeddingsProvider, ValidationError } from '@/lib/providers/types';
import { CURRENT_EMBED_MODEL } from './embeddings';

// Re-export so tests/API routes can import from either service module.
export { CURRENT_EMBED_MODEL };

export const MIN_QUERY_CHARS = 1;
export const MAX_QUERY_CHARS = 500;
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;
export const DISTANCE_THRESHOLD = 0.7;

interface Deps {
  db: ServiceDb;
  provider: EmbeddingsProvider;
}

export interface SearchResult {
  ticker: string;
  companyName: string;
  accessionNo: string;
  formType: string;
  filingDate: string;
  sectionKey: string;
  sectionTitle: string;
  subChunkIndex: number;
  snippet: string;
  distance: number;
  charOffsetStart: number | null;
  charOffsetEnd: number | null;
}

interface SearchOpts {
  userId: string;
  query: string;
  limit?: number;
  formTypes?: string[];
}

export class SearchService {
  constructor(private readonly deps: Deps) {}

  async searchAcrossWatchlist(opts: SearchOpts): Promise<SearchResult[]> {
    const trimmed = opts.query.trim();
    if (trimmed.length < MIN_QUERY_CHARS) {
      throw new ValidationError('Query too short');
    }
    if (trimmed.length > MAX_QUERY_CHARS) {
      throw new ValidationError(`Query exceeds ${MAX_QUERY_CHARS} characters`);
    }
    const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));

    const embedResult = await this.deps.provider.embed({
      model: CURRENT_EMBED_MODEL,
      texts: [trimmed]
    });
    const queryVec = embedResult.vectors[0];
    if (!queryVec) throw new ValidationError('Failed to embed query');
    const queryVecLiteral = `'[${queryVec.join(',')}]'`;

    // Build the optional form_type filter as a raw SQL fragment to avoid
    // postgres.js array serialization issues with the text[] cast.
    const formTypesSql =
      opts.formTypes && opts.formTypes.length > 0
        ? sql.raw(
            `AND f.form_type IN (${opts.formTypes.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')})`
          )
        : sql.raw('');

    const rows = await this.deps.db.execute(sql`
      SELECT
        f.ticker          AS ticker,
        comp.name         AS company_name,
        f.accession_no    AS accession_no,
        f.form_type       AS form_type,
        f.filing_date::text AS filing_date,
        ce.section_key    AS section_key,
        fc.section_title  AS section_title,
        ce.sub_chunk_index AS sub_chunk_index,
        ce.text           AS snippet,
        ce.char_offset_start AS char_offset_start,
        ce.char_offset_end   AS char_offset_end,
        (ce.embedding <=> ${sql.raw(queryVecLiteral)}::vector) AS distance
      FROM chunk_embeddings ce
      JOIN filings        f    ON ce.filing_id = f.accession_no
      JOIN companies      comp ON f.ticker = comp.ticker
      JOIN filing_chunks  fc   ON fc.filing_id = f.accession_no AND fc.section_key = ce.section_key
      WHERE f.ticker IN (
        SELECT w.ticker FROM watchlist w WHERE w.user_id = ${opts.userId}::uuid
      )
        ${formTypesSql}
      ORDER BY ce.embedding <=> ${sql.raw(queryVecLiteral)}::vector
      LIMIT ${limit}
    `);

    const results: SearchResult[] = [];
    for (const r of rows as Array<Record<string, unknown>>) {
      const distance = Number(r.distance);
      if (distance > DISTANCE_THRESHOLD) continue;
      results.push({
        ticker: String(r.ticker),
        companyName: String(r.company_name),
        accessionNo: String(r.accession_no),
        formType: String(r.form_type),
        filingDate: String(r.filing_date),
        sectionKey: String(r.section_key),
        sectionTitle: String(r.section_title),
        subChunkIndex: Number(r.sub_chunk_index),
        snippet: String(r.snippet),
        distance,
        charOffsetStart: r.char_offset_start == null ? null : Number(r.char_offset_start),
        charOffsetEnd: r.char_offset_end == null ? null : Number(r.char_offset_end)
      });
    }
    return results;
  }
}
