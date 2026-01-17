import { test, expect } from '@playwright/test';

test.describe('Landing Page Scenarios', () => {
  test.beforeEach(async ({ page }) => {
    // 1. Navigate to the landing page
    await page.goto('/');
    // 2. Verify page title
    await expect(page).toHaveTitle(/Rundown - Executable Runbooks in Markdown/);
    // 3. Wait for WebContainer to boot (Status: Ready)
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
  });

  test('executes rundown scenario correctly', async ({ page }) => {
    // Select 'rundown' scenario
    await page.getByRole('button', { name: 'rundown' }).click();

    const nextStepButton = page.getByRole('button', { name: 'Next Step' });
    
    // rundown has 7 commands: run + 6 passes
    for (let i = 0; i < 7; i++) {
      await nextStepButton.click();
      // Wait for ready state after each command, except possibly the last one if it finishes quickly
      if (i < 6) {
         await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 15000 });
      }
    }

    // Verify completion
    const resultContainer = page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Result', { exact: true }) })
      .last();
    await expect(resultContainer).toContainText('COMPLETE', { timeout: 45000 });
  });

  test('executes retry scenario correctly', async ({ page }) => {
    // Select 'retry' scenario
    await page.getByRole('button', { name: 'retry' }).click();

    const nextStepButton = page.getByRole('button', { name: 'Next Step' });
    
    // retry has 11 commands
    for (let i = 0; i < 11; i++) {
      await nextStepButton.click();
      if (i < 10) {
         await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 15000 });
      }
    }

    // Verify completion
    const resultContainer = page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Result', { exact: true }) })
      .last();
    await expect(resultContainer).toContainText('COMPLETE', { timeout: 45000 });
  });

  test('executes start scenario correctly', async ({ page }) => {
    // Select 'start' scenario
    await page.getByRole('button', { name: 'start' }).click();

    const nextStepButton = page.getByRole('button', { name: 'Next Step' });
    
    // start has 3 commands: run, goto, pass
    for (let i = 0; i < 3; i++) {
      await nextStepButton.click();
      if (i < 2) {
         await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 15000 });
      }
    }

    // Verify completion
    const resultContainer = page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Result', { exact: true }) })
      .last();
    await expect(resultContainer).toContainText('COMPLETE', { timeout: 45000 });
  });
});