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
  // that override. The ~55x that commit measured is the cost of a self-inflicted
  // non-default being undone — not a tuning win, and not a lever available to
  // anyone else.
  //
  // What the option does: it scopes each mutant run to only the test files that
  // *transitively import* the mutated source (jest's inverse module graph),
  // instead of reloading the entire suite for every mutant. Under the `false`
  // override each mutant ran all 302 test files / 3682 tests (filtered only by
  // test-name pattern), which measured ~1.3 mutants/min and OOM'd the in-band
  // runner; at the default the same policy/** scope measured ~72 mutants/min,
  // with the per-run heap small enough that the residual leak stays recoverable.
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
  // backoff bounded to 5s, fromPromise actors that touch the filesystem), so this
  // budget is 12x Stryker's 5000ms default. It is load-bearing, and the direction
  // of the risk is the OPPOSITE of what this comment used to claim.
  //
  // Timeout is a DETECTED state, not an undetected one: the score is
  // `detected / valid` where detected = `killed + timeout` (see the official
  // mutant-states doc, and `DETECTED` in scripts/mutation-merge-reports.mjs and
  // the formula in scripts/assert-mutation-score.mjs). So a spurious timeout does
  // not depress the score — it INFLATES it, by crediting a kill that no test
  // performed. Tightening this budget to buy runtime silently manufactures those
  // false kills.
  //
  // Measured, mutating src/paths.ts against its own unit test: at 60000ms the
  // report is 11 Killed / 15 Timeout / 2 Survived / 5 NoCoverage = 78.79% in
  // 399s. At 8000ms the same scope yields 0 Killed / 31 Timeout / 0 Survived /
  // 5 NoCoverage = 86.11% in 85s — every
  // mutant run simply exceeded the budget, both genuine survivors vanished, and
  // the "4.7x speedup" is a report that measured nothing. Do not tune this for
  // speed; reduce the mutant count instead (changed-line ranges) or the tests per
  // mutant (`testFiles`). See issue #483.
  timeoutMS: 60000,
  timeoutFactor: 3,
};
export default config;
