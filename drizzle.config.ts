import { config } from 'dotenv';
import type { Config } from 'drizzle-kit';

config({ path: '.env.local' });

const url = process.env.DATABASE_URL_SERVICE_ROLE;
if (!url) {
  throw new Error('DATABASE_URL_SERVICE_ROLE is required for migrations');
}

export default {
  schema: './lib/db/schema.ts',
  out: './lib/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  verbose: true,
  strict: true
} satisfies Config;
