/**
 * Stack Auth E2E fixture — Strategy A (server-side user provisioning + cookie injection)
 *
 * Why this strategy:
 *   `@stackframe/stack@2.8.95` exposes everything we need on `stackServerApp`:
 *     - `createUser({ primaryEmail, password, primaryEmailVerified })` → `ServerUser`
 *     - `serverUser.createSession({ expiresInMillis })` → session
 *     - `session.getTokens()` → `{ accessToken, refreshToken }`
 *     - `serverUser.delete()` for teardown
 *   We can mint a session out-of-band and inject the cookies the Stack Auth
 *   `nextjs-cookie` token store reads — no browser-driven signup flow needed.
 *   This is faster, less flaky, and doesn't accumulate test users in the project.
 *
 * Strategies B (browser-driven signup) and C (header bypass via middleware)
 * were considered but rejected:
 *   - B is more brittle and leaves test users behind.
 *   - C requires a production backdoor we don't want to ship.
 *
 * Cookie format (derived from
 *   node_modules/@stackframe/stack/dist/esm/lib/stack-app/apps/implementations/client-app-impl.js):
 *
 *   Refresh cookie (one of the legacy + structured patterns is read):
 *     legacy:     `stack-refresh-<projectId>`  = <refresh_token>           (plaintext)
 *     structured: `stack-refresh-<projectId>--default` =
 *                 JSON.stringify({ refresh_token, updated_at_millis })
 *     (When the request is served over HTTPS, the structured cookie name is
 *      prefixed with `__Host-`. We're on http://localhost in tests so the
 *      un-prefixed names apply.)
 *
 *   Access cookie:
 *     `stack-access` = JSON.stringify([refresh_token, access_token])
 *
 * We write BOTH the legacy and structured refresh-cookie variants for
 * forward/back compat; the SDK picks whichever is present.
 */

import { test as base, type BrowserContext } from '@playwright/test';
import { stackServerApp } from '@/stack';
import { loadServerEnv } from '@/lib/env';

interface Fixtures {
  /** Synthetic test email, unique per worker/test. */
  testUserEmail: string;
  /** A BrowserContext pre-authenticated as a freshly-provisioned Stack Auth user. */
  authedContext: BrowserContext;
}

/** Random password that satisfies common Stack Auth password rules. */
function generatePassword(): string {
  const rand = Math.random().toString(36).slice(2, 12);
  return `E2eTest!${rand}9`;
}

function generateEmail(): string {
  const tag = Math.random().toString(36).slice(2, 10);
  return `e2e-${tag}@test.local`;
}

/**
 * Derives the Stack Auth refresh / access cookie names that the
 * `nextjs-cookie` token store reads. Mirrors logic in client-app-impl.js.
 *
 * Over HTTP (test localhost) the structured cookie has NO `__Host-` prefix.
 */
function cookieNamesFor(projectId: string) {
  const refreshBase = `stack-refresh-${projectId}`;
  return {
    legacyRefresh: refreshBase,
    structuredRefresh: `${refreshBase}--default`,
    access: 'stack-access'
  };
}

export const test = base.extend<Fixtures>({
  testUserEmail: async ({}, use) => {
    await use(generateEmail());
  },

  authedContext: async ({ browser, baseURL, testUserEmail }, use) => {
    const env = loadServerEnv();
    const password = generatePassword();
    const url = new URL(baseURL ?? 'http://localhost:3000');

    // 1. Provision the user (verified so it skips the email-verification gate).
    const user = await stackServerApp.createUser({
      primaryEmail: testUserEmail,
      primaryEmailVerified: true,
      primaryEmailAuthEnabled: true,
      password
    });

    // 2. Mint a session and pull tokens.
    const session = await user.createSession({
      // 1 hour is plenty for any single test.
      expiresInMillis: 60 * 60 * 1000
    });
    const { refreshToken, accessToken } = await session.getTokens();
    if (!refreshToken) {
      throw new Error('Stack Auth session did not return a refresh token');
    }

    // 3. Build a context and inject cookies the Stack Auth token store reads.
    const context = await browser.newContext();
    const { legacyRefresh, structuredRefresh, access } = cookieNamesFor(
      env.NEXT_PUBLIC_STACK_PROJECT_ID
    );
    const cookieBase = {
      domain: url.hostname,
      path: '/',
      httpOnly: false,
      secure: false,
      sameSite: 'Lax' as const,
      // 1 hour from now, in seconds since epoch.
      expires: Math.floor(Date.now() / 1000) + 60 * 60
    };
    const updatedAtMillis = Date.now();
    const cookies = [
      {
        ...cookieBase,
        name: legacyRefresh,
        value: refreshToken
      },
      {
        ...cookieBase,
        name: structuredRefresh,
        value: JSON.stringify({
          refresh_token: refreshToken,
          updated_at_millis: updatedAtMillis
        })
      }
    ];
    if (accessToken) {
      cookies.push({
        ...cookieBase,
        name: access,
        value: JSON.stringify([refreshToken, accessToken])
      });
    }
    await context.addCookies(cookies);

    try {
      await use(context);
    } finally {
      // 4. Teardown — close context, then delete the user.
      await context.close();
      try {
        await user.delete();
      } catch (err) {
        // Don't fail the test on a cleanup hiccup; just log it.
        // eslint-disable-next-line no-console
        console.warn(`[stack-auth fixture] failed to delete test user ${testUserEmail}:`, err);
      }
    }
  }
});

export { expect } from '@playwright/test';
