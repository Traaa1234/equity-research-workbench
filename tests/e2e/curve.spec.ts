import { test, expect } from '@playwright/test';
// Authed E2E specs are skipped pending the Stack Auth ESM fixture fix (see handoff).
test.skip('yield curve renders and a maturity opens detail', async ({ page }) => {
  await page.goto('/macro/curve');
  await expect(page.getByText('Yield Curve')).toBeVisible();
  await expect(page.getByText(/recession signal/i)).toBeVisible();
  await page.getByRole('button', { name: /10Y/ }).first().click();
  await expect(page.getByText(/Treasury yield/)).toBeVisible();
});
