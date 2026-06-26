/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const concurrency = parsePositiveInteger(process.env.STRYKER_CONCURRENCY, 2);

const config = {
  packageManager: 'pnpm',
  // Explicit plugin list: pnpm's isolated layout breaks Stryker's default
  // '@stryker-mutator/*' auto-discovery glob (which resolves relative to
  // stryker-core's own node_modules, where jest-runner is not a sibling).
  // Naming the plugin makes Stryker resolve it from this package's node_modules.
  plugins: ['@stryker-mutator/jest-runner'],
  testRunner: 'jest',
  jest: { configFile: 'jest.stryker.config.js', enableFindRelatedTests: false },
  testRunnerNodeArgs: ['--experimental-vm-modules'],
  checkers: [],
  mutate: ['src/**/*.ts', '!src/**/*.d.ts', '!src/index.ts', '!src/types.ts', '!src/schemas.ts'],
  coverageAnalysis: 'perTest',
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  // break: 70 is a catastrophic-drop floor, not a quality target. Current
  // package scores sit well above it; it exists so a weekly run fails loudly
  // instead of silently uploading a red report. The per-PR changed-file gate
  // (scripts/assert-mutation-score.mjs) is the real merge guard. See issue #483.
  thresholds: { high: 80, low: 60, break: 70 },
  reporters: ['progress', 'clear-text', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation-report.json' },
  concurrency,
  // Core hosts the heaviest actors (XState machine, file locks with jittered
  // backoff bounded to 5s, fromPromise actors that touch the filesystem). The
  // previous 30000ms / 2.5x budget produced ~17 spurious Timeout results that
  // mutation-testing-metrics counts as undetected mutants, depressing the score
  // below its true value. A Timeout-as-survivor is a false negative that makes
  // the gate fire on flake rather than on a real coverage regression, so the
  // budget is widened to the CLI's 60000ms baseline with a 3x factor (vs 2.5x)
  // to absorb the slowest-but-legitimate actor runs under CI contention. See
  // issue #483.
  timeoutMS: 60000,
  timeoutFactor: 3,
};
export default config;
