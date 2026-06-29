import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// dir = package directory; each ships a stryker.config.mjs + a package.json.
const packages = ['claude-code-plugin', 'cli', 'core', 'parser'];
const configs = packages.map((pkg) => `packages/${pkg}/stryker.config.mjs`);

async function loadConfig(configPath, value) {
  const previous = process.env.STRYKER_CONCURRENCY;
  try {
    if (value === undefined) {
      delete process.env.STRYKER_CONCURRENCY;
    } else {
      process.env.STRYKER_CONCURRENCY = value;
    }

    const configUrl = pathToFileURL(join(repoRoot, configPath));
    configUrl.searchParams.set('case', `${value ?? 'default'}-${Date.now()}-${Math.random()}`);
    return (await import(configUrl.href)).default;
  } finally {
    if (previous === undefined) {
      delete process.env.STRYKER_CONCURRENCY;
    } else {
      process.env.STRYKER_CONCURRENCY = previous;
    }
  }
}

/**
 * Load a Stryker config with an arbitrary set of env vars temporarily applied.
 * Restores prior env values (including "unset") in a finally block.
 *
 * @param {string} configPath - repo-relative path to a stryker.config.mjs.
 * @param {Record<string, string | undefined>} env - env vars to apply; a value
 *   of `undefined` deletes the var for the duration of the load.
 * @returns {Promise<object>} the config module's default export.
 */
async function loadConfigWithEnv(configPath, env) {
  const keys = Object.keys(env);
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    const configUrl = pathToFileURL(join(repoRoot, configPath));
    configUrl.searchParams.set('case', `${JSON.stringify(env)}-${Date.now()}-${Math.random()}`);
    return (await import(configUrl.href)).default;
  } finally {
    for (const k of keys) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
  }
}

/**
 * Collect the source of every within-package file reachable from `entryAbs` by
 * following its relative ESM imports. A Stryker jest config is often a thin
 * wrapper (`jest.stryker.config.js`) that re-exports `makeConfig` from a sibling
 * factory (`jest.config.shared.js`), so scanning only the entry file would miss
 * a sandbox-escaping import reintroduced in the factory. Walking the graph keeps
 * the issue #485 coverage on the actual source Stryker runs, not just the
 * wrapper. An import that resolves OUTSIDE the package dir (e.g. the root
 * `../../jest.config.base.js`) is the escape we flag, so it is not traversed —
 * the source-text assertion on the importing file catches it.
 *
 * @param {string} entryAbs - absolute path to the entry jest config file.
 * @param {string} packageDirAbs - absolute package directory; only imports that
 *   stay within it are traversed.
 * @returns {Promise<Map<string, string>>} map of absolute file path to source.
 */
async function collectLocalConfigSources(entryAbs, packageDirAbs) {
  const seen = new Map();
  const queue = [entryAbs];
  // Matches static and dynamic relative specifiers: `from './x.js'`,
  // `import './x.js'`, `import('./x.js')`.
  const importRe = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
  while (queue.length > 0) {
    const fileAbs = queue.shift();
    if (seen.has(fileAbs)) continue;
    let source;
    try {
      source = await readFile(fileAbs, 'utf-8');
    } catch {
      continue; // unresolved path; the importer's source-text scan still flags it
    }
    seen.set(fileAbs, source);
    for (const [, spec] of source.matchAll(importRe)) {
      const importedAbs = resolve(dirname(fileAbs), spec);
      // Use the platform path separator: both paths come from node:path (resolve
      // / join), so a hardcoded '/' would never match on Windows and silently
      // skip traversal into the shared factory.
      if (importedAbs.startsWith(`${packageDirAbs}${sep}`)) queue.push(importedAbs);
    }
  }
  return seen;
}

for (const configPath of configs) {
  test(`${configPath} parses STRYKER_CONCURRENCY overrides`, async () => {
    assert.equal((await loadConfig(configPath, '1')).concurrency, 1);
    assert.equal((await loadConfig(configPath, 'invalid')).concurrency, 2);
    assert.equal((await loadConfig(configPath, '-1')).concurrency, 2);
    assert.equal((await loadConfig(configPath, undefined)).concurrency, 2);
  });

  test(`${configPath} sets a non-null break threshold (issue #483)`, async () => {
    const config = await loadConfig(configPath, undefined);
    // break: null lets Stryker exit 0 regardless of score, so a catastrophic
    // drop can never fail CI. A real floor makes the weekly run fail loudly.
    assert.equal(
      typeof config.thresholds?.break,
      'number',
      `${configPath}: thresholds.break must be a number, not null`,
    );
    assert.ok(
      config.thresholds.break >= 70,
      `${configPath}: thresholds.break should be at least 70`,
    );
  });

  test(`${configPath} defaults ignoreStatic to false for exhaustive fidelity (issue #485)`, async () => {
    const config = await loadConfigWithEnv(configPath, { STRYKER_IGNORE_STATIC: undefined });
    // The producer run (mutation.yml) sets no env, so static mutants MUST be
    // scored there. Only the advisory PR run opts into ignoreStatic.
    assert.equal(
      config.ignoreStatic,
      false,
      `${configPath}: ignoreStatic must default to false (exhaustive run must score static mutants)`,
    );
  });

  test(`${configPath} enables ignoreStatic only when STRYKER_IGNORE_STATIC is truthy (issue #485)`, async () => {
    assert.equal(
      (await loadConfigWithEnv(configPath, { STRYKER_IGNORE_STATIC: 'true' })).ignoreStatic,
      true,
    );
    assert.equal(
      (await loadConfigWithEnv(configPath, { STRYKER_IGNORE_STATIC: '1' })).ignoreStatic,
      true,
    );
    assert.equal(
      (await loadConfigWithEnv(configPath, { STRYKER_IGNORE_STATIC: 'false' })).ignoreStatic,
      false,
    );
    assert.equal(
      (await loadConfigWithEnv(configPath, { STRYKER_IGNORE_STATIC: '' })).ignoreStatic,
      false,
    );
  });

  test(`${configPath} omits the dashboard reporter when no API key is set`, async () => {
    const config = await loadConfigWithEnv(configPath, { STRYKER_DASHBOARD_API_KEY: undefined });
    assert.ok(
      Array.isArray(config.reporters) && !config.reporters.includes('dashboard'),
      `${configPath}: dashboard reporter must be off without STRYKER_DASHBOARD_API_KEY`,
    );
  });

  test(`${configPath} enables the dashboard reporter when the API key is set`, async () => {
    const config = await loadConfigWithEnv(configPath, { STRYKER_DASHBOARD_API_KEY: 'fake-key' });
    assert.ok(
      config.reporters.includes('dashboard'),
      `${configPath}: dashboard reporter must turn on when STRYKER_DASHBOARD_API_KEY is present`,
    );
  });

  test(`${configPath} pins the dashboard project and a full report type`, async () => {
    const config = await loadConfigWithEnv(configPath, { STRYKER_DASHBOARD_API_KEY: 'fake-key' });
    assert.equal(config.dashboard?.project, 'github.com/tobyhede/rundown');
    assert.equal(config.dashboard?.reportType, 'full');
    assert.ok(
      typeof config.dashboard?.module === 'string' && config.dashboard.module.length > 0,
      `${configPath}: dashboard.module must be a non-empty per-package module name`,
    );
  });

  test(`${configPath} pins dashboard.version from STRYKER_DASHBOARD_VERSION`, async () => {
    const pinned = await loadConfigWithEnv(configPath, {
      STRYKER_DASHBOARD_API_KEY: 'fake-key',
      STRYKER_DASHBOARD_VERSION: 'main',
    });
    assert.equal(
      pinned.dashboard?.version,
      'main',
      `${configPath}: dashboard.version must come from STRYKER_DASHBOARD_VERSION`,
    );

    const unset = await loadConfigWithEnv(configPath, {
      STRYKER_DASHBOARD_API_KEY: 'fake-key',
      STRYKER_DASHBOARD_VERSION: undefined,
    });
    assert.equal(
      unset.dashboard?.version,
      undefined,
      `${configPath}: dashboard.version must be undefined (CI auto-detect) when unset`,
    );
  });

  test(`${configPath} pins pnpm + the explicit jest-runner plugin`, async () => {
    const config = await loadConfig(configPath, undefined);
    // pnpm's isolated layout breaks Stryker's default '@stryker-mutator/*'
    // plugin auto-discovery, so both must be set explicitly or mutation runs
    // fail with "Cannot find TestRunner plugin jest".
    assert.equal(config.packageManager, 'pnpm', `${configPath}: packageManager must be 'pnpm'`);
    assert.ok(
      Array.isArray(config.plugins) && config.plugins.includes('@stryker-mutator/jest-runner'),
      `${configPath}: plugins must explicitly include '@stryker-mutator/jest-runner'`,
    );
  });
}

const expectedModules = {
  'packages/parser/stryker.config.mjs': 'parser',
  'packages/core/stryker.config.mjs': 'core',
  'packages/cli/stryker.config.mjs': 'cli',
  'packages/claude-code-plugin/stryker.config.mjs': 'plugin',
};
for (const [configPath, moduleName] of Object.entries(expectedModules)) {
  test(`${configPath} declares dashboard.module = ${moduleName}`, async () => {
    const config = await loadConfigWithEnv(configPath, { STRYKER_DASHBOARD_API_KEY: 'fake-key' });
    assert.equal(config.dashboard.module, moduleName);
  });
}

// Targeting invariants (issue #485): mutation is scoped to correctness-critical
// code. Presentation and declarative layers are excluded so the full-fidelity
// run spends its budget where a costly bug can actually hide. These pins stop a
// future edit from silently re-widening the scope and reinflating the run.
const expectedMutateExclusions = {
  'packages/core/stryker.config.mjs': ['!src/output/**', '!src/cli/**', '!src/logger.ts'],
  'packages/cli/stryker.config.mjs': ['!src/scripts/**', '!src/services/renderers/**'],
};
for (const [configPath, exclusions] of Object.entries(expectedMutateExclusions)) {
  test(`${configPath} excludes low-value presentation/declarative paths from mutation`, async () => {
    const config = await loadConfig(configPath, undefined);
    assert.ok(Array.isArray(config.mutate), `${configPath}: mutate must be an array`);
    // The base glob must stay first so the negations actually subtract from it.
    assert.equal(
      config.mutate[0],
      'src/**/*.ts',
      `${configPath}: mutate[0] must be the 'src/**/*.ts' base glob`,
    );
    for (const exclusion of exclusions) {
      assert.ok(
        config.mutate.includes(exclusion),
        `${configPath}: mutate must exclude ${exclusion} (low-value mutation target)`,
      );
    }
  });
}

// core/cli explicitly carry the throughput+memory fix that lets a full campaign
// finish. parser/plugin leave jest.enableFindRelatedTests at its schema default
// (true) and are small enough to complete; these two had it overridden to false,
// which made every mutant reload the whole suite -> ~1.3 mutants/min and an
// OOM death spiral. The pins below stop a future edit from re-introducing that.
const campaignFinishConfigs = [
  'packages/core/stryker.config.mjs',
  'packages/cli/stryker.config.mjs',
];
for (const configPath of campaignFinishConfigs) {
  test(`${configPath} scopes each mutant to related tests (issue #485)`, async () => {
    const config = await loadConfig(configPath, undefined);
    // false reloads all test files per mutant (the regression that floored
    // throughput and OOM'd the in-band runner). true restores the jest-runner
    // default: only the tests that transitively import the mutated file run.
    assert.equal(
      config.jest?.enableFindRelatedTests,
      true,
      `${configPath}: jest.enableFindRelatedTests must be true (false stops the campaign from finishing)`,
    );
  });

  test(`${configPath} recycles the test runner to cap the in-band leak (issue #485)`, async () => {
    const config = await loadConfigWithEnv(configPath, {
      STRYKER_MAX_TEST_RUNNER_REUSE: undefined,
    });
    // A positive maxTestRunnerReuse is what bounds the residual per-run heap leak
    // in Stryker's long-lived in-band jest child. 0/undefined means infinite
    // reuse, i.e. no recycling — the leak is then unbounded again.
    assert.equal(
      typeof config.maxTestRunnerReuse,
      'number',
      `${configPath}: maxTestRunnerReuse must be a number`,
    );
    assert.ok(
      config.maxTestRunnerReuse > 0,
      `${configPath}: maxTestRunnerReuse must be > 0 (0 disables recycling and re-opens the leak)`,
    );
  });

  test(`${configPath} honors STRYKER_MAX_TEST_RUNNER_REUSE overrides`, async () => {
    assert.equal(
      (await loadConfigWithEnv(configPath, { STRYKER_MAX_TEST_RUNNER_REUSE: '10' }))
        .maxTestRunnerReuse,
      10,
    );
    // Non-positive / garbage falls back to the safe default rather than 0
    // (which would silently disable recycling).
    assert.equal(
      (await loadConfigWithEnv(configPath, { STRYKER_MAX_TEST_RUNNER_REUSE: '0' }))
        .maxTestRunnerReuse,
      25,
    );
    assert.equal(
      (await loadConfigWithEnv(configPath, { STRYKER_MAX_TEST_RUNNER_REUSE: 'nope' }))
        .maxTestRunnerReuse,
      25,
    );
  });
}

test('packages/core widens the mutation timeout budget (issue #483)', async () => {
  const config = await loadConfig('packages/core/stryker.config.mjs', undefined);
  // Core hosts the heaviest actors; the previous 30000ms / 2.5x budget produced
  // spurious Timeout results counted as undetected mutants, depressing the score
  // and making the gate fire on flake. The widened budget must persist.
  assert.ok(
    config.timeoutMS >= 60000,
    `core timeoutMS must be at least 60000 (was ${config.timeoutMS})`,
  );
  assert.ok(
    config.timeoutFactor >= 3,
    `core timeoutFactor must be at least 3 (was ${config.timeoutFactor})`,
  );
});

for (const pkg of packages) {
  test(`packages/${pkg} runs Stryker against a sandbox-safe jest config (issue #485)`, async () => {
    const config = await loadConfig(`packages/${pkg}/stryker.config.mjs`, undefined);
    const configFile = config.jest?.configFile;
    assert.ok(
      typeof configFile === 'string' && configFile.length > 0,
      `packages/${pkg}: stryker jest.configFile must be set`,
    );
    // Stryker copies ONLY the package dir into `.stryker-tmp/sandbox-*`, so the
    // jest config it runs must be SELF-CONTAINED. A root-relative
    // `../../jest.config.base.js` import escapes the sandbox and crashes the run
    // with ERR_MODULE_NOT_FOUND — exactly how the producer (mutation.yml)
    // silently failed for parser/plugin while core/cli passed. The config Stryker
    // runs is split across a thin wrapper (the `configFile`) and the
    // `makeConfig` factory it imports (`jest.config.shared.js`), so scan EVERY
    // within-package file reachable from the entry, not just the wrapper.
    const packageDirAbs = join(repoRoot, `packages/${pkg}`);
    const sources = await collectLocalConfigSources(join(packageDirAbs, configFile), packageDirAbs);
    assert.ok(sources.size > 0, `packages/${pkg}/${configFile} must be readable`);
    // Match an actual import OF jest.config.base (static or dynamic), not a mere
    // mention — the factory's own header comment explains why it avoids the root
    // base config, and that prose must not trip the guard.
    const baseImportRe = /(?:from|import)\s*\(?\s*['"][^'"]*jest\.config\.base[^'"]*['"]/;
    for (const [fileAbs, source] of sources) {
      assert.doesNotMatch(
        source,
        baseImportRe,
        `${relative(repoRoot, fileAbs)} must not import the root jest.config.base.js (it escapes the Stryker sandbox)`,
      );
    }
  });

  test(`packages/${pkg} declares the Stryker devDependencies`, async () => {
    const manifest = JSON.parse(
      await readFile(join(repoRoot, `packages/${pkg}/package.json`), 'utf-8'),
    );
    const devDeps = manifest.devDependencies ?? {};
    // pnpm only exposes a package's declared deps; the root no longer hoists
    // these, so each mutating package must declare them itself.
    for (const dep of ['@stryker-mutator/core', '@stryker-mutator/jest-runner']) {
      assert.ok(
        devDeps[dep],
        `packages/${pkg}/package.json must declare ${dep} in devDependencies`,
      );
    }
  });
}
