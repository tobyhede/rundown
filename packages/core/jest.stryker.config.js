// Stryker-specific Jest config. Stryker copies only this package into its
// `.stryker-tmp/sandbox-*` directory, so the regular `jest.config.js` cannot be
// reused verbatim:
//   1. It does `import base from '../../jest.config.base.js'` — that relative
//      path escapes the (two-levels-deeper) sandbox and fails to resolve.
//   2. The shared base config ignores `/\.stryker-tmp/`; inside the sandbox
//      every test path contains that segment, so reusing it would skip every
//      test and report all mutants as survived.
//   3. The `@rundown-org/parser` source lives a sibling package away; from the
//      deeper sandbox path it must be reached via three `../` segments.
// This self-contained config mirrors `jest.config.js` with those three
// adjustments. See packages/cli/jest.stryker.config.js for the original of this
// pattern and docs/CI-SETUP.md for the rationale.
export default {
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/../../.worktrees/'],
  modulePathIgnorePatterns: ['<rootDir>/../../.worktrees/'],
  watchPathIgnorePatterns: ['<rootDir>/../../.worktrees/'],
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
    '^@rundown-org/parser$': '<rootDir>/../../../parser/src/index.ts',
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
