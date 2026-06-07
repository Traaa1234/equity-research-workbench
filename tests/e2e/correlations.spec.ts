import { test, expect } from '@playwright/test';
// Authed E2E specs are skipped pending the Stack Auth ESM fixture fix (see handoff).
test.skip('correlation matrix renders and the window toggle works', async ({ page }) => {
  await page.goto('/macro/correlations');
  await expect(page.getByText('Cross-Asset Correlations')).toBeVisible();
  await page.getByRole('button', { name: '30d' }).click();
  await expect(page.getByText(/correlation of daily returns/)).toBeVisible();
});
