/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const concurrency = parsePositiveInteger(process.env.STRYKER_CONCURRENCY, 2);

// Recycle each test-runner child process after this many mutant runs. The
// @stryker-mutator/jest-runner executes Jest in-band (`runInBand: true`) inside
// one long-lived child process, and repeated in-band `jest.runCLI` leaks a few
// MB of heap per run (module registry + ts-jest + instrumenter context that
// jest never fully releases between in-band runs). Left unbounded the child
// OOMs mid-campaign; Stryker's RetryRejectedDecorator then restarts it and
// retries the same mutant, which re-leaks to the same wall — a death spiral
// that floored throughput to ~0. Recycling caps the leak by construction:
// `recover()` disposes and respawns the child (re-running only its cheap config
// load, NOT the dry run). This is the supported lever for "a memory leak you
// cannot resolve" per the Stryker schema. See issue #485.
const maxTestRunnerReuse = parsePositiveInteger(process.env.STRYKER_MAX_TEST_RUNNER_REUSE, 25);

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
const scoped = parseBoolean(process.env.STRYKER_SCOPED, false);

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
  // `true` is the @stryker-mutator/jest-runner 9.6.1 DEFAULT
  // (dist/schema/jest-runner-options.json declares `"default": true`), stated
  // explicitly here so it cannot be re-broken silently. Read the history
  // accordingly: this config had OVERRIDDEN it to `false`, and e0bef7949 removed
  // that override — recovering from a self-inflicted non-default, not tuning.
  //
  // What the option does: it scopes each mutant run to only the test files that
  // *transitively import* the mutated source (jest's inverse module graph),
  // instead of reloading the entire suite for every mutant. Under the `false`
  // override each mutant reloaded the whole CLI test suite (filtered only by
  // test-name pattern), which OOM'd the in-band runner and floored throughput.
  //
  // Tradeoff: a mutant whose ONLY killing test reaches the code with no static
  // import path — a subprocess that spawns the CLI, a dynamic `import()`, or a
  // test that reads source as a string — is no longer exercised and reports as a
  // false survivor. The inverse graph is transitive, so ordinary integration
  // tests still count; only runtime-only coverage is lost. That residue is
  // acceptable because the alternative (`false`) does not complete. See #485.
  jest: { configFile: 'jest.stryker.config.js', enableFindRelatedTests: true },
  testRunnerNodeArgs: ['--experimental-vm-modules'],
  checkers: [],
  // The CLI is a thin wrapper, so its mutation value is fairly uniform across
  // the orchestration helpers/services — there is no large low-value core to
  // carve out the way there is in `core`. The only clear noise is presentation
  // and codegen, excluded below; the real lever for keeping CLI runs bounded is
  // the changed-file (`--mutate`) scoping the workflows apply. See issue #485.
  mutate: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/cli.ts',
    '!src/schemas/**',
    // Doc codegen (`gen-cli-help.ts`): not shipped runtime logic and untested,
    // so every mutant would survive as pure noise.
    '!src/scripts/**',
    // JSON/text output renderers — presentation, low correctness stakes.
    '!src/services/renderers/**',
  ],
  // The @stryker-mutator/api 9.6.1 DEFAULT, stated explicitly: its
  // dist/schema/stryker-core.json declares `"default": "perTest"` for this
  // option and Stryker's OptionsValidator compiles that schema with ajv
  // `useDefaults: true`. Setting it is a harmless no-op — do not read it as a
  // tuning decision. (The schema's own prose still reads "'off' (default)"; the
  // machine-readable `default` is what Stryker actually applies.)
  coverageAnalysis: 'perTest',
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  // A catastrophic-drop floor, not a quality target — and 60, not the 70 it used
  // to be. 70 sat ABOVE every score a module has ever achieved on a campaign that
  // completed (plugin 66.17%, cli 64.51%), so a flawless full run exited 1 by
  // construction: a gate that can only fire is not a gate. 60 is below every
  // measurement that exists. `core` and `parser` have never completed a campaign
  // at all, so re-derive this from the first baseline the producer publishes
  // rather than from an aspiration. See issues #483 and #670.
  //
  // A SCOPED run disables it outright, because a scoped run measures a FRACTION
  // of a module and a fraction's score is not the module's: the per-PR gate is
  // changed-file scoped, the producer's shards are line-range scoped
  // (.github/workflows/mutation.yml sets STRYKER_SCOPED for exactly this reason),
  // and `test:mutate:changed` is hunk scoped. The producer's aggregate floor
  // therefore lives on the MERGED report, in scripts/mutation-merge-reports.mjs,
  // which is the only place a complete module score exists. A single-file
  // regression that an aggregate absorbs is caught by the per-PR changed-file
  // gate (scripts/assert-mutation-score.mjs).
  thresholds: { high: 80, low: 60, break: scoped ? null : 60 },
  reporters,
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation-report.json' },
  dashboard: {
    project: 'github.com/tobyhede/rundown',
    module: 'cli',
    // version is auto-detected from the CI environment (branch/ref) when unset;
    // the producer workflow may pin it via STRYKER_DASHBOARD_VERSION.
    version: process.env.STRYKER_DASHBOARD_VERSION || undefined,
    reportType: 'full',
  },
  concurrency,
  maxTestRunnerReuse,
  ignoreStatic,
  timeoutMS: 60000,
  timeoutFactor: 2.5,
};
export default config;
