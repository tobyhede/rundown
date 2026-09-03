// Single source of truth for this package's Jest config, in both the normal and
// the Stryker-sandbox modes. `makeConfig({ sandboxed })` derives the only things
// that legitimately differ between the two, so the two entry configs
// (jest.config.js, jest.stryker.config.js) can no longer drift.
//
// This file is intentionally SELF-CONTAINED — it does NOT import the root
// `../../jest.config.base.js`. Stryker copies only this package directory into
// `.stryker-tmp/sandbox-*`, so any root-relative import escapes the sandbox and
// fails to resolve with ERR_MODULE_NOT_FOUND, aborting the whole mutation run
// (the producer's silent failure mode before issue #485). Keeping the factory in
// the package dir means `./jest.config.shared.js` resolves both normally and
// inside the sandbox.
//
// Two derivations cover every legitimate difference:
//   - `up`: sibling packages sit one dir up normally (`../`) but two dirs deeper
//     in the sandbox (`../../../`), so the cross-package module-name-mapper paths
//     use `${up}`.
//   - the `/\.stryker-tmp/` ignore is dropped in the sandbox: inside the sandbox
//     every test path contains that segment, so keeping the ignore would skip
//     every test and report all mutants as survived.

/**
 * Build the plugin package's Jest config.
 *
 * @param {{ sandboxed: boolean }} options - `sandboxed` is true when running
 *   inside Stryker's `.stryker-tmp` sandbox copy of this package.
 * @returns {import('jest').Config} The resolved Jest config for the given mode.
 */
export function makeConfig({ sandboxed }) {
  const up = sandboxed ? '../../../' : '../';
  const strykerTmpIgnore = sandboxed ? [] : ['/\\.stryker-tmp/'];

  // Repo-asset meta-tests read a file that lives OUTSIDE this package via a
  // relative traversal off `import.meta.url`. The sandbox copy adds two path
  // segments, so that traversal lands on `packages/claude-code-plugin/<path>` and
  // the asset is gone. The failure is a HARD dry-run abort that kills the
  // campaign before a single mutant is tested, not a skipped assertion. Name any
  // such test `*.repo-asset.test.ts`; it is ignored in the sandbox and still runs
  // under the normal Jest config. See
  // scripts/__tests__/mutation-sandbox-assets.test.mjs.
  //
  // Source-text meta-tests read a `src/**` file as a STRING and assert on literal
  // substrings, which instrumentation rewrites into `stryMutAct_*` switches — the
  // same hard abort by a different route. Name any such test
  // `*.source-text.test.ts`. This package has none today; the hatch is registered
  // anyway so the first one added does not have to discover the abort in CI.
  const sandboxMetaTestIgnore = sandboxed
    ? ['\\.source-text\\.test\\.ts$', '\\.repo-asset\\.test\\.ts$']
    : [];

  return {
    // Worker pool size, overridable by environment. 2 is the value this
    // package's `test:*` scripts used to pass as `--maxWorkers=2`; it lives
    // here now so `JEST_MAX_WORKERS=1` bounds every Jest run in the tree. A CLI
    // `--maxWorkers` flag still beats config, which is why those flags were
    // removed from the scripts. Restated rather than imported: this file is
    // deliberately self-contained so it resolves inside the Stryker sandbox.
    maxWorkers: Math.max(1, Number(process.env.JEST_MAX_WORKERS) || 2),
    testPathIgnorePatterns: [
      '/node_modules/',
      '<rootDir>/../../.worktrees/',
      ...strykerTmpIgnore,
      ...sandboxMetaTestIgnore,
    ],
    modulePathIgnorePatterns: ['<rootDir>/../../.worktrees/', ...strykerTmpIgnore],
    watchPathIgnorePatterns: ['<rootDir>/../../.worktrees/', ...strykerTmpIgnore],
    testEnvironment: 'node',
    testTimeout: 10000,
    roots: ['<rootDir>/__tests__'],
    testMatch: ['**/*.test.ts'],
    collectCoverageFrom: ['src/**/*.ts'],
    coverageReporters: ['text', 'lcov', 'html'],
    coverageThreshold: {
      global: {
        branches: 75,
        functions: 90,
        lines: 85,
        statements: 85,
      },
      './src/dispatcher.ts': {
        branches: 80,
        functions: 90,
        lines: 85,
      },
    },
    setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    extensionsToTreatAsEsm: ['.ts'],
    moduleNameMapper: {
      '^(\\.{1,2}/.*)\\.js$': '$1',
      '^@rundown-org/core$': `<rootDir>/${up}core/src/index.ts`,
      '^@rundown-org/parser$': `<rootDir>/${up}parser/src/index.ts`,
    },
    transform: {
      '^.+\\.tsx?$': [
        'ts-jest',
        {
          useESM: true,
          tsconfig: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            target: 'ES2022',
            lib: ['ES2022'],
            strict: true,
            esModuleInterop: true,
            allowSyntheticDefaultImports: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
            resolveJsonModule: true,
            isolatedModules: true,
          },
        },
      ],
    },
  };
}
