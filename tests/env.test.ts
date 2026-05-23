import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _resetEnvCache } from '../lib/env';

describe('env loader', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    _resetEnvCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetEnvCache();
  });

  it('throws when a required var is missing', async () => {
    delete process.env.FINANCIAL_DATASETS_API_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
    process.env.UPSTASH_REDIS_REST_URL = 'http://localhost';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    process.env.CRON_SECRET = 'a-secret-at-least-16-chars';

    const { loadServerEnv } = await import('../lib/env');
    expect(() => loadServerEnv()).toThrowError(/FINANCIAL_DATASETS_API_KEY/);
  });

  it('returns a typed config when all vars present', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
    process.env.FINANCIAL_DATASETS_API_KEY = 'fd';
    process.env.UPSTASH_REDIS_REST_URL = 'http://upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    process.env.CRON_SECRET = 'a-secret-at-least-16-chars';

    const { loadServerEnv } = await import('../lib/env');
    const env = loadServerEnv();
    expect(env.FINANCIAL_DATASETS_API_KEY).toBe('fd');
    expect(env.PYTHON_BIN).toBe('python'); // default
  });
});
