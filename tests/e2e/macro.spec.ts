import { test, expect } from '@playwright/test';

// Authed E2E specs are skipped pending the Stack Auth ESM fixture fix (see handoff).
test.skip('macro board renders and a tile opens the detail drawer', async ({ page }) => {
  await page.goto('/macro');
  await expect(page.getByText('Macro Weather')).toBeVisible();
  await expect(page.getByText(/SUNNY|FAIR|MIXED|CLOUDY|STORMY/)).toBeVisible();
  await page.getByRole('button', { name: /2s10s Spread/ }).click();
  await expect(page.getByText(/as of/)).toBeVisible();
});
