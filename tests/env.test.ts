import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _resetEnvCache } from '../lib/env';

function setValidEnv() {
  process.env.DATABASE_URL = 'postgres://user:pw@host.neon.tech/db';
  process.env.DATABASE_URL_SERVICE_ROLE = 'postgres://service:pw@host.neon.tech/db';
  process.env.NEXT_PUBLIC_STACK_PROJECT_ID = 'proj_abc';
  process.env.NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY = 'pck_abc';
  process.env.STACK_SECRET_SERVER_KEY = 'ssk_abc';
  process.env.FINANCIAL_DATASETS_API_KEY = 'fd';
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
  process.env.CRON_SECRET = 'a-secret-at-least-16-chars';
}

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
    setValidEnv();
    delete process.env.FINANCIAL_DATASETS_API_KEY;

    const { loadServerEnv } = await import('../lib/env');
    expect(() => loadServerEnv()).toThrowError(/FINANCIAL_DATASETS_API_KEY/);
  });

  it('throws when DATABASE_URL is missing', async () => {
    setValidEnv();
    delete process.env.DATABASE_URL;

    const { loadServerEnv } = await import('../lib/env');
    expect(() => loadServerEnv()).toThrowError(/DATABASE_URL/);
  });

  it('throws when STACK_SECRET_SERVER_KEY is missing', async () => {
    setValidEnv();
    delete process.env.STACK_SECRET_SERVER_KEY;

    const { loadServerEnv } = await import('../lib/env');
    expect(() => loadServerEnv()).toThrowError(/STACK_SECRET_SERVER_KEY/);
  });

  it('returns a typed config when all vars present, PYTHON_BIN defaults to python', async () => {
    setValidEnv();

    const { loadServerEnv } = await import('../lib/env');
    const env = loadServerEnv();
    expect(env.FINANCIAL_DATASETS_API_KEY).toBe('fd');
    expect(env.DATABASE_URL).toBe('postgres://user:pw@host.neon.tech/db');
    expect(env.NEXT_PUBLIC_STACK_PROJECT_ID).toBe('proj_abc');
    expect(env.PYTHON_BIN).toBe('python');
  });
});
