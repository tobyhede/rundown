/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const concurrency = parsePositiveInteger(process.env.STRYKER_CONCURRENCY, 2);

const config = {
  packageManager: 'npm',
  testRunner: 'jest',
  jest: { configFile: 'jest.config.js' },
  testRunnerNodeArgs: ['--experimental-vm-modules'],
  checkers: [],
  mutate: ['src/**/*.ts', '!src/**/*.d.ts', '!src/index.ts'],
  coverageAnalysis: 'perTest',
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  thresholds: { high: 80, low: 60, break: null },
  reporters: ['progress', 'clear-text', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation-report.json' },
  concurrency,
  timeoutMS: 30000,
  timeoutFactor: 2.5,
};
export default config;
