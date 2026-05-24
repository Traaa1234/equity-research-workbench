import { describe, it, expect, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { verifyCronAuth } from '@/lib/api/auth-cron';
import { _resetEnvCache } from '@/lib/env';

config({ path: '.env.local' });

describe('verifyCronAuth', () => {
  beforeEach(() => {
    // Ensure a known CRON_SECRET so the test is deterministic regardless of .env.local.
    process.env.CRON_SECRET = 'test-secret-at-least-16-chars';
    _resetEnvCache();
  });

  it('returns true on matching Bearer token', () => {
    const req = new Request('http://localhost/api/cron/refresh', {
      headers: { Authorization: 'Bearer test-secret-at-least-16-chars' }
    });
    expect(verifyCronAuth(req)).toBe(true);
  });

  it('returns false on missing header', () => {
    const req = new Request('http://localhost/api/cron/refresh');
    expect(verifyCronAuth(req)).toBe(false);
  });

  it('returns false on wrong token', () => {
    const req = new Request('http://localhost/api/cron/refresh', {
      headers: { Authorization: 'Bearer wrong-secret-but-also-16-chars' }
    });
    expect(verifyCronAuth(req)).toBe(false);
  });

  it('returns false on malformed Authorization header (no Bearer prefix)', () => {
    const req = new Request('http://localhost/api/cron/refresh', {
      headers: { Authorization: 'test-secret-at-least-16-chars' }
    });
    expect(verifyCronAuth(req)).toBe(false);
  });
});
