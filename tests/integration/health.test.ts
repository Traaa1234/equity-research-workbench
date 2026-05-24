import { describe, it, expect } from 'vitest';
import { config } from 'dotenv';

config({ path: '.env.local' });

describe('GET /api/health', () => {
  it('returns 200 or 503 with component status when all healthy', async () => {
    const { GET } = await import('@/app/api/health/route');
    const res = await GET(new Request('http://localhost/api/health'));
    // 503 if a dep is genuinely down right now (e.g., FD rate-limited); both are acceptable shapes.
    expect([200, 503]).toContain(res.status);
    const body = await res.json();
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('uptime');
    expect(body).toHaveProperty('postgres');
    expect(body).toHaveProperty('redis');
    expect(body).toHaveProperty('financialDatasets');
    // Each component should have ok + latencyMs at minimum.
    for (const c of ['postgres', 'redis', 'financialDatasets'] as const) {
      expect(body[c]).toHaveProperty('ok');
      expect(body[c]).toHaveProperty('latencyMs');
    }
  });

  it('postgres latency should be < 5s on a healthy connection', async () => {
    const { GET } = await import('@/app/api/health/route');
    const res = await GET(new Request('http://localhost/api/health'));
    const body = await res.json();
    if (body.postgres.ok) {
      expect(body.postgres.latencyMs).toBeLessThan(5000);
    }
  });
});
