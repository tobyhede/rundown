/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Parse a positive (possibly fractional) number from an env value. Unlike
 * parsePositiveInteger this accepts floats, which timeoutFactor needs (e.g. a
 * local `STRYKER_TIMEOUT_FACTOR=1.5`); unset/non-positive falls back.
 *
 * @param {string | undefined} value - the raw env value.
 * @param {number} fallback - value when unset/non-positive.
 * @returns {number}
 */
const parsePositiveNumber = (value, fallback) => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
const maxTestRunnerReuse = parsePositiveInteger(
  process.env.STRYKER_MAX_TEST_RUNNER_REUSE,
  25,
);

/**
 * Parse a boolean-ish env value. Only 'true'/'1' enable the flag; unset or any
 * other value is the fallback. Keeps local `stryker run` conservative.
 *
 * @param {string | undefined} value - the raw env value.
 * @param {boolean} fallback - value when unset/unrecognized.
 * @returns {boolean}
 */
const parseBoolean = (value, fallback) => {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return fallback;
};

// ignoreStatic is OFF by default so the exhaustive producer run (mutation.yml)
// scores static mutants at full fidelity. The advisory per-PR gate sets
// STRYKER_IGNORE_STATIC=true to reclaim the static-mutant time on a run whose
// false negatives are acceptable (it never blocks merge). See issue #485.
const ignoreStatic = parseBoolean(process.env.STRYKER_IGNORE_STATIC, false);

// Per-mutant timeout budget = netTime * timeoutFactor + timeoutMS + overhead.
// Defaults are the committed CI budget; STRYKER_TIMEOUT_MS / STRYKER_TIMEOUT_FACTOR
// let a local scoped run cheapen it so genuine infinite-loop mutants are still
// *detected* via Timeout but cost seconds instead of a full minute. CI leaves
// both unset, so the budget is unchanged.
const timeoutMS = parsePositiveInteger(process.env.STRYKER_TIMEOUT_MS, 60000);
const timeoutFactor = parsePositiveNumber(
  process.env.STRYKER_TIMEOUT_FACTOR,
  2.5,
);

// The dashboard reporter UPLOADS the report and requires an API key, so enable
// it only when one is present. The producer workflow (mutation.yml) sets the
// key; the advisory PR workflow does not (it only downloads the public
// baseline), so PR runs never upload partial, changed-file-scoped reports that
// would corrupt the dashboard baseline. See issue #485.
const reporters = ["progress", "clear-text", "html", "json"];
if (process.env.STRYKER_DASHBOARD_API_KEY) reporters.push("dashboard");

const config = {
  packageManager: "pnpm",
  // Explicit plugin list: pnpm's isolated layout breaks Stryker's default
  // '@stryker-mutator/*' auto-discovery glob (which resolves relative to
  // stryker-core's own node_modules, where jest-runner is not a sibling).
  // Naming the plugin makes Stryker resolve it from this package's node_modules.
  plugins: ["@stryker-mutator/jest-runner"],
  testRunner: "jest",
  // enableFindRelatedTests scopes each mutant run to only the test files that
  // *transitively import* the mutated source (jest's inverse module graph),
  // instead of reloading the entire suite for every mutant. With it `false`,
  // each mutant reloaded the whole CLI test suite (filtered only by test-name
  // pattern), which OOM'd the in-band runner and floored throughput; with it
  // `true` the per-mutant cost and per-run heap drop enough for a full campaign
  // to finish. This is the single change that lets a full core/cli campaign
  // finish.
  //
  // Tradeoff: a mutant whose ONLY killing test reaches the code with no static
  // import path — a subprocess that spawns the CLI, a dynamic `import()`, or a
  // test that reads source as a string — is no longer exercised and reports as a
  // false survivor. The inverse graph is transitive, so ordinary integration
  // tests still count; only runtime-only coverage is lost. That residue is
  // acceptable because the alternative (`false`) does not complete. See #485.
  jest: { configFile: "jest.stryker.config.js", enableFindRelatedTests: true },
  testRunnerNodeArgs: ["--experimental-vm-modules"],
  checkers: [],
  // The CLI is a thin wrapper, so its mutation value is fairly uniform across
  // the orchestration helpers/services — there is no large low-value core to
  // carve out the way there is in `core`. The only clear noise is presentation
  // and codegen, excluded below; the real lever for keeping CLI runs bounded is
  // the changed-file (`--mutate`) scoping the workflows apply. See issue #485.
  mutate: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/index.ts",
    "!src/cli.ts",
    "!src/schemas/**",
    // Doc codegen (`gen-cli-help.ts`): not shipped runtime logic and untested,
    // so every mutant would survive as pure noise.
    "!src/scripts/**",
    // JSON/text output renderers — presentation, low correctness stakes.
    "!src/services/renderers/**",
  ],
  coverageAnalysis: "perTest",
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  // break: 70 is a catastrophic-drop floor on the project-wide aggregate, not
  // a quality target. It applies to every `stryker run` (the weekly full run
  // and the per-PR run), failing loudly instead of silently uploading a red
  // report. The aggregate cannot catch a single-file regression it absorbs --
  // the per-PR changed-file gate (scripts/assert-mutation-score.mjs) is that
  // guard. See issue #483.
  thresholds: { high: 80, low: 60, break: 70 },
  reporters,
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation-report.json" },
  dashboard: {
    project: "github.com/tobyhede/rundown",
    module: "cli",
    // version is auto-detected from the CI environment (branch/ref) when unset;
    // the producer workflow may pin it via STRYKER_DASHBOARD_VERSION.
    version: process.env.STRYKER_DASHBOARD_VERSION || undefined,
    reportType: "full",
  },
  concurrency,
  maxTestRunnerReuse,
  ignoreStatic,
  timeoutMS,
  timeoutFactor,
};
export default config;
