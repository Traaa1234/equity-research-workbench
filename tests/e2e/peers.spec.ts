import { test, expect } from './fixtures/stack-auth';

// SKIP: depends on the `authedContext` fixture, which currently can't load
// `@stackframe/stack` under raw Node ESM (see signup.spec.ts skip note).
// Unskip once the Stack Auth fixture is rewritten against the REST API.
test.describe('Peers tab', () => {
  test.skip('navigates from a watchlist ticker to peers and back', async ({ authedContext }) => {
    const page = await authedContext.newPage();

    // Use AAPL — top-cap names will be in the universe + companies_universe
    await page.goto('/stock/AAPL');

    // Click Peers tab
    await page.getByRole('link', { name: 'Peers' }).click();
    await expect(page).toHaveURL(/\/stock\/AAPL\/peers/);

    // Page header
    await expect(page.getByRole('heading', { name: 'AAPL' })).toBeVisible();
    await expect(page.getByText('Peer Comparison')).toBeVisible();

    // Table renders within 25s (cold cache ingest ~10-15s)
    await expect(page.getByText('Comparable companies')).toBeVisible();
    // The target row's ticker chip is always visible once data resolves
    await expect(page.getByRole('link', { name: 'AAPL' }).first()).toBeVisible({ timeout: 25_000 });

    await page.close();
  });
});
