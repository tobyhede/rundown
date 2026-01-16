import { test, expect } from '@playwright/test';

test.describe('Landing Page', () => {
  test('executes tour scenario correctly', async ({ page }) => {
    // 1. Navigate to the landing page
    await page.goto('/');

    // 2. Verify page title to ensure we are on the landing page
    await expect(page).toHaveTitle(/Rundown - Executable Runbooks in Markdown/);

    // 3. Wait for WebContainer to boot (Status: Ready)
    // The status text is in a span with text 'Ready'
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 }); // Increased timeout for initial boot

    // 4. Select the 'quick' scenario
    await page.getByRole('button', { name: 'quick' }).click();

    // 5. Execute the scenario steps
    // The 'quick' scenario has 3 commands: run, goto, pass
    // We need to click 'Next Step' for each command and wait for it to complete
    const nextStepButton = page.getByRole('button', { name: 'Next Step' });
    
    // Command 1: rd run ...
    await nextStepButton.click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 15000 });

    // Command 2: rd goto 5
    await nextStepButton.click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 15000 });

    // Command 3: rd pass
    await nextStepButton.click();

    // 6. Wait for execution to finish
    // We expect the result 'COMPLETE' to appear in the footer
    const resultContainer = page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Result', { exact: true }) })
      .last();
    
    await expect(resultContainer).toContainText('COMPLETE', { timeout: 45000 });

    // 7. Verify terminal output contains expected text
    await expect(page.locator('.xterm-rows')).toContainText('Runbook:  COMPLETE');
  });
});
