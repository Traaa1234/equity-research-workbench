import { test, expect } from './fixtures/stack-auth';

// SKIP: depends on the `authedContext` fixture, which currently can't load
// `@stackframe/stack` under raw Node ESM (see signup.spec.ts skip note).
// Unskip once the Stack Auth fixture is rewritten against the REST API.
test.describe('Watchlist roll-up dashboard', () => {
  test.skip('defaults to the roll-up tab and renders the table for a watchlist user', async ({ authedContext }) => {
    const page = await authedContext.newPage();

    // Seed AAPL onto the freshly-provisioned user's watchlist so the rollup
    // table renders instead of the EmptyState. We hit the same dialog flow as
    // add-ticker.spec.ts because /api/watchlist/add isn't directly callable
    // from inside the browser context without CSRF/session plumbing.
    await page.goto('/watchlist?add=1');
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
    const input = page.getByPlaceholder('AAPL');
    await input.fill('AAPL');
    await page.getByRole('button', { name: /^add$/i }).click();
    // Add flow redirects to /stock/AAPL.
    await page.waitForURL(/\/stock\/AAPL/, { timeout: 30_000 });

    // Now hit /watchlist — Roll-up is the default tab.
    await page.goto('/watchlist');
    await expect(page.getByRole('heading', { name: 'Watchlist', exact: true })).toBeVisible();

    // shadcn Tabs renders <button role="tab"> with aria-selected="true" for the active tab.
    const rollupTab = page.getByRole('tab', { name: /Roll-up/i });
    await expect(rollupTab).toBeVisible();
    await expect(rollupTab).toHaveAttribute('aria-selected', 'true');

    // Desktop table header columns are present.
    await expect(page.getByText('Snapshot', { exact: true })).toBeVisible();
    await expect(page.getByText('Tech', { exact: true })).toBeVisible();
    await expect(page.getByText('Insiders', { exact: true })).toBeVisible();

    // The AAPL row links to /stock/AAPL.
    const aaplLink = page.getByRole('link', { name: 'AAPL', exact: true }).first();
    await expect(aaplLink).toBeVisible();
    await expect(aaplLink).toHaveAttribute('href', '/stock/AAPL');

    await page.close();
  });

  test.skip('clicking a ticker name navigates to the ticker overview', async ({ authedContext }) => {
    const page = await authedContext.newPage();

    // Seed AAPL onto the watchlist (see first test for rationale).
    await page.goto('/watchlist?add=1');
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder('AAPL').fill('AAPL');
    await page.getByRole('button', { name: /^add$/i }).click();
    await page.waitForURL(/\/stock\/AAPL/, { timeout: 30_000 });

    await page.goto('/watchlist');
    const aaplLink = page.getByRole('link', { name: 'AAPL', exact: true }).first();
    await aaplLink.click();
    await expect(page).toHaveURL(/\/stock\/AAPL$/);

    await page.close();
  });

  test.skip('sort toggle updates the URL with ?sort=', async ({ authedContext }) => {
    const page = await authedContext.newPage();

    // Seed AAPL so the SortToggle is rendered (it lives inside WatchlistTable,
    // which is only rendered when the watchlist is non-empty).
    await page.goto('/watchlist?add=1');
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder('AAPL').fill('AAPL');
    await page.getByRole('button', { name: /^add$/i }).click();
    await page.waitForURL(/\/stock\/AAPL/, { timeout: 30_000 });

    await page.goto('/watchlist');
    const select = page.getByLabel('Sort tickers');
    await expect(select).toBeVisible();
    await select.selectOption('insider');
    await page.waitForURL(/sort=insider/, { timeout: 10_000 });

    await page.close();
  });
});
