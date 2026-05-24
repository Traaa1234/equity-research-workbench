import { test, expect } from './fixtures/stack-auth';

// SKIP: depends on the `authedContext` fixture, which currently can't load
// `@stackframe/stack` under raw Node ESM (see signup.spec.ts skip note).
// Unskip once the Stack Auth fixture is rewritten against the REST API.
test.skip('financials tab → toggle quarterly → URL updates + tables refresh', async ({ authedContext }) => {
  const page = await authedContext.newPage();
  // Use AAPL since it's a seed ticker and definitely in the DB
  await page.goto('/stock/AAPL/financials');

  // Should be on the financials view
  await expect(page).toHaveURL(/\/stock\/AAPL\/financials/);
  await expect(page.getByText(/income statement/i).first()).toBeVisible({ timeout: 15_000 });

  // Click Quarterly tab
  await page.getByRole('link', { name: /^quarterly$/i }).click();

  // URL should update to include period=quarterly
  await page.waitForURL(/period=quarterly/, { timeout: 10_000 });

  // Card titles update to reflect quarterly
  await expect(page.getByText(/income statement \(quarterly\)/i)).toBeVisible({ timeout: 15_000 });

  await page.close();
});
