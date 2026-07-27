// Guards the `*.repo-asset.test.ts` convention that keeps Stryker's dry run
// alive.
//
// Stryker copies only the package directory into `.stryker-tmp/sandbox-*`, which
// adds two path segments. A test that reaches an asset OUTSIDE its package via a
// relative traversal off `import.meta.url` therefore resolves to
// `packages/<pkg>/<path>` in the sandbox, where the asset does not exist. The
// failure is not a skipped assertion: it is a hard
// `There were failed tests in the initial test run.` abort that kills the whole
// campaign before a single mutant is tested — and because the shard step is
// `continue-on-error`, it reported as success.
//
// Two rules close the class, and this file is what keeps them true:
//   1. every mutation-tested package's sandbox config must ignore the naming
//      convention, so the escape hatch actually exists everywhere;
//   2. no test collected in a sandbox may reference a package-escaping relative
//      path.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { globSync } from 'glob';

import { PACKAGES } from '../lib/mutation-scope.mjs';

// Anchored to this file, not the cwd: resolving package paths relatively would
// make the scan below find zero files — and pass — when run from anywhere else.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const REPO_ASSET_IGNORE = '\\.repo-asset\\.test\\.ts$';

/** Test-file suffixes that are deliberately not collected inside the sandbox. */
const SANDBOX_EXEMPT = /\.(repo-asset|source-text)\.test\.ts$/;

/**
 * Strip comments so prose describing a path is not mistaken for code reaching
 * for one. The rule this file enforces is about what a test EXECUTES, and every
 * fix for a violation naturally leaves an explanatory comment quoting the old
 * path — which would otherwise re-trip the guard it just satisfied.
 *
 * @param {string} text - TypeScript source.
 * @returns {string} the source with block and line comments blanked.
 */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Relative path literals a test file embeds, resolved against that file.
 *
 * Only `./` and `../` specifiers are considered: an absolute literal such as
 * `'/project/../etc/passwd'` is path-traversal *test data*, not a filesystem
 * reach, and resolving it against the file would be meaningless.
 *
 * @param {string} file - repo-relative test file path.
 * @param {string} pkgDir - repo-relative package directory the file belongs to.
 * @returns {Array<{specifier: string, escapes: string | null}>} each literal with
 *   its package-escaping target, or null when it stays inside the package.
 */
function relativePathLiterals(file, pkgDir) {
  const text = withoutComments(readFileSync(file, 'utf8'));
  const found = [];
  for (const match of text.matchAll(/["'`](\.\.?\/[^"'`\n]*)["'`]/g)) {
    const specifier = match[1];
    const target = relative(resolve(pkgDir), resolve(dirname(file), specifier));
    found.push({ specifier, escapes: target.startsWith(`..${sep}`) ? target : null });
  }
  return found;
}

for (const pkg of PACKAGES) {
  test(`${pkg.package}: the Stryker sandbox config ignores ${REPO_ASSET_IGNORE}`, async () => {
    const module = await import(
      pathToFileURL(resolve(repoRoot, pkg.dir, 'jest.config.shared.js')).href
    );
    const sandboxed = module.makeConfig({ sandboxed: true });
    const normal = module.makeConfig({ sandboxed: false });

    assert.ok(
      sandboxed.testPathIgnorePatterns.includes(REPO_ASSET_IGNORE),
      `${pkg.dir} must not collect *.repo-asset.test.ts inside the sandbox`,
    );
    assert.ok(
      !normal.testPathIgnorePatterns.includes(REPO_ASSET_IGNORE),
      `${pkg.dir} must still run *.repo-asset.test.ts under the normal Jest config`,
    );
  });
}

// REGRESSION (P1): `packages/core/__tests__/runbook/session-service.process.test.ts`
// resolved tsx through `../../../../node_modules`, which lands on
// `packages/core/node_modules/tsx` in the sandbox. tsx is a ROOT-only
// devDependency, so pnpm never links it there — in CI either. Every core
// mutation run aborted its dry run, tested zero mutants, and reported success.
test('no sandbox-collected test reaches outside its package', () => {
  const offenders = [];
  let scanned = 0;
  for (const pkg of PACKAGES) {
    const pkgDir = resolve(repoRoot, pkg.dir);
    for (const file of globSync(`${pkgDir}/__tests__/**/*.ts`)) {
      if (SANDBOX_EXEMPT.test(file)) continue;
      scanned += 1;
      for (const { specifier, escapes } of relativePathLiterals(file, pkgDir)) {
        if (escapes) {
          offenders.push(`${relative(repoRoot, file)}: '${specifier}' resolves to ${escapes}`);
        }
      }
    }
  }
  // A guard that scans nothing passes for the wrong reason, which is the same
  // shape of silent success this whole file exists to prevent.
  assert.ok(scanned > 100, `expected to scan the packages' test suites, saw ${scanned} files`);
  assert.deepEqual(
    offenders,
    [],
    'Resolve the asset without a traversal (e.g. createRequire(...).resolve for a ' +
      'dependency), or name the file *.repo-asset.test.ts so the sandbox skips it.\n' +
      offenders.join('\n'),
  );
});
