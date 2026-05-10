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

  test('Text mode: Happy path steps to STEP 6/6 and RESULT COMPLETE', async ({ page }) => {
    // Happy path is the default scenario; clicking it is a no-op (same-card
    // click). autoStart prefires step 0 of the runbook, so click Reset to
    // start the step-through from currentStep=0.
    await page.getByRole('button', { name: /Happy path/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: 'Reset' }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // Happy path = 7 commands (1 run + 6 pass). Click Next 6 times then Complete on the 7th.
    // The label flips to 'Complete' when about to run the final command
    // (currentStep === scenario.commands.length - 1 with length > 1).
    for (let i = 0; i < 7; i++) {
      const label = i === 6 ? 'Complete' : 'Next';
      await page.getByRole('button', { name: label, exact: true }).click();
      // Wait for the click to take effect (status returns to ready or the button label flips).
      if (i < 6) {
        await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
      }
    }

    const resultContainer = page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Result', { exact: true }) })
      .last();
    await expect(resultContainer).toContainText('COMPLETE', { timeout: 60000 });

    const stepContainer = page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Step', { exact: true }) });
    await expect(stepContainer).toContainText('6/6');
  });

  test('Text mode: Skip to end completes via goto+pass', async ({ page }) => {
    await page.getByRole('button', { name: /Skip to end/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // Skip to end = 3 commands: rd run --prompted, rd goto 6, rd pass.
    // Per the verified emit table in Conventions:
    //   Click 1 (rd run --prompted): NO `At:` line emitted (action: START
    //     has no `at` field; see packages/core/src/cli/output.ts:120-122).
    //     `runbookStep` stays at the placeholder `'—'`.
    //   Click 2 (rd goto 6): emits `At: 6` (derivePositionAt of the new
    //     position). `runbookStep` = '6'.
    //   Click 3 (rd pass, final): emits `At: 6` then `Runbook: COMPLETE`.
    //     `runbookStep` = '6', `runbookResult` = 'COMPLETE'.
    //
    // We do NOT assert intermediate values for Click 1 (would fail — step
    // stays at `'—'`). We assert only the final stable state. This avoids
    // brittleness on transition-order details.
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // Final click — `rd pass` completes the runbook.
    await page.getByRole('button', { name: 'Complete', exact: true }).click();

    const resultContainer = page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Result', { exact: true }) })
      .last();
    await expect(resultContainer).toContainText('COMPLETE', { timeout: 60000 });

    const stepContainer = page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Step', { exact: true }) });
    await expect(stepContainer).toContainText('6/6');
  });

  test('Tab switch to JSON resets state and clears terminal', async ({ page }) => {
    // Step through one Text-mode command so state is non-empty.
    await page.getByRole('button', { name: /Happy path/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(page.locator('.xterm-rows')).toContainText('rd');

    // Click the JSON tab — should clean state, clear terminal, reset scenario.
    await page.getByRole('tab', { name: 'JSON' }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // Terminal cleared (auto-retry until xterm flushes the clear).
    await expect(async () => {
      const xtermText = await page.locator('.xterm-rows').innerText();
      expect(xtermText.replace(/\s+/g, '')).toBe('');
    }).toPass({ timeout: 5000 });

    // Footer reset to placeholders. Step row shows `—/6`; Result row hides
    // because runbookResult is null after reset.
    const stepContainer = page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Step', { exact: true }) });
    await expect(stepContainer).toContainText('—/');
    await expect(page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Result', { exact: true }) })
    ).toHaveCount(0);
  });

  test('JSON mode: clicking Next emits the runbook_started JSONL event', async ({ page }) => {
    await page.getByRole('button', { name: /Happy path/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // Switch to JSON mode (this also resets state — tab click is destructive).
    await page.getByRole('tab', { name: 'JSON' }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // Click Next once — `rd run --prompted` emits RUNBOOK_STARTED, lowercased
    // to "runbook_started" by the JSON renderer. This event fires only on
    // `rd run` (the first command of the scenario), not on subsequent
    // pass/fail/goto commands — so a single click is sufficient.
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.locator('.xterm-rows')).toContainText('"type":"runbook_started"', { timeout: 60000 });
  });

  test('Tab switch back to Text resets state', async ({ page }) => {
    await page.getByRole('button', { name: /Happy path/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // Go to JSON, click Next once, then back to Text.
    await page.getByRole('tab', { name: 'JSON' }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.locator('.xterm-rows')).toContainText('"type":"runbook_started"', { timeout: 60000 });

    await page.getByRole('tab', { name: 'Text' }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // Auto-retry until xterm flushes the clear.
    await expect(async () => {
      const xtermText = await page.locator('.xterm-rows').innerText();
      expect(xtermText.replace(/\s+/g, '')).toBe('');
    }).toPass({ timeout: 5000 });
  });

  test('Reset mid-scenario clears terminal and footer', async ({ page }) => {
    await page.getByRole('button', { name: /Skip to end/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // Step through two commands so state is non-empty AND the footer's
    // step value has updated (Click 2 = `rd goto 6` emits `At: 6`).
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(page.locator('.xterm-rows')).toContainText('rd');

    // Reset.
    await page.getByRole('button', { name: 'Reset' }).click();

    // Tight emptiness check: combine negative (no completion marker) and
    // positive (terminal text content collapses to whitespace after `term.clear()`).
    await expect(page.locator('.xterm-rows')).not.toContainText('COMPLETE');
    await expect(async () => {
      const xtermText = await page.locator('.xterm-rows').innerText();
      expect(xtermText.replace(/\s+/g, '')).toBe('');
    }).toPass({ timeout: 5000 });

    // Footer reset.
    const stepContainer = page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Step', { exact: true }) });
    await expect(stepContainer).toContainText('—/');
    await expect(page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Result', { exact: true }) })
    ).toHaveCount(0);
  });
});
