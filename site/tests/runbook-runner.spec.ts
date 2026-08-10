import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/** The built WebContainer snapshot the shipped demo actually mounts. */
const SNAPSHOT_PATH = fileURLToPath(new URL('../public/rundown-snapshot.bin', import.meta.url));

/** The runbook the homepage demo loads, and the source of truth for its scenarios. */
const HOMEPAGE_RUNBOOK_PATH = fileURLToPath(
  new URL('../public/this-is-rundown.runbook.md', import.meta.url),
);

/**
 * The command list a named homepage scenario declares.
 *
 * Read from the runbook rather than restated in the test: the demo advances one
 * command per click, so a hard-coded click count silently drifts the moment the
 * runbook is edited — clicking too few leaves the run unfinished and clicking
 * too many acts on a completed one. Deriving it means an edit to the scenario
 * either keeps the test honest or fails it outright.
 *
 * @param name - Scenario key under the runbook's `scenarios:` frontmatter.
 * @returns The scenario's declared commands, in order.
 * @throws {Error} When the runbook has no frontmatter, or no such scenario.
 */
function scenarioCommands(name: string): string[] {
  const source = readFileSync(HOMEPAGE_RUNBOOK_PATH, 'utf-8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];
  if (frontmatter === undefined) {
    throw new Error(`${HOMEPAGE_RUNBOOK_PATH} has no YAML frontmatter.`);
  }
  const parsed = parseYaml(frontmatter) as {
    scenarios?: Record<string, { commands?: string[] }>;
  };
  const commands = parsed.scenarios?.[name]?.commands;
  if (commands === undefined || commands.length === 0) {
    throw new Error(`Scenario "${name}" declares no commands.`);
  }
  return commands;
}

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
 * fixstr: a single `0xA0 | byteLength` prefix byte followed by the name's UTF-8
 * bytes. Framing the search that way is what separates a real directory entry
 * from the same text appearing inside a bundled JavaScript file — an unframed
 * `indexOf` finds three `sql-wasm.js` hits in this artifact, two of them
 * incidental.
 *
 * Both halves of the framing are computed from the UTF-8 encoding, never from
 * `String.length`: msgpack counts bytes, and a JavaScript string counts UTF-16
 * code units. The two agree for every entry name in the snapshot today, so this
 * is robustness rather than a live fix — see the `café.js` case for the only
 * thing that can distinguish them.
 *
 * @param snapshot - Raw snapshot bytes.
 * @param name - Entry name to locate; must encode to at most 31 bytes so it is a fixstr.
 * @returns Offsets of the name bytes (excluding the prefix), in ascending order.
 */
function findEntryOffsets(snapshot: Buffer, name: string): number[] {
  const nameBytes = Buffer.from(name, 'utf8');
  expect(
    nameBytes.byteLength,
    `${name} is too long to be a msgpack fixstr`,
  ).toBeLessThanOrEqual(31);
  const framed = Buffer.concat([Buffer.from([0xa0 | nameBytes.byteLength]), nameBytes]);
  const offsets: number[] = [];
  for (let at = snapshot.indexOf(framed); at >= 0; at = snapshot.indexOf(framed, at + 1)) {
    offsets.push(at + 1);
  }
  return offsets;
}

/**
 * Byte length of an entry name as msgpack stores it.
 *
 * The payload-preamble check walks forward from an entry name, so it must step
 * by the same unit the snapshot uses. Sharing this with {@link findEntryOffsets}
 * is what stops the two from disagreeing on a non-ASCII name.
 *
 * @param name - Entry name.
 * @returns The name's UTF-8 byte length.
 */
function entryByteLength(name: string): number {
  return Buffer.byteLength(name, 'utf8');
}

test.describe('built WebContainer snapshot', () => {
  test('locates an entry name by its BYTE framing, not its UTF-16 length', () => {
    // msgpack frames a fixstr by byte length, and stores the name as UTF-8.
    // `café.js` is 7 UTF-16 code units but 8 UTF-8 bytes, so a helper that
    // frames by `String.length` looks for prefix 0xA7 instead of 0xA8 — and,
    // encoding the name as latin1, writes 0xE9 where msgpack holds 0xC3 0xA9.
    // Both are wrong, and it finds nothing.
    //
    // Every entry name in the real snapshot is ASCII today, so no assertion
    // over the built artifact can reach this. The synthetic buffer is the only
    // thing that can, which is why it exists.
    const nameBytes = Buffer.from('café.js', 'utf8');
    expect(nameBytes.byteLength, 'fixture is genuinely multi-byte').toBe(8);
    expect('café.js'.length, 'fixture length differs from its byte length').toBe(7);

    const synthetic = Buffer.concat([
      Buffer.from([0x81, 0xa1, 0x64]), // leading msgpack noise
      Buffer.from([0xa0 | nameBytes.byteLength]),
      nameBytes,
      Buffer.from([0x81, 0xa1, 0x66]), // trailing msgpack noise
    ]);

    expect(findEntryOffsets(synthetic, 'café.js')).toEqual([4]);
  });

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
      const nameEnd = at + entryByteLength(wasmEntry);
      const window = snapshot.subarray(nameEnd, nameEnd + 64);
      expect(window.indexOf(WASM_MAGIC), `${wasmEntry} payload preamble`).toBeGreaterThanOrEqual(0);
    }
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
   * Both halves are load-bearing. The snapshot fetch definitely happens, so
   * asserting it proves the environment really came from
   * `public/rundown-snapshot.bin` rather than from anywhere else. The registry
   * requests are **severed**, not merely counted: the route handler aborts them,
   * so a demo that depended on one would fail outright instead of quietly
   * succeeding while the test recorded a hit it had no way to act on.
   */
  interface DemoNetwork {
    /** Status of the `/rundown-snapshot.bin` response, or -1 if never fetched. */
    snapshotStatus: number;
    /** Every package-registry URL the page attempted, all of them aborted. */
    registryAttempts: string[];
  }

  /**
   * Load the homepage demo with package registries unreachable, and wait for the
   * mounted snapshot to be ready.
   *
   * Severing the registries is what makes "no runtime install" a property of the
   * run rather than a property of the boot module's source text. It replaces an
   * earlier assertion that grepped `src/lib/webcontainer.ts` for `npm install`
   * and for exact quoted call sites — that broke on a reformat, weakened on a
   * reworded comment, and could never observe what the page actually did.
   *
   * @param page - The Playwright page under test.
   * @returns The network observations for this run, populated as it proceeds.
   */
  async function bootHomepageDemo(page: Page): Promise<DemoNetwork> {
    const network: DemoNetwork = { snapshotStatus: -1, registryAttempts: [] };

    // Matched by predicate, NOT by `'**/*'` with an in-handler test. The demo
    // is a cross-origin-isolated page that streams a ~10 MiB snapshot and boots
    // a WebContainer, so routing every request through Playwright's
    // interception layer puts it in front of traffic this test has no business
    // touching. A predicate leaves everything unmatched on the normal path and
    // intercepts only the hosts an install would use.
    await page.route(
      (url) => PACKAGE_REGISTRY.test(url.href),
      async (route) => {
        network.registryAttempts.push(route.request().url());
        await route.abort();
      },
    );

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
   * Assert the demo's environment came from the built snapshot and that nothing
   * was installed at runtime.
   *
   * @param network - Observations gathered by {@link bootHomepageDemo}.
   */
  function expectOfflineBoot(network: DemoNetwork): void {
    // Any 2xx: the dev server answers 200, but a range or revalidated response
    // is still a successful fetch of the built asset.
    expect(network.snapshotStatus, 'GET /rundown-snapshot.bin').toBeGreaterThanOrEqual(200);
    expect(network.snapshotStatus, 'GET /rundown-snapshot.bin').toBeLessThan(300);
    expect(network.registryAttempts, 'package-registry requests (all aborted)').toEqual([]);
  }

  /**
   * Step a scenario to its end, one click per declared command.
   *
   * The action button reads `Next` for every command but the last, which reads
   * `Complete`, so one regex covers both and the count comes from the scenario
   * rather than from a literal in this file.
   *
   * @param page - The Playwright page under test.
   * @param commands - The scenario's declared commands.
   */
  async function stepThroughScenario(page: Page, commands: string[]): Promise<void> {
    const action = page.getByRole('button', { name: /^(Next|Complete)$/ });
    for (let click = 0; click < commands.length; click++) {
      await action.click();
      if (click < commands.length - 1) {
        await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });
      }
    }
  }

  test('run, pass and fail reach COMPLETE with no runtime install', async ({ page }) => {
    const commands = scenarioCommands('retry');

    // Assert the scenario still exercises what this test claims to cover. The
    // fail arms are the point — they prove `rd fail` dispatches against the
    // snapshot-resident CLI and its sql.js-backed store, not just `rd pass`. An
    // edit that dropped them would otherwise leave a green test covering less.
    expect(commands[0], 'scenario starts the run').toMatch(/^rd run\b/);
    expect(commands.filter((c) => /^rd fail\b/.test(c)).length).toBeGreaterThan(0);
    expect(commands.filter((c) => /^rd pass\b/.test(c)).length).toBeGreaterThan(0);

    const network = await bootHomepageDemo(page);

    await page.getByRole('button', { name: /Retry on fail/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    await stepThroughScenario(page, commands);

    await expect(page.locator(FOOTER_RESULT)).toContainText('COMPLETE', { timeout: 60000 });
    // Six numbered headings in the runbook — a property of the document, not of
    // the scenario, so it stays a literal.
    await expect(page.locator(FOOTER_STEP)).toContainText('6/6');
    expectOfflineBoot(network);
  });

  test('goto reaches COMPLETE with no runtime install', async ({ page }) => {
    const commands = scenarioCommands('start');

    expect(commands[0], 'scenario starts the run').toMatch(/^rd run\b/);
    expect(commands.filter((c) => /^rd goto\b/.test(c)).length).toBeGreaterThan(0);

    const network = await bootHomepageDemo(page);

    await page.getByRole('button', { name: /Skip to end/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60000 });

    await stepThroughScenario(page, commands);

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
