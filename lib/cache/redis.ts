import { Redis } from '@upstash/redis';
import { loadServerEnv } from '@/lib/env';

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ex?: number }): Promise<string | null>;
  del(key: string): Promise<number>;
}

export class RedisCache {
  constructor(private readonly client: RedisLike) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw == null) return null;
    try {
      // Upstash auto-parses JSON in some configs; handle both.
      return typeof raw === 'string' ? (JSON.parse(raw) as T) : (raw as T);
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), { ex: ttlSeconds });
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}

let singleton: RedisCache | null = null;

export function getRedisCache(): RedisCache {
  if (singleton) return singleton;
  const env = loadServerEnv();
  const client = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN
  });
  singleton = new RedisCache(client as unknown as RedisLike);
  return singleton;
}
