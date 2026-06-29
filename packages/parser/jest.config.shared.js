// Single source of truth for this package's Jest config, in both the normal and
// the Stryker-sandbox modes. `makeConfig({ sandboxed })` derives the only thing
// that legitimately differs between the two, so the two entry configs
// (jest.config.js, jest.stryker.config.js) can no longer drift.
//
// This file is intentionally SELF-CONTAINED — it does NOT import the root
// `../../jest.config.base.js`. Stryker copies only this package directory into
// `.stryker-tmp/sandbox-*`, so any root-relative import escapes the sandbox and
// fails to resolve with ERR_MODULE_NOT_FOUND, aborting the whole mutation run
// (the producer's silent failure mode before issue #485). Keeping the factory in
// the package dir means `./jest.config.shared.js` resolves both normally and
// inside the sandbox.

/**
 * Build the parser package's Jest config.
 *
 * @param {{ sandboxed: boolean }} options - `sandboxed` is true when running
 *   inside Stryker's `.stryker-tmp` sandbox copy of this package.
 * @returns {import('jest').Config} The resolved Jest config for the given mode.
 */
export function makeConfig({ sandboxed }) {
  // Inside the sandbox every test path contains `.stryker-tmp`, so keeping that
  // ignore would skip every test and report all mutants as survived. Drop it in
  // the sandbox; keep it normally (where it hides Stryker's own copies).
  const strykerTmpIgnore = sandboxed ? [] : ['/\\.stryker-tmp/'];

  return {
    testPathIgnorePatterns: ['/node_modules/', '<rootDir>/../../.worktrees/', ...strykerTmpIgnore],
    modulePathIgnorePatterns: ['<rootDir>/../../.worktrees/', ...strykerTmpIgnore],
    watchPathIgnorePatterns: ['<rootDir>/../../.worktrees/', ...strykerTmpIgnore],
    testEnvironment: 'node',
    roots: ['<rootDir>/__tests__'],
    testMatch: ['**/*.test.ts'],
    collectCoverageFrom: ['src/**/*.ts'],
    coverageThreshold: {
      global: {
        branches: 80,
        functions: 90,
        lines: 85,
        statements: 85,
      },
    },
    coverageReporters: ['text', 'lcov', 'html'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    extensionsToTreatAsEsm: ['.ts'],
    moduleNameMapper: {
      '^(\\.{1,2}/.*)\\.js$': '$1',
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
