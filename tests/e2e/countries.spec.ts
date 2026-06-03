import { test, expect } from '@playwright/test';
// Authed E2E specs are skipped pending the Stack Auth ESM fixture fix (see handoff).
test.skip('country scorecard renders and a row opens detail', async ({ page }) => {
  await page.goto('/macro/countries');
  await expect(page.getByText('Country Scorecard')).toBeVisible();
  await expect(page.getByText('United States')).toBeVisible();
  await page.getByText('United States').click();
  await expect(page.getByText(/Composite/)).toBeVisible();
});
