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
// Derivations cover every legitimate difference:
//   - `up`: sibling packages sit one dir up normally (`../`) but two dirs deeper
//     in the sandbox (`../../../`), so module-name-mapper paths use `${up}`.
//   - the `/\.stryker-tmp/` ignore is dropped in the sandbox: inside the sandbox
//     every test path contains that segment, so keeping the ignore would skip
//     every test and report all mutants as survived.
//   - `testEnvironment`: the live-cwd custom environment is used normally; the
//     sandbox uses plain 'node'.
//   - the sandbox additionally excludes integration tests and the
//     forced-terminal-boundary test from discovery.

/**
 * Build the cli package's Jest config.
 *
 * @param {{ sandboxed: boolean }} options - `sandboxed` is true when running
 *   inside Stryker's `.stryker-tmp` sandbox copy of this package.
 * @returns {import('jest').Config} The resolved Jest config for the given mode.
 */
export function makeConfig({ sandboxed }) {
  const up = sandboxed ? '../../../' : '../';

  return {
    testPathIgnorePatterns: sandboxed
      ? [
          '/node_modules/',
          '<rootDir>/../../.worktrees/',
          'integration',
          'forced-terminal-boundary\\.test\\.ts$',
        ]
      : ['/node_modules/', '<rootDir>/../../.worktrees/', '/\\.stryker-tmp/'],
    modulePathIgnorePatterns: sandboxed
      ? ['<rootDir>/../../.worktrees/']
      : ['<rootDir>/../../.worktrees/', '/\\.stryker-tmp/'],
    watchPathIgnorePatterns: sandboxed
      ? ['<rootDir>/../../.worktrees/']
      : ['<rootDir>/../../.worktrees/', '/\\.stryker-tmp/'],
    // Custom environment keeps process.cwd() live after process.chdir() under
    // pnpm's layout; see jest.live-cwd-environment.cjs for the full rationale.
    testEnvironment: sandboxed ? 'node' : '<rootDir>/jest.live-cwd-environment.cjs',
    roots: ['<rootDir>/__tests__'],
    testMatch: ['**/*.test.ts'],
    collectCoverageFrom: ['src/**/*.ts'],
    coverageThreshold: {
      global: {
        branches: 65,
        functions: 90,
        lines: 80,
        statements: 80,
      },
      './src/helpers/': {
        branches: 60,
        functions: 80,
        lines: 75,
        statements: 75,
      },
      './src/services/': {
        branches: 60,
        functions: 80,
        lines: 75,
        statements: 75,
      },
    },
    coverageReporters: ['text', 'lcov', 'html'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    extensionsToTreatAsEsm: ['.ts'],
    setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
    moduleNameMapper: {
      '^(\\.{1,2}/.*)\\.js$': '$1',
      '^@rundown-org/core$': `<rootDir>/${up}core/src/index.ts`,
      '^@rundown-org/core/testing/effective-vars$': `<rootDir>/${up}core/src/testing/effective-vars.ts`,
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
            verbatimModuleSyntax: true,
          },
        },
      ],
    },
  };
}
