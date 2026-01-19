import { test, expect } from '@playwright/test';

test.describe('RunbookRunner', () => {
  test('executes auto-execution scenario correctly', async ({ page }) => {
    // 1. Navigate to the pattern page
    await page.goto('/explore/code-blocks');

    // 2. Wait for WebContainer to boot (Status: Ready)
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // 3. Select the 'auto-execution' scenario
    await page.getByRole('button', { name: 'auto-execution' }).click();

    // 4. Click 'Next' to start the auto-execution scenario
    // The scenario has only 1 command (rd run without --prompted) which runs to completion
    await page.getByRole('button', { name: 'Next' }).first().click();

    // 5. Wait for execution to finish
    // We expect the result 'COMPLETE' to appear in the footer
    const resultContainer = page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Result', { exact: true }) })
      .last();

    // Check that this container eventually contains "COMPLETE"
    await expect(resultContainer).toContainText('COMPLETE', { timeout: 30000 });

    // 6. Verify Step count in footer - should be "3/3" at the end
    const stepContainer = page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Step', { exact: true }) });

    await expect(stepContainer).toContainText('3/3');

    // 7. Verify terminal output contains expected text
    await expect(page.locator('.xterm-rows')).toContainText('Runbook:  COMPLETE');
  });
});
