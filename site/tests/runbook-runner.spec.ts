import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The built WebContainer snapshot the shipped demo actually mounts. */
const SNAPSHOT_PATH = fileURLToPath(new URL('../public/rundown-snapshot.bin', import.meta.url));

/** The site's only WebContainer boot path. */
const BOOT_MODULE_PATH = fileURLToPath(new URL('../src/lib/webcontainer.ts', import.meta.url));

const FOOTER_STEP = '[data-testid="footer-step"]';
const FOOTER_RESULT = '[data-testid="footer-result"]';

/**
 * sql.js `dist/` files the snapshot MUST retain, derived from sql.js's own
 * `main` (`./dist/sql-wasm.js`) and `exports['.']` (`browser` →
 * `./dist/sql-wasm-browser.js`, `default` → `./dist/sql-wasm.js`). Each loader
 * is paired with the `.wasm` payload it resolves at runtime.
 * `site/scripts/prune-sqljs.mjs` computes the same set and throws when a
 * declared entry point or a retained loader's `.wasm` is missing; this asserts
 * the property on the produced artifact rather than on the pruner.
 */
const REQUIRED_SQLJS_ENTRIES = [
  'sql-wasm.js',
  'sql-wasm.wasm',
  'sql-wasm-browser.js',
  'sql-wasm-browser.wasm',
] as const;

/**
 * sql.js build variants the driver never loads. Their absence is what keeps the
 * asset inside the 12 MiB budget, so it is asserted rather than assumed — a
 * prune that silently no-ops would otherwise only surface as a deploy failure.
 */
const PRUNED_SQLJS_VARIANTS = [
  'sql-asm.js',
  'sql-asm-debug.js',
  'sql-wasm-debug.js',
  'worker.sql-wasm.js',
] as const;

/** WebAssembly module preamble: `\0asm` followed by version 1. */
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/**
 * Byte offsets at which `name` appears as a **directory entry** in the snapshot.
 *
 * `@webcontainer/snapshot` emits msgpack, so a short entry name is stored as a
 * fixstr: a single `0xA0 | length` prefix byte followed by the raw bytes. Framing
 * the search that way is what separates a real directory entry from the same
 * text appearing inside a bundled JavaScript file — an unframed `indexOf` finds
 * three `sql-wasm.js` hits in this artifact, two of them incidental.
 *
 * @param snapshot - Raw snapshot bytes.
 * @param name - Entry name to locate; must be at most 31 bytes so it is a fixstr.
 * @returns Offsets of the name bytes (excluding the prefix), in ascending order.
 */
function findEntryOffsets(snapshot: Buffer, name: string): number[] {
  expect(name.length, `${name} is too long to be a msgpack fixstr`).toBeLessThanOrEqual(31);
  const framed = Buffer.from(String.fromCharCode(0xa0 | name.length) + name, 'latin1');
  const offsets: number[] = [];
  for (let at = snapshot.indexOf(framed); at >= 0; at = snapshot.indexOf(framed, at + 1)) {
    offsets.push(at + 1);
  }
  return offsets;
}

test.describe('built WebContainer snapshot', () => {
  test('bundles the sql.js loaders and their WebAssembly payloads', () => {
    let snapshot: Buffer;
    try {
      snapshot = readFileSync(SNAPSHOT_PATH);
    } catch {
      throw new Error(
        `${SNAPSHOT_PATH} is missing. It is generated, not committed — run ` +
          '`pnpm --filter site run build:snapshot` (or `pnpm run verify:site`) first.',
      );
    }

    for (const entry of REQUIRED_SQLJS_ENTRIES) {
      expect(findEntryOffsets(snapshot, entry), `snapshot entry ${entry}`).toHaveLength(1);
    }

    for (const variant of PRUNED_SQLJS_VARIANTS) {
      expect(findEntryOffsets(snapshot, variant), `pruned sql.js variant ${variant}`).toEqual([]);
    }

    // A retained name proves the entry exists; it does not prove the payload is
    // a real module. Each `.wasm` entry is immediately followed by its msgpack
    // file record, so the WebAssembly preamble lands a few bytes past the name —
    // a zero-length or text placeholder could not satisfy this.
    for (const wasmEntry of REQUIRED_SQLJS_ENTRIES.filter((name) => name.endsWith('.wasm'))) {
      const [at] = findEntryOffsets(snapshot, wasmEntry);
      const window = snapshot.subarray(at + wasmEntry.length, at + wasmEntry.length + 64);
      expect(window.indexOf(WASM_MAGIC), `${wasmEntry} payload preamble`).toBeGreaterThanOrEqual(0);
    }
  });

  test('is mounted, never installed: the boot path runs no package manager', () => {
    const bootModule = readFileSync(BOOT_MODULE_PATH, 'utf-8');

    // The offline property is structural: the demo has exactly one way to get a
    // filesystem, and it is a mount of the prebuilt snapshot.
    expect(bootModule).toContain("fetch('/rundown-snapshot.bin')");
    expect(bootModule).toContain('container.mount(snapshotData)');

    // Nothing in the boot path may fetch packages at runtime. Asserted on the
    // source because WebContainer tunnels container network traffic through its
    // own transport, so a registry fetch is not reliably visible to Playwright's
    // request interception. Comment lines are dropped first — this module
    // explains twice, in prose, that it exists to avoid `npm install`.
    const code = bootModule
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/\b(npm|pnpm|yarn)\b[^\n]*\b(install|add|ci)\b/);
  });
});

test.describe('runbook execution off the built snapshot', () => {
  // One WebContainer per page, and booting several concurrently is what makes
  // this suite flaky locally. `landing-page.spec.ts` serialises for the same
  // reason.
  test.describe.configure({ mode: 'serial' });

  /** Hosts a runtime package install would have to reach. */
  const PACKAGE_REGISTRY = /registry\.npmjs\.org|\/\/registry\.|unpkg\.com|cdn\.jsdelivr\.net/;

  /**
   * Observed network activity for one demo run.
   *
   * The positive half is what keeps this from being vacuous: the snapshot fetch
   * definitely happens, so asserting it proves the environment really came from
   * `public/rundown-snapshot.bin`. The negative half is best-effort — nothing
   * guarantees a container-side registry fetch surfaces as a page request — so
   * it complements, rather than replaces, the structural check above.
   */
  interface DemoNetwork {
    /** Status of the `/rundown-snapshot.bin` response, or -1 if never fetched. */
    snapshotStatus: number;
    /** Every requested URL that looks like a package registry. */
    registryHits: string[];
  }

  /**
   * Load the homepage demo, recording network activity, and wait for the
   * mounted snapshot to be ready.
   *
   * @param page - The Playwright page under test.
   * @returns The network observations for this run, populated as it proceeds.
   */
  async function bootHomepageDemo(page: Page): Promise<DemoNetwork> {
    const network: DemoNetwork = { snapshotStatus: -1, registryHits: [] };
    page.on('request', (request) => {
      if (PACKAGE_REGISTRY.test(request.url())) network.registryHits.push(request.url());
    });
    page.on('response', (response) => {
      if (response.url().includes('/rundown-snapshot.bin')) {
        network.snapshotStatus = response.status();
      }
    });

    await page.goto('/');
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
    return network;
  }

  /**
   * Assert the demo's environment came from the built snapshot and nothing was
   * installed at runtime.
   *
   * @param network - Observations gathered by {@link bootHomepageDemo}.
   */
  function expectOfflineBoot(network: DemoNetwork): void {
    // Any 2xx: the dev server answers 200, but a range or revalidated response
    // is still a successful fetch of the built asset.
    expect(network.snapshotStatus, 'GET /rundown-snapshot.bin').toBeGreaterThanOrEqual(200);
    expect(network.snapshotStatus, 'GET /rundown-snapshot.bin').toBeLessThan(300);
    expect(network.registryHits).toEqual([]);
  }

  test('run, pass and fail reach COMPLETE with no runtime install', async ({ page }) => {
    const network = await bootHomepageDemo(page);

    await page.getByRole('button', { name: /Retry on fail/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // 11 commands: `rd run --prompted`, then a mixed pass/fail sequence. The
    // fail arms are the point — they prove `rd fail` dispatches against the
    // snapshot-resident CLI and its sql.js-backed store, not just `rd pass`.
    const action = page.getByRole('button', { name: /^(Next|Complete)$/ });
    for (let click = 0; click < 11; click++) {
      await action.click();
      if (click < 10) {
        await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
      }
    }

    await expect(page.locator(FOOTER_RESULT)).toContainText('COMPLETE', { timeout: 60000 });
    await expect(page.locator(FOOTER_STEP)).toContainText('6/6');
    expectOfflineBoot(network);
  });

  test('goto reaches COMPLETE with no runtime install', async ({ page }) => {
    const network = await bootHomepageDemo(page);

    await page.getByRole('button', { name: /Skip to end/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // 3 commands: `rd run --prompted`, `rd goto 6`, `rd pass`.
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    await page.getByRole('button', { name: 'Complete', exact: true }).click();

    await expect(page.locator(FOOTER_RESULT)).toContainText('COMPLETE', { timeout: 60000 });
    await expect(page.locator(FOOTER_STEP)).toContainText('6/6');
    expectOfflineBoot(network);
  });
});

test.describe('RunbookRunner', () => {
  test('executes auto-execution scenario correctly', async ({ page }) => {
    // 1. Navigate to the pattern page
    await page.goto('/explore/code-blocks');

    // 2. Wait for WebContainer to boot (Status: Ready)
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    // 3. Select the 'auto-execution' scenario
    await page.getByRole('button', { name: 'auto-execution' }).click();

    // 4. Click 'Next' to start the auto-execution scenario
    // The scenario has only 1 command (rd run without --prompted) which runs to completion

    await page.getByRole('button', { name: 'Next' }).first().click();

    // 5. Wait for execution to finish
    // We expect the result 'COMPLETE' to appear in the footer
    const resultContainer = page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Result', { exact: true }) })
      .last();

    // Check that this container eventually contains "COMPLETE"
    await expect(resultContainer).toContainText('COMPLETE', { timeout: 30000 });

    // 6. Verify Step count in footer - should be "3/3" at the end
    const stepContainer = page.locator('div.flex.items-center.gap-2')
      .filter({ has: page.getByText('Step', { exact: true }) });

    await expect(stepContainer).toContainText('3/3');

    // 7. Verify terminal output contains expected text
    await expect(page.locator('.xterm-rows')).toContainText('Runbook:  COMPLETE');
  });
});
