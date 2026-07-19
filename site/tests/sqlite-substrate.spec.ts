import { test, expect } from '@playwright/test';

/**
 * Checked-in WebContainer substrate probe.
 *
 * The design spec's empirical findings — native `node:sqlite` is stubbed in
 * WebContainer, WASM sql.js runs and persists across sequential processes, and
 * the positive `jsh` shell marker holds — are load-bearing: they justify
 * "SQLite everywhere". This test is the cheap guard so a WebContainer runtime
 * change re-validates the substrate choice instead of silently invalidating it.
 *
 * Requires the site dev server; the probe page is a test-only isolated route.
 */
test.describe('SQLite WebContainer substrate', () => {
  test('sql.js persists across sequential processes; native is stubbed; marker holds', async ({
    page,
  }) => {
    await page.goto('/__sqlite-substrate-probe');

    const result = page.locator('#probe-result');
    // The probe boots WebContainer, installs sql.js, and runs four Node
    // processes; allow generous time.
    await expect(result).toHaveText(/PASS|FAIL/, { timeout: 110_000 });

    // On failure, surface the structured detail so a regression is diagnosable.
    if ((await result.textContent()) !== 'PASS') {
      throw new Error(`substrate probe failed: ${await page.locator('#probe-detail').textContent()}`);
    }

    await expect(result).toHaveText('PASS');
  });
});
