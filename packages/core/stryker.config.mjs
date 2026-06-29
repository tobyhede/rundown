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
// that floored throughput to ~0 and is why a cold core campaign never finished.
// Recycling caps the leak by construction: `recover()` disposes and respawns
// the child (re-running only its cheap config load, NOT the dry run). This is
// the supported lever for "a memory leak you cannot resolve" per the Stryker
// schema. See issue #485.
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
  // enableFindRelatedTests scopes each mutant run to only the test files that
  // *transitively import* the mutated source (jest's inverse module graph),
  // instead of reloading the entire suite for every mutant. With it `false`,
  // each mutant ran all 302 test files / 3682 tests (filtered only by test-name
  // pattern), which measured ~1.3 mutants/min and OOM'd the in-band runner; with
  // it `true` the same policy/** scope measured ~72 mutants/min (~55x) with the
  // per-run heap small enough that the residual leak stays recoverable. This is
  // the single change that lets a full core/cli campaign finish.
  //
  // Tradeoff: a mutant whose ONLY killing test reaches the code with no static
  // import path — a subprocess that spawns the CLI, a dynamic `import()`, or a
  // test that reads source as a string — is no longer exercised and reports as a
  // false survivor. The inverse graph is transitive, so ordinary integration
  // tests (e.g. a runbook test importing executor.ts -> policy/evaluator.ts)
  // still count; only runtime-only coverage is lost. That residue is acceptable
  // because the alternative (`false`) does not complete at all. See issue #485.
  jest: { configFile: 'jest.stryker.config.js', enableFindRelatedTests: true },
  testRunnerNodeArgs: ['--experimental-vm-modules'],
  checkers: [],
  // Mutation is scoped to the correctness-critical heart of core — the state
  // machine and everything it drives (runbook/**, policy/**, sandbox/**,
  // events/**). The exclusions below drop presentation and declarative layers
  // where mutation testing spends a large fraction of the mutant budget for
  // almost no signal: their mutants are overwhelmingly equivalent or trivial.
  // Trimming them focuses the full-fidelity run on logic that can actually
  // harbour a costly bug. See issue #485.
  mutate: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/types.ts',
    '!src/schemas.ts',
    // JSON-output format contract: 62 KB of declarative Zod schemas plus the
    // z.infer<> type re-exports and trivial type guards built on them. This is
    // the machine-readable output *spec*, not runbook logic — mutating it yields
    // equivalent/noise mutants, and the giant zod-schemas.ts alone dominates the
    // count.
    '!src/output/**',
    // Terminal rendering: ANSI color codes, output writers, and the
    // intentionally branch-free "format-only" display models. Presentation is a
    // Category A (CLI) concern with low correctness stakes; string-literal
    // mutations here are pure noise.
    '!src/cli/**',
    // Logging plumbing — no runbook behaviour.
    '!src/logger.ts',
  ],
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
    module: 'core',
    // version is auto-detected from the CI environment (branch/ref) when unset;
    // the producer workflow may pin it via STRYKER_DASHBOARD_VERSION.
    version: process.env.STRYKER_DASHBOARD_VERSION || undefined,
    reportType: 'full',
  },
  concurrency,
  maxTestRunnerReuse,
  ignoreStatic,
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
