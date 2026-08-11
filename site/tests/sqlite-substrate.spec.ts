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
 * Requires the site DEV server specifically, not a preview of the production
 * build. The probe page lives outside `src/pages/` and is injected as a route
 * only when Astro runs with `command === 'dev'` (see `astro.config.mjs`'s
 * `devOnlyRoutes()`), because the page boots a WebContainer and npm-installs
 * sql.js on load and must never be deployed. `playwright.config.ts` runs the
 * suite against `npm run dev`, so the route is live here. It mounts its own
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
    const response = await page.goto('/dev/sqlite-substrate-probe');

    // Assert the route resolved BEFORE waiting on the probe. The route is
    // injected only in dev, so a config regression (or running this suite
    // against a preview of the production build) 404s it — and a 404 body has
    // no `#probe-result`, which would otherwise surface as an inscrutable 110s
    // timeout rather than "the route is gone". Fail loudly, and fast.
    expect(
      response?.status(),
      'the dev-only probe route did not resolve — see devOnlyRoutes() in astro.config.mjs',
    ).toBe(200);

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
