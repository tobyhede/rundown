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
  // break: 70 is a catastrophic-drop floor on the project-wide aggregate, not
  // a quality target. It applies to every `stryker run` (the weekly full run
  // and the per-PR run), failing loudly instead of silently uploading a red
  // report. The aggregate cannot catch a single-file regression it absorbs --
  // the per-PR changed-file gate (scripts/assert-mutation-score.mjs) is that
  // guard. See issue #483.
  thresholds: { high: 80, low: 60, break: 70 },
  reporters: ['progress', 'clear-text', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation-report.json' },
  concurrency,
  // Skip static mutants (those evaluated once at load time, not per-test) so
  // Stryker reports them Ignored instead of running them. The per-PR gate timed
  // out at 30m on ~2157 instrumented mutants for core (run 28277202919), where
  // Stryker reported "10 static mutants (0% of total) estimated to take 49% of
  // the time running the tests" -- dropping them reclaims that ~half. Trade-off:
  // static mutants become Ignored (not scored), a small fidelity loss that also
  // affects the weekly exhaustive mutation.yml; acceptable for a time-bounded
  // gate. See issue #485.
  ignoreStatic: true,
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
