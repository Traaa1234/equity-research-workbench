import { test, expect } from './fixtures/stack-auth';

// SKIP: depends on the `authedContext` fixture, which currently can't load
// `@stackframe/stack` under raw Node ESM (see signup.spec.ts skip note).
// Unskip once the Stack Auth fixture is rewritten against the REST API.
test.skip('user adds AAPL and lands on the ticker dashboard', async ({ authedContext }) => {
  const page = await authedContext.newPage();
  await page.goto('/watchlist?add=1');

  // Dialog should be open
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('heading', { name: /add ticker/i })).toBeVisible();

  // Type AAPL and submit
  const input = page.getByPlaceholder('AAPL');
  await input.fill('AAPL');
  await page.getByRole('button', { name: /^add$/i }).click();

  // On-demand ingest can take 3-15s depending on provider response + Neon cold start
  await page.waitForURL(/\/stock\/AAPL/, { timeout: 30_000 });

  // Snapshot card title visible
  await expect(page.getByRole('heading', { name: 'AAPL', exact: true })).toBeVisible();

  // Some kind of price displayed (any $ value)
  await expect(page.getByText(/\$\d+/)).toBeVisible({ timeout: 15_000 });

  await page.close();
});
