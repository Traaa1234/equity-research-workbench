import { describe, it, expect, vi } from 'vitest';
import { RedisCache } from '@/lib/cache/redis';

function makeFakeClient(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const ttls = new Map<string, number>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, opts?: { ex?: number }) => {
      store.set(key, value);
      if (opts?.ex) ttls.set(key, opts.ex);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    }),
    _store: store,
    _ttls: ttls
  };
}

describe('RedisCache', () => {
  it('returns null when key missing', async () => {
    const client = makeFakeClient();
    const cache = new RedisCache(client as any);
    expect(await cache.get<{ x: number }>('missing')).toBeNull();
  });

  it('round-trips JSON values', async () => {
    const client = makeFakeClient();
    const cache = new RedisCache(client as any);
    await cache.set('k', { x: 1, y: 'two' }, 60);
    expect(await cache.get<{ x: number; y: string }>('k')).toEqual({ x: 1, y: 'two' });
    expect(client._ttls.get('k')).toBe(60);
  });

  it('returns null for malformed JSON', async () => {
    const client = makeFakeClient({ bad: 'not-json' });
    const cache = new RedisCache(client as any);
    expect(await cache.get('bad')).toBeNull();
  });

  it('del removes the key', async () => {
    const client = makeFakeClient({ k: '"v"' });
    const cache = new RedisCache(client as any);
    await cache.del('k');
    expect(client._store.has('k')).toBe(false);
  });
});
