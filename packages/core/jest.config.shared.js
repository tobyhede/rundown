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

  return {
    testPathIgnorePatterns: ['/node_modules/', '<rootDir>/../../.worktrees/', ...strykerTmpIgnore],
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
