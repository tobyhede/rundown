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
 * Requires only the site dev server. The probe page is a test-only isolated
 * route under `/dev/`, not linked from any shipped page, and it mounts its own
 * files into a fresh WebContainer rather than loading
 * `public/rundown-snapshot.bin` — so unlike the homepage demo this spec runs
 * without the snapshot built.
 *
 * That independence is deliberate and is also this spec's limit: proving the
 * *substrate* is not proving the *shipped artifact*. The complementary proof —
 * that the built snapshot bundles the sql.js loader and its WASM payload, and
 * that run/pass/fail/goto work off it with no runtime install — lives in
 * `runbook-runner.spec.ts`, which does load `public/rundown-snapshot.bin`.
 */
test.describe('SQLite WebContainer substrate', () => {
  test('sql.js persists across sequential processes; native is stubbed; marker holds', async ({
    page,
  }) => {
    await page.goto('/dev/sqlite-substrate-probe');

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
