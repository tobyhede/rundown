/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const concurrency = parsePositiveInteger(process.env.STRYKER_CONCURRENCY, 2);

/**
 * Parse a boolean-ish env value. Only 'true'/'1' enable the flag; unset or any
 * other value is the fallback. Keeps local `stryker run` conservative.
 *
 * @param {string | undefined} value - the raw env value.
 * @param {boolean} fallback - value when unset/unrecognized.
 * @returns {boolean}
 */
const parseBoolean = (value, fallback) => {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return fallback;
};

// ignoreStatic is OFF by default so the exhaustive producer run (mutation.yml)
// scores static mutants at full fidelity. The advisory per-PR gate sets
// STRYKER_IGNORE_STATIC=true to reclaim the static-mutant time on a run whose
// false negatives are acceptable (it never blocks merge). See issue #485.
const ignoreStatic = parseBoolean(process.env.STRYKER_IGNORE_STATIC, false);

// The dashboard reporter UPLOADS the report and requires an API key, so enable
// it only when one is present. The producer workflow (mutation.yml) sets the
// key; the advisory PR workflow does not (it only downloads the public
// baseline), so PR runs never upload partial, changed-file-scoped reports that
// would corrupt the dashboard baseline. See issue #485.
const reporters = ['progress', 'clear-text', 'html', 'json'];
if (process.env.STRYKER_DASHBOARD_API_KEY) reporters.push('dashboard');

const config = {
  packageManager: 'pnpm',
  // Explicit plugin list: pnpm's isolated layout breaks Stryker's default
  // '@stryker-mutator/*' auto-discovery glob (which resolves relative to
  // stryker-core's own node_modules, where jest-runner is not a sibling).
  // Naming the plugin makes Stryker resolve it from this package's node_modules.
  plugins: ['@stryker-mutator/jest-runner'],
  testRunner: 'jest',
  jest: { configFile: 'jest.config.js' },
  testRunnerNodeArgs: ['--experimental-vm-modules'],
  checkers: [],
  mutate: ['src/**/*.ts', '!src/**/*.d.ts', '!src/index.ts'],
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
  reporters,
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation-report.json' },
  dashboard: {
    project: 'github.com/tobyhede/rundown',
    module: 'parser',
    // version is auto-detected from the CI environment (branch/ref) when unset;
    // the producer workflow may pin it via STRYKER_DASHBOARD_VERSION.
    version: process.env.STRYKER_DASHBOARD_VERSION || undefined,
    reportType: 'full',
  },
  concurrency,
  ignoreStatic,
  timeoutMS: 30000,
  timeoutFactor: 2.5,
};
export default config;
