import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { QwenProviderImpl } from '@/lib/providers/qwen';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';
import { DiscoverService } from '@/lib/services/discover';
import { getRedisCache } from '@/lib/cache/redis';

const RATE_LIMIT_PER_HOUR = 30;

const requestSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(100).optional()
});

let svc: DiscoverService | null = null;
function service(): DiscoverService {
  if (svc) return svc;
  svc = new DiscoverService({
    db: getServiceDb(),
    qwenProvider: new QwenProviderImpl(),
    embeddingsProvider: new EmbeddingsProviderImpl(),
    redis: getRedisCache()
  });
  return svc;
}

async function rateLimit(userId: string): Promise<boolean> {
  const redis = getRedisCache();
  const key = `ratelimit:discover:${userId}`;
  const cur = (await redis.get<number>(key)) ?? 0;
  if (cur >= RATE_LIMIT_PER_HOUR) return false;
  await redis.set(key, cur + 1, 60 * 60);
  return true;
}

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    if (!(await rateLimit(userId))) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': '3600' } }
      );
    }
    const body = await req.json();
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        `Invalid request: ${parsed.error.issues.map((i) => i.message).join(', ')}`
      );
    }

    const svc_ = service();
    const parsedQuery = await svc_.parseQuery(parsed.data.query);
    const results = await svc_.search(parsed.data.query, parsed.data.limit ?? 20, parsedQuery);
    return ok({ parsed: parsedQuery, results });
  } catch (err) {
    return errorResponse(err, { route: 'discover POST' });
  }
}
