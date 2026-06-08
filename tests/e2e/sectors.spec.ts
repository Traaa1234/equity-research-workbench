import { test, expect } from '@playwright/test';
// Authed E2E specs are skipped pending the Stack Auth ESM fixture fix (see handoff).
test.skip('sector rotation page renders and sorting works', async ({ page }) => {
  await page.goto('/macro/sectors');
  await expect(page.getByText('Sector Rotation')).toBeVisible();
  await page.getByRole('columnheader', { name: /1W/i }).click();
  await expect(page.getByRole('columnheader', { name: /1W/i })).toBeVisible();
});
