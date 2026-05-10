import { test, expect, type Page } from '@playwright/test';

const FOOTER_STEP = '[data-testid="footer-step"]';
const FOOTER_RESULT = '[data-testid="footer-result"]';

async function expectTerminalEmpty(page: Page) {
  // xterm flushes via requestAnimationFrame, so retry until the DOM catches up.
  await expect(async () => {
    const xtermText = await page.locator('.xterm-rows').innerText();
    expect(xtermText.replace(/\s+/g, '')).toBe('');
  }).toPass({ timeout: 5000 });
}

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

    // Terminal must be cleared.
    await expectTerminalEmpty(page);

    // Confirm no auto-run kicked off: terminal stays empty across a 2s window
    // and contains no `rd run` echo. Hard wait is correct here — we're
    // proving absence over a window, which `.not.toContainText` polling
    // cannot do (it returns as soon as the negative is true).
    await page.waitForTimeout(2000);
    await expectTerminalEmpty(page);
    await expect(page.locator('.xterm-rows')).not.toContainText('rd run');
  });

  test('tabs are disabled while a command is running', async ({ page }) => {
    await page.getByRole('button', { name: /Happy path/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // Click Next — status flips to `running`. Both tabs gain `disabled`.
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    // Direct disabled-state assertion (auto-retries until disabled appears).
    await expect(page.getByRole('tab', { name: 'Text' })).toBeDisabled();
    await expect(page.getByRole('tab', { name: 'JSON' })).toBeDisabled();
    await expect(page.getByRole('tab', { name: 'Text' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'JSON' })).toHaveAttribute('aria-selected', 'false');

    // After execution finishes the tabs re-enable.
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(page.getByRole('tab', { name: 'Text' })).toBeEnabled();
    await expect(page.getByRole('tab', { name: 'JSON' })).toBeEnabled();
    await expect(page.locator('.xterm-rows')).toContainText('rd');
  });

  test('clicking the already-selected card is a no-op (state preserved)', async ({ page }) => {
    // Happy path is the default. Step one command.
    await page.getByRole('button', { name: /Happy path/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(page.locator('.xterm-rows')).toContainText('rd');

    // Click the same card again — should NOT clear or reset.
    await page.getByRole('button', { name: /Happy path/ }).click();

    // Still ready, terminal still has content, footer still shows step.
    await expect(page.getByText('Ready', { exact: true })).toBeVisible();
    await expect(page.locator('.xterm-rows')).toContainText('rd');
    await expect(page.locator(FOOTER_STEP)).not.toContainText('—/');
  });

  test('clicking the already-active tab is a no-op (state preserved)', async ({ page }) => {
    await page.getByRole('button', { name: /Happy path/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // Default mode is Text; click the Text tab again. State must be preserved.
    await page.getByRole('tab', { name: 'Text' }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible();
    await expect(page.locator('.xterm-rows')).toContainText('rd');
    await expect(page.locator(FOOTER_STEP)).not.toContainText('—/');
  });

  test('Text mode: Happy path steps to STEP 6/6 and RESULT COMPLETE', async ({ page }) => {
    // Happy path is the default scenario; clicking it is a no-op (same-card).
    // autoStart prefires step 0, so click Reset to start from currentStep=0.
    await page.getByRole('button', { name: /Happy path/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: 'Reset' }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // After reset, footer total should display exactly `—/6`.
    await expect(page.locator(FOOTER_STEP)).toContainText('—/6');

    const action = page.getByRole('button', { name: /^(Next|Complete)$/ });

    // Happy path = 7 commands (1 run + 6 pass). Label is 'Next' for the
    // first 6 clicks, 'Complete' on the 7th (final command).
    for (let i = 0; i < 7; i++) {
      const expectedLabel = i === 6 ? 'Complete' : 'Next';
      await expect(action).toHaveText(new RegExp(`^${expectedLabel}$`), { timeout: 60000 });
      await action.click();
      if (i < 6) {
        await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
      }
    }

    await expect(page.locator(FOOTER_RESULT)).toContainText('COMPLETE', { timeout: 60000 });
    await expect(page.locator(FOOTER_STEP)).toContainText('6/6');
  });

  test('Text mode: Skip to end completes via goto+pass', async ({ page }) => {
    await page.getByRole('button', { name: /Skip to end/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // Skip to end = 3 commands: rd run --prompted, rd goto 6, rd pass.
    // We do NOT assert intermediate values for Click 1 — `rd run --prompted`
    // emits no `At:` line, so `runbookStep` stays at the placeholder `'—'`.
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // Final click — `rd pass` completes the runbook.
    await page.getByRole('button', { name: 'Complete', exact: true }).click();

    await expect(page.locator(FOOTER_RESULT)).toContainText('COMPLETE', { timeout: 60000 });
    await expect(page.locator(FOOTER_STEP)).toContainText('6/6');
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

    await expectTerminalEmpty(page);

    // Footer reset to placeholders. Step row shows `—/6`; Result row hides
    // because runbookResult is null after reset.
    await expect(page.locator(FOOTER_STEP)).toContainText('—/6');
    await expect(page.locator(FOOTER_RESULT)).toHaveCount(0);
  });

  test('JSON mode: Next emits runbook_started and the footer stays at placeholders', async ({ page }) => {
    await page.getByRole('button', { name: /Happy path/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // Switch to JSON mode (this also resets state — tab click is destructive).
    await page.getByRole('tab', { name: 'JSON' }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // Click Next once — `rd run --prompted` emits RUNBOOK_STARTED, lowercased
    // to "runbook_started" by the JSON renderer.
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.locator('.xterm-rows')).toContainText('"type":"runbook_started"', { timeout: 60000 });

    // The footer's text-mode regex parser does NOT fire in JSON mode, so the
    // step value stays at the placeholder and the Result row stays hidden
    // even though the runbook is making progress.
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(page.locator(FOOTER_STEP)).toContainText('—/6');
    await expect(page.locator(FOOTER_RESULT)).toHaveCount(0);
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

    await expectTerminalEmpty(page);
    await expect(page.locator(FOOTER_STEP)).toContainText('—/6');
    await expect(page.locator(FOOTER_RESULT)).toHaveCount(0);
  });

  test('Text mode: Retry on fail completes via RECOVER routing', async ({ page }) => {
    await page.getByRole('button', { name: /Retry on fail/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    const action = page.getByRole('button', { name: /^(Next|Complete)$/ });
    const seenSteps: string[] = [];

    // Retry scenario = 11 commands (1 run + 10 mixed pass/fail). The runbook
    // routes through the named `## RECOVER` step on FAIL transitions, so the
    // footer step value must capture the non-numeric ID. This test exercises
    // the `/At:\s+([\w.]+)/` branch for named steps.
    for (let i = 0; i < 11; i++) {
      await action.click();
      if (i < 10) {
        await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
      }
      seenSteps.push(await page.locator(FOOTER_STEP).innerText());
    }

    expect(seenSteps.join(' | ')).toContain('RECOVER');

    // Final completion state.
    await expect(page.locator(FOOTER_RESULT)).toContainText('COMPLETE', { timeout: 60000 });
    await expect(page.locator(FOOTER_STEP)).toContainText('6/6');
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
    // positive (terminal text content collapses to whitespace).
    await expect(page.locator('.xterm-rows')).not.toContainText('COMPLETE');
    await expectTerminalEmpty(page);

    // Footer reset.
    await expect(page.locator(FOOTER_STEP)).toContainText('—/6');
    await expect(page.locator(FOOTER_RESULT)).toHaveCount(0);
  });
});
