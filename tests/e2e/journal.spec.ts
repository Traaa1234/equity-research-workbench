import { test, expect } from './fixtures/stack-auth';

// SKIP: depends on the `authedContext` fixture, which currently can't load
// `@stackframe/stack` under raw Node ESM (see signup.spec.ts skip note).
// Unskip once the Stack Auth fixture is rewritten against the REST API.
test.describe('Trade journal', () => {
  test.skip('open a position + verify cross-ticker view', async ({ authedContext }) => {
    const page = await authedContext.newPage();

    await page.goto('/stock/AAPL/journal');

    // Page renders with the ticker heading and "Trade journal" subtitle
    await expect(page.getByRole('heading', { name: 'AAPL' })).toBeVisible();
    await expect(page.getByText('Trade journal')).toBeVisible();

    // Fill the new-position thesis textarea
    await page
      .getByPlaceholder(/What's your thesis/)
      .fill('Test thesis for E2E. Catalyst: iPhone refresh.');

    // Save the position
    await page.getByRole('button', { name: 'Save' }).click();

    // Position appears in the Open list
    await expect(page.getByText(/Open positions \(1\)/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Test thesis for E2E/)).toBeVisible();

    // Cross-ticker view
    await page.goto('/journal');
    await expect(page.getByRole('heading', { name: 'Trade Journal' })).toBeVisible();
    await expect(page.getByText(/Positions \(1\)/)).toBeVisible();

    await page.close();
  });
});
