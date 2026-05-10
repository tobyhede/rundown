import { test, expect } from '@playwright/test';

test.describe('Landing Page', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Rundown - Executable Runbooks in Markdown/);
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
  });

  test('renders three labeled scenario cards', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Happy path/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Retry on fail/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Skip to end/ })).toBeVisible();

    // Descriptions render alongside titles
    await expect(page.getByText('Runs 6 steps, all pass')).toBeVisible();
    await expect(page.getByText('Fails, retries, eventually passes')).toBeVisible();
    await expect(page.getByText('Jumps straight to the last step')).toBeVisible();
  });

  test('clicking a scenario card clears the terminal and does not auto-run', async ({ page }) => {
    // Step through one command of the Happy path so the terminal has content.
    await page.getByRole('button', { name: /Happy path/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.locator('.xterm-rows')).toContainText('rd', { timeout: 60000 });
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // Switch to a different card.
    await page.getByRole('button', { name: /Skip to end/ }).click();

    // Terminal must be cleared. xterm's renderer flushes on the next frame,
    // so use auto-retry via expect().toPass to wait for the clear to land.
    await expect(async () => {
      const xtermText = await page.locator('.xterm-rows').innerText();
      expect(xtermText.replace(/\s+/g, '')).toBe('');
    }).toPass({ timeout: 5000 });

    // No `rd` command echoed (would prove auto-run kicked off).
    await page.waitForTimeout(2000);
    await expect(page.locator('.xterm-rows')).not.toContainText('rd run');
  });

  test('tabs are disabled while a command is running', async ({ page }) => {
    await page.getByRole('button', { name: /Happy path/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // Click Next — status flips to `running` and the regex parser fires
    // synchronously per chunk. Immediately attempt to click the JSON tab.
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    // While running, the JSON tab is disabled. Playwright's auto-waiting on
    // `click()` will not bypass the disabled attribute — the click is a no-op.
    // Verify by attempting the click (forcing past auto-wait) and checking
    // that mode did not flip.
    await page.getByRole('tab', { name: 'JSON' }).click({ force: true, trial: false }).catch(() => {
      // If the click is rejected (disabled), that's the expected outcome.
    });

    // Mode must still be Text (the active tab's `aria-selected` remains true).
    await expect(page.getByRole('tab', { name: 'Text' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'JSON' })).toHaveAttribute('aria-selected', 'false');

    // Terminal must still contain the in-progress text-mode output.
    // Wait for the command to finish before asserting (avoid flaky races).
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(page.locator('.xterm-rows')).toContainText('rd');
  });
});
