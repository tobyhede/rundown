import { test, expect } from '@playwright/test';

test.describe('RunbookRunner', () => {
  test('executes auto-execution scenario correctly', async ({ page }) => {
    // 1. Navigate to the pattern page
    await page.goto('/patterns/code-blocks');

    // 2. Wait for WebContainer to boot (Status: Ready)
    // The status text is in a span with text 'Ready'
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 30000 });

    // 3. Select the 'auto-execution' scenario
    // Buttons are rendered for each scenario key
    await page.getByRole('button', { name: 'auto-execution' }).click();

    // 4. Click 'Next Step' to run the command
    // Button text is 'Next Step'
    await page.getByRole('button', { name: 'Next Step' }).click();

    // 5. Wait for execution to finish
    // We expect the result 'COMPLETE' to appear in the footer
    // We target the specific flex container that holds the "Result" label
    const resultContainer = page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Result', { exact: true }) })
      .last(); // Use last() because 'Expected' also shares this structure, and 'Result' might be matched loosely? 
               // Actually 'Result' text is unique to the Result block. 
               // But let's be safe.
    
    // Check that this container eventually contains "COMPLETE"
    await expect(resultContainer).toContainText('COMPLETE', { timeout: 30000 });

    // 6. Verify Step count in footer
    // Should be "3/3" at the end
    // Target the container with "Step" label
    const stepContainer = page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Step', { exact: true }) });
      
    await expect(stepContainer).toContainText('3/3');

    // 7. Verify terminal output contains expected text
    // Xterm renders rows. We can check if the canvas/container contains text.
    // Playwright locator for xterm rows is usually .xterm-rows > div
    // We can just check for text content on the page, as xterm renders searchable text in DOM (even if canvas is used for drawing, there's a selection layer)
    await expect(page.locator('.xterm-rows')).toContainText('Runbook:  COMPLETE');
  });
});
