import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getServiceDb } from '@/lib/db/client';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';

interface ComponentStatus {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

const START_TIME = Date.now();

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    )
  ]);
}

async function checkPostgres(): Promise<ComponentStatus> {
  const start = Date.now();
  try {
    const db = getServiceDb();
    await withTimeout(db.execute(sql`select 1`), 2000, 'postgres');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: String(err).slice(0, 200) };
  }
}

async function checkRedis(): Promise<ComponentStatus> {
  const start = Date.now();
  try {
    const r = getRedisCache();
    await withTimeout(r.set('health:ping', { ts: Date.now() }, 10), 2000, 'redis');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: String(err).slice(0, 200) };
  }
}

async function checkFinancialDatasets(): Promise<ComponentStatus> {
  const start = Date.now();
  try {
    const env = loadServerEnv();
    const res = await withTimeout(
      fetch('https://api.financialdatasets.ai/company/facts?ticker=AAPL', {
        headers: { 'X-API-KEY': env.FINANCIAL_DATASETS_API_KEY }
      }),
      2000,
      'financialDatasets'
    );
    return {
      ok: res.ok,
      latencyMs: Date.now() - start,
      error: res.ok ? undefined : `status ${res.status}`
    };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: String(err).slice(0, 200) };
  }
}

export const dynamic = 'force-dynamic';

export async function GET(_req: Request) {
  const [postgres, redis, financialDatasets] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkFinancialDatasets()
  ]);

  const allHealthy = postgres.ok && redis.ok && financialDatasets.ok;
  return NextResponse.json(
    {
      status: allHealthy ? 'healthy' : 'degraded',
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      postgres,
      redis,
      financialDatasets
    },
    { status: allHealthy ? 200 : 503 }
  );
}
