import { z } from 'zod';
import type { ServiceDb } from '@/lib/db/client';
import type { QwenProvider, EmbeddingsProvider } from '@/lib/providers/types';
import type { RedisCache } from '@/lib/cache/redis';
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
}
