import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

/**
 * A string that appears in the probe's script and nowhere else on the site.
 *
 * It is the element id the probe writes its progress to, so it is a string
 * literal in the bundle rather than a renameable identifier — minification
 * preserves it. The build test asserts it is absent from every emitted script;
 * it also asserts it is still present in the probe source, so a rename cannot
 * quietly turn that guard into a search for a string nothing contains.
 */
const PROBE_MARKER = 'probe-status';

/** The probe page. Outside `src/pages/`; routed in dev by `devOnlyRoutes()`. */
const PROBE_SOURCE = fileURLToPath(
  new URL('../src/dev/sqlite-substrate-probe.astro', import.meta.url),
);

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

  /**
   * Nothing of the probe reaches `dist/` — checked against a real build.
   *
   * `devOnlyRoutes()` keeping the page out of `src/pages/` is what MAKES this
   * true; this test is the empirical check that it stayed true, and it asserts
   * the outcome rather than the mechanism so it survives a change of technique.
   * Two mechanisms have already failed here. A plain
   * `src/pages/dev/sqlite-substrate-probe.astro` emitted the page and its
   * script. Replacing it with a dynamic `[probe].astro` whose `getStaticPaths`
   * returned nothing in a build removed the PAGE and nothing else: Astro
   * compiles every module under `src/pages/` and hoists its `<script>` whether
   * or not the route emits, so the build still wrote the probe's entire script
   * to `_assets/_probe_.astro_astro_type_script_index_0_lang.<hash>.js`.
   *
   * That is also why filenames alone are not the outcome. The hoisted asset is
   * named after the ROUTE, so it read `_probe_`, and a `dist/` listing filtered
   * for "sqlite-substrate-probe" came back empty while the code shipped. Hence
   * the second half below: every emitted script is searched for the probe's own
   * marker. The build costs a few seconds, which is cheap enough to live here.
   */
  test('a production build emits no probe route and no probe asset', async (): Promise<void> => {
    // The marker search below is only a guard while the probe still contains
    // the marker.
    expect(await readFile(PROBE_SOURCE, 'utf8')).toContain(PROBE_MARKER);

    const siteRoot = fileURLToPath(new URL('..', import.meta.url));
    const outDir = await mkdtemp(join(tmpdir(), 'rd-site-build-'));
    try {
      // `astro build` directly rather than `npm run build`: the latter's
      // `prebuild` rebuilds the WebContainer snapshot, which this proves
      // nothing about and which costs far more than the build itself.
      execFileSync('npx', ['astro', 'build', '--outDir', outDir], {
        cwd: siteRoot,
        stdio: 'pipe',
      });

      const emitted = await readdir(outDir, { recursive: true });
      expect(emitted.filter((entry) => entry.includes('sqlite-substrate-probe'))).toEqual([]);

      // No emitted script carries the probe's code either, whatever it is
      // named. `PROBE_MARKER` survives bundling and minification because it is
      // a string literal the probe passes to `getElementById`, not an
      // identifier a minifier may rename. Reported as the offending filenames
      // rather than a boolean so a failure says which asset leaked.
      const scripts = emitted.filter((entry) => entry.endsWith('.js'));
      const contaminated: string[] = [];
      for (const script of scripts) {
        if ((await readFile(join(outDir, script), 'utf8')).includes(PROBE_MARKER)) {
          contaminated.push(script);
        }
      }
      expect(contaminated).toEqual([]);

      // Cheap independent check that the build produced anything at all, so a
      // build that emitted nothing cannot pass the assertions above vacuously.
      expect(emitted).toContain('index.html');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
