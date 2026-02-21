/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  packageManager: 'npm',
  testRunner: 'jest',
  jest: { configFile: 'jest.config.js' },
  testRunnerNodeArgs: ['--experimental-vm-modules'],
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  mutate: ['src/**/*.ts', '!src/**/*.d.ts', '!src/index.ts', '!src/types.ts', '!src/schemas.ts'],
  coverageAnalysis: 'perTest',
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  thresholds: { high: 80, low: 60, break: null },
  reporters: ['clear-text', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation-report.json' },
  timeoutMS: 30000,
  timeoutFactor: 2.5,
};
export default config;
