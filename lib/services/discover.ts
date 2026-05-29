import { z } from 'zod';
import { sql, eq, and, inArray, gte, lte, isNotNull } from 'drizzle-orm';
import type { ServiceDb } from '@/lib/db/client';
import type { QwenProvider, EmbeddingsProvider } from '@/lib/providers/types';
import type { RedisCache } from '@/lib/cache/redis';
import { companiesUniverse } from '@/lib/db/schema';
import { PARSE_QUERY_SYSTEM_PROMPT, PARSE_QUERY_USER_PROMPT_TEMPLATE } from './discover-prompts';
import { logger } from '@/lib/logger';

// ----- Types -----

export interface ParsedQuery {
  country: string | null;
  sector: string | null;
  industry: string | null;
  exchanges: string[];
  conceptText: string;
  marketCapMin: number | null;
  marketCapMax: number | null;
}

export interface DiscoverResult {
  ticker: string;
  name: string;
  exchange: string | null;
  country: string | null;
  sector: string | null;
  industry: string | null;
  description: string | null;
  marketCap: number | null;
  similarity: number;
}

interface Deps {
  db: ServiceDb;
  qwenProvider: QwenProvider;
  embeddingsProvider: EmbeddingsProvider;
  redis: RedisCache;
}

// ----- Zod schema for LLM response validation -----

const ISO_COUNTRY = /^[A-Z]{2}$/;
const VALID_EXCHANGES = new Set(['NYSE', 'NASDAQ']);

const parsedQuerySchema = z.object({
  country: z.string().nullable().transform((v) => (v && ISO_COUNTRY.test(v) ? v : null)),
  sector: z.string().nullable(),
  industry: z.string().nullable(),
  exchanges: z.array(z.string()).transform((arr) => arr.filter((e) => VALID_EXCHANGES.has(e))),
  conceptText: z.string(),
  marketCapMin: z.number().positive().nullable(),
  marketCapMax: z.number().positive().nullable()
});

function stripCodeFences(text: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const match = text.trim().match(fence);
  return match ? match[1]!.trim() : text.trim();
}

function fallbackParsed(originalQuery: string): ParsedQuery {
  return {
    country: null,
    sector: null,
    industry: null,
    exchanges: [],
    conceptText: originalQuery,
    marketCapMin: null,
    marketCapMax: null
  };
}

// ----- Service -----

export class DiscoverService {
  constructor(private readonly deps: Deps) {}

  async parseQuery(userQuery: string): Promise<ParsedQuery> {
    const trimmed = userQuery.trim();
    if (!trimmed) return fallbackParsed('');

    let raw: string;
    try {
      const result = await this.deps.qwenProvider.summarize({
        model: 'qwen-turbo',
        systemPrompt: PARSE_QUERY_SYSTEM_PROMPT,
        userPrompt: PARSE_QUERY_USER_PROMPT_TEMPLATE(trimmed),
        maxTokens: 400
      });
      raw = stripCodeFences(result.text);
    } catch (err) {
      logger.warn({ err: String(err), query: trimmed }, 'discover.parseQuery: LLM call failed');
      return fallbackParsed(trimmed);
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      logger.warn({ raw, query: trimmed }, 'discover.parseQuery: invalid JSON');
      return fallbackParsed(trimmed);
    }

    const validated = parsedQuerySchema.safeParse(json);
    if (!validated.success) {
      logger.warn({ issues: validated.error.issues, query: trimmed }, 'discover.parseQuery: schema validation failed');
      return fallbackParsed(trimmed);
    }
    const out = validated.data;
    if (!out.conceptText.trim()) out.conceptText = trimmed;
    return out;
  }

  async search(
    userQuery: string,
    limit = 20,
    prefetchedParsed?: ParsedQuery
  ): Promise<DiscoverResult[]> {
    const trimmed = userQuery.trim();
    if (!trimmed) return [];

    const parsed = prefetchedParsed ?? await this.parseQuery(trimmed);
    if (!parsed.conceptText.trim()) return [];

    // 1. Embed conceptText (Qwen text-embedding-v4, 1024-d).
    const embedResult = await this.deps.embeddingsProvider.embed({
      model: 'text-embedding-v4',
      texts: [parsed.conceptText]
    });
    const queryVec = embedResult.vectors[0];
    if (!queryVec) {
      logger.warn({ query: trimmed }, 'discover.search: empty embedding response');
      return [];
    }

    const queryVecLit = '[' + queryVec.join(',') + ']';

    // 2. Build WHERE clause from parsed filters. Description embedding must be non-null.
    const conditions = [isNotNull(companiesUniverse.descriptionEmbedding)];
    if (parsed.country) conditions.push(eq(companiesUniverse.country, parsed.country));
    if (parsed.sector) conditions.push(eq(companiesUniverse.sector, parsed.sector));
    if (parsed.industry) conditions.push(eq(companiesUniverse.industry, parsed.industry));
    if (parsed.exchanges.length > 0) conditions.push(inArray(companiesUniverse.exchange, parsed.exchanges));
    if (parsed.marketCapMin != null) conditions.push(gte(companiesUniverse.marketCap, String(parsed.marketCapMin)));
    if (parsed.marketCapMax != null) conditions.push(lte(companiesUniverse.marketCap, String(parsed.marketCapMax)));

    // 3. Run prefilter + vector ranking.
    const rows = await this.deps.db
      .select({
        ticker: companiesUniverse.ticker,
        name: companiesUniverse.name,
        exchange: companiesUniverse.exchange,
        country: companiesUniverse.country,
        sector: companiesUniverse.sector,
        industry: companiesUniverse.industry,
        description: companiesUniverse.description,
        marketCap: companiesUniverse.marketCap,
        similarity: sql<number>`1 - (${companiesUniverse.descriptionEmbedding} <=> ${queryVecLit}::vector)`
      })
      .from(companiesUniverse)
      .where(and(...conditions))
      .orderBy(sql`${companiesUniverse.descriptionEmbedding} <=> ${queryVecLit}::vector`)
      .limit(limit);

    const hasStructuredFilter = parsed.country || parsed.sector || parsed.industry || parsed.exchanges.length > 0 || parsed.marketCapMin != null || parsed.marketCapMax != null;

    // 4. Fallback to full-universe scan when prefilter yielded zero rows
    if (rows.length === 0 && hasStructuredFilter) {
      const fallbackRows = await this.deps.db
        .select({
          ticker: companiesUniverse.ticker,
          name: companiesUniverse.name,
          exchange: companiesUniverse.exchange,
          country: companiesUniverse.country,
          sector: companiesUniverse.sector,
          industry: companiesUniverse.industry,
          description: companiesUniverse.description,
          marketCap: companiesUniverse.marketCap,
          similarity: sql<number>`1 - (${companiesUniverse.descriptionEmbedding} <=> ${queryVecLit}::vector)`
        })
        .from(companiesUniverse)
        .where(isNotNull(companiesUniverse.descriptionEmbedding))
        .orderBy(sql`${companiesUniverse.descriptionEmbedding} <=> ${queryVecLit}::vector`)
        .limit(limit);
      return fallbackRows.map((r) => ({
        ...r,
        marketCap: r.marketCap == null ? null : Number(r.marketCap),
        similarity: Number(r.similarity)
      }));
    }

    return rows.map((r) => ({
      ...r,
      marketCap: r.marketCap == null ? null : Number(r.marketCap),
      similarity: Number(r.similarity)
    }));
  }
}
