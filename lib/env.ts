import { z } from 'zod';

const ServerEnvSchema = z.object({
  // Neon Postgres — two connection strings for two roles.
  // DATABASE_URL is the authenticated role (subject to RLS); used in user-scoped routes.
  // DATABASE_URL_SERVICE_ROLE has BYPASSRLS; used by cron, ingestion, and tests.
  DATABASE_URL: z.string().url(),
  DATABASE_URL_SERVICE_ROLE: z.string().url(),

  // Stack Auth
  NEXT_PUBLIC_STACK_PROJECT_ID: z.string().min(1),
  NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY: z.string().min(1),
  STACK_SECRET_SERVER_KEY: z.string().min(1),

  // External data providers
  FINANCIAL_DATASETS_API_KEY: z.string().min(1),

  // Upstash Redis (REST)
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),

  // Cron handler shared secret
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 chars'),

  // Python interpreter used by the yfinance subprocess adapter
  PYTHON_BIN: z.string().default('python'),

  // Neon test branch — required by integration tests, optional in production.
  DATABASE_URL_TEST: z.string().url().optional(),
  DATABASE_URL_TEST_SERVICE_ROLE: z.string().url().optional()
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let cached: ServerEnv | null = null;

export function loadServerEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = ServerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: clears the cached env so tests can re-load with mutated process.env. */
export function _resetEnvCache() {
  cached = null;
}
