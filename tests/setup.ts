import { afterEach, vi } from 'vitest';
import { config } from 'dotenv';

// Load .env.local so env-dependent code (loadServerEnv, getServiceDb, etc.) has values.
config({ path: '.env.local' });

// Setup runs once per test file. Guard so the safety check + env override only
// happen on the first run; subsequent runs in the same worker skip it.
declare global {
  // eslint-disable-next-line no-var
  var __integrationTestSetupDone: boolean | undefined;
}

if (!globalThis.__integrationTestSetupDone) {
  // When the dedicated Neon test branch is configured, redirect the production
  // DB env vars to it. This way, any code that reads DATABASE_URL or
  // DATABASE_URL_SERVICE_ROLE (e.g. route handlers calling getServiceDb()) hits
  // the test branch — not just code that reads DATABASE_URL_TEST_*.
  //
  // Safety check FIRST (before overriding): refuse to run if the dev configured
  // the TEST URLs identical to the prod URLs (would wipe prod data via resetDb).
  if (
    process.env.DATABASE_URL_TEST_SERVICE_ROLE &&
    process.env.DATABASE_URL_SERVICE_ROLE &&
    process.env.DATABASE_URL_TEST_SERVICE_ROLE === process.env.DATABASE_URL_SERVICE_ROLE
  ) {
    throw new Error(
      'Refusing to run integration tests: DATABASE_URL_TEST_SERVICE_ROLE equals DATABASE_URL_SERVICE_ROLE.\n' +
        'They must point at DIFFERENT Neon branches (the test branch vs prod).'
    );
  }
  if (
    process.env.DATABASE_URL_TEST &&
    process.env.DATABASE_URL &&
    process.env.DATABASE_URL_TEST === process.env.DATABASE_URL
  ) {
    throw new Error(
      'Refusing to run integration tests: DATABASE_URL_TEST equals DATABASE_URL.\n' +
        'They must point at DIFFERENT Neon branches (the test branch vs prod).'
    );
  }

  // Apply override. After this, route handlers that call getServiceDb() will
  // connect to the test branch.
  if (process.env.DATABASE_URL_TEST) {
    process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  }
  if (process.env.DATABASE_URL_TEST_SERVICE_ROLE) {
    process.env.DATABASE_URL_SERVICE_ROLE = process.env.DATABASE_URL_TEST_SERVICE_ROLE;
  }

  globalThis.__integrationTestSetupDone = true;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
