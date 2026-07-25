// Single source of truth for this package's Jest config, in both the normal and
// the Stryker-sandbox modes. `makeConfig({ sandboxed })` derives the only things
// that legitimately differ between the two, so the two entry configs
// (jest.config.js, jest.stryker.config.js) can no longer drift.
//
// This file is intentionally SELF-CONTAINED — it does NOT import the root
// `../../jest.config.base.js`. Stryker copies only this package directory into
// `.stryker-tmp/sandbox-*`, so any root-relative import escapes the sandbox and
// fails to resolve. Keeping the factory in the package dir means
// `./jest.config.shared.js` resolves both normally and inside the sandbox.
//
// Two derivations cover every legitimate difference:
//   - `up`: sibling packages sit one dir up normally (`../`) but two dirs deeper
//     in the sandbox (`../../../`), so module-name-mapper paths use `${up}`.
//   - the `/\.stryker-tmp/` ignore is dropped in the sandbox: inside the sandbox
//     every test path contains that segment, so keeping the ignore would skip
//     every test and report all mutants as survived.

/**
 * Build the core package's Jest config.
 *
 * @param {{ sandboxed: boolean }} options - `sandboxed` is true when running
 *   inside Stryker's `.stryker-tmp` sandbox copy of this package.
 * @returns {import('jest').Config} The resolved Jest config for the given mode.
 */
export function makeConfig({ sandboxed }) {
  const up = sandboxed ? '../../../' : '../';
  const strykerTmpIgnore = sandboxed ? [] : ['/\\.stryker-tmp/'];

  // Source-text meta-tests read a `src/**` file as a STRING and assert on literal
  // substrings. Inside the Stryker sandbox every `mutate`-matched source file is
  // instrumented (each literal rewritten into a `stryMutAct_*` mutation switch),
  // so those substrings can never match and the initial dry run fails before any
  // mutant is tested. Name any test that asserts on `src/**` source text
  // `*.source-text.test.ts`; such tests are skipped in the Stryker sandbox
  // (instrumentation rewrites the literals they assert on) but still run under the
  // normal Jest config. They assert on source text, not behaviour, and contribute
  // nothing to mutation coverage.
  //
  // Repo-asset meta-tests read a file that lives OUTSIDE this package — a
  // repo-root doc, a `scripts/**` build script, `native/**/Cargo.lock` — via a
  // `../../../../` traversal off `import.meta.url`. Stryker copies only this
  // package directory into `.stryker-tmp/sandbox-*`, which adds two path
  // segments, so that traversal lands on `packages/core/<path>` and the asset is
  // gone. The failure is not a skipped assertion but a HARD dry-run abort
  // (`Something went wrong in the initial test run`), which kills the whole
  // mutation run before a single mutant is tested — and it fires whenever the
  // mutated scope's related-test set reaches such a test, e.g. any scope
  // touching the widely-imported `src/paths.ts` or `src/runbook/types.ts`. Name
  // any test that reads an out-of-package asset `*.repo-asset.test.ts`; it is
  // ignored in the sandbox and still runs under the normal Jest config.
  //
  // Ignoring by path (rather than an in-test `existsSync` skip) also keeps the
  // cost at zero: these files are never collected, so they are not re-loaded and
  // re-transformed on every one of the thousands of per-mutant Jest runs.
  const sandboxMetaTestIgnore = sandboxed
    ? ['\\.source-text\\.test\\.ts$', '\\.repo-asset\\.test\\.ts$']
    : [];

  return {
    testPathIgnorePatterns: [
      '/node_modules/',
      '<rootDir>/../../.worktrees/',
      ...strykerTmpIgnore,
      ...sandboxMetaTestIgnore,
    ],
    modulePathIgnorePatterns: ['<rootDir>/../../.worktrees/', ...strykerTmpIgnore],
    watchPathIgnorePatterns: ['<rootDir>/../../.worktrees/', ...strykerTmpIgnore],
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/__tests__'],
    testMatch: ['**/*.test.ts'],
    collectCoverageFrom: ['src/**/*.ts', '!src/testing/**'],
    coverageThreshold: {
      global: {
        branches: 80,
        functions: 90,
        lines: 89,
        statements: 89,
      },
    },
    coverageReporters: ['text', 'lcov', 'html'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    extensionsToTreatAsEsm: ['.ts'],
    moduleNameMapper: {
      '^(\\.{1,2}/.*)\\.js$': '$1',
      '^@rundown-org/parser$': `<rootDir>/${up}parser/src/index.ts`,
    },
    transform: {
      '^.+\\.tsx?$': [
        'ts-jest',
        {
          useESM: true,
          tsconfig: 'tsconfig.test.json',
        },
      ],
    },
  };
}
