#!/usr/bin/env node
/**
 * Correct-by-construction scoped Stryker mutation run.
 *
 * Two traps make a hand-typed scoped `stryker run` waste an hour without
 * warning; this wrapper removes both:
 *
 * 1. **Repeated flags collapse to last-wins.** Stryker's CLI (Commander) does
 *    NOT accumulate repeated `--mutate` / `--testFiles` — the last one wins. So
 *    `--mutate a.ts --mutate b.ts` silently mutates only `b.ts`. This script
 *    takes exactly ONE mutate spec and ONE testFiles spec (comma lists and
 *    `file:startLine-endLine` ranges allowed inside each) and passes each as a
 *    single argv entry, so the collapse cannot happen. It then parses Stryker's
 *    own log and HARD-FAILS on a zero-file scope — the mis-scope guard the raw
 *    CLI lacks.
 * 2. **The committed CI timeout budget (60000ms / 3x) is expensive locally.**
 *    Under it each genuine infinite-loop mutant costs ~72s (`netTime * factor +
 *    timeoutMS`), amplified by the jest-runner in-band memory leak. This script
 *    sets fast-local defaults (`STRYKER_TIMEOUT_MS=8000`,
 *    `STRYKER_TIMEOUT_FACTOR=1.5`, `STRYKER_MAX_TEST_RUNNER_REUSE=10`) — but only
 *    when they are unset, so an explicit env override still wins. Timeouts stay
 *    legitimate *detections*, they just cost seconds; nothing about the mutators
 *    or the committed config defaults changes.
 *
 * Usage:
 *   node scripts/mutate-scoped.mjs <pkg> <mutateSpec> <testFilesSpec>
 *
 * Example (the case that originally stalled):
 *   node scripts/mutate-scoped.mjs core \
 *     src/runbook/session-service.ts \
 *     __tests__/runbook/session-service.test.ts
 *
 * <pkg> is one of: core | cli | parser | plugin. The two specs are
 * PACKAGE-RELATIVE paths (the run's cwd is the package dir), matching the
 * `pnpm --filter <pkg> exec stryker run` convention documented in CLAUDE.md.
 *
 * @see issue #483 (timeout budget), issue #485 (jest-runner leak / find-related-tests)
 */
import { spawn } from "node:child_process";

/** Map short package aliases to their workspace filter names. */
const PACKAGES = {
  core: "@rundown-org/core",
  cli: "@rundown-org/cli",
  parser: "@rundown-org/parser",
  plugin: "@rundown-org/claude-code-plugin",
};

/** Fast-local env defaults, applied only when the caller has not set them. */
const LOCAL_ENV_DEFAULTS = {
  STRYKER_TIMEOUT_MS: "8000",
  STRYKER_TIMEOUT_FACTOR: "1.5",
  STRYKER_MAX_TEST_RUNNER_REUSE: "10",
};

/**
 * Print usage and exit non-zero.
 *
 * @param {string} message - the reason usage is being shown.
 * @returns {never}
 */
function usage(message) {
  process.stderr.write(`mutate-scoped: ${message}\n\n`);
  process.stderr.write(
    "Usage: node scripts/mutate-scoped.mjs <pkg> <mutateSpec> <testFilesSpec>\n" +
      `  <pkg>          one of: ${Object.keys(PACKAGES).join(" | ")}\n` +
      "  <mutateSpec>   package-relative source path(s), comma-separated for many\n" +
      "  <testFilesSpec>  package-relative test path(s), comma-separated for many\n\n" +
      "Example:\n" +
      "  node scripts/mutate-scoped.mjs core \\\n" +
      "    src/runbook/session-service.ts \\\n" +
      "    __tests__/runbook/session-service.test.ts\n",
  );
  process.exit(2);
}

const [pkgAlias, mutateSpec, testFilesSpec, ...rest] = process.argv.slice(2);

if (!pkgAlias || !mutateSpec || !testFilesSpec) {
  usage(
    "expected exactly three arguments: <pkg> <mutateSpec> <testFilesSpec>.",
  );
}
if (rest.length > 0) {
  usage(
    `unexpected extra argument(s): ${rest.join(" ")}. ` +
      "Pass multiple files as ONE comma-separated spec, not repeated arguments " +
      "(repeated --mutate/--testFiles collapse to last-wins).",
  );
}
const filter = PACKAGES[pkgAlias];
if (!filter) {
  usage(
    `unknown package "${pkgAlias}". Expected one of: ${Object.keys(PACKAGES).join(", ")}.`,
  );
}

// Apply fast-local defaults without clobbering an explicit override.
const childEnv = { ...process.env };
for (const [key, value] of Object.entries(LOCAL_ENV_DEFAULTS)) {
  if (childEnv[key] === undefined || childEnv[key] === "")
    childEnv[key] = value;
}

const args = [
  "--filter",
  filter,
  "exec",
  "stryker",
  "run",
  "--mutate",
  mutateSpec,
  "--testFiles",
  testFilesSpec,
];

process.stderr.write(
  `mutate-scoped: ${filter} — mutate=${mutateSpec} testFiles=${testFilesSpec}\n` +
    `mutate-scoped: timeoutMS=${childEnv.STRYKER_TIMEOUT_MS} ` +
    `timeoutFactor=${childEnv.STRYKER_TIMEOUT_FACTOR} ` +
    `maxTestRunnerReuse=${childEnv.STRYKER_MAX_TEST_RUNNER_REUSE}\n\n`,
);

// Pipe stdout/stderr so we can both re-emit live AND scan the log for the
// scope-confirmation lines Stryker prints. spawn with an argv array (never a
// shell string) keeps each spec a single argument.
const child = spawn("pnpm", args, {
  env: childEnv,
  stdio: ["inherit", "pipe", "pipe"],
});

let captured = "";
/**
 * Tee a child stream: re-emit verbatim and accumulate for later scanning.
 *
 * @param {NodeJS.ReadableStream} source - the child's stdout or stderr.
 * @param {NodeJS.WritableStream} sink - the matching parent stream.
 * @returns {void}
 */
const tee = (source, sink) => {
  source.on("data", (chunk) => {
    sink.write(chunk);
    captured += chunk.toString();
  });
};
tee(child.stdout, process.stdout);
tee(child.stderr, process.stderr);

child.on("error", (error) => {
  process.stderr.write(
    `mutate-scoped: failed to launch pnpm: ${error.message}\n`,
  );
  process.exit(1);
});

child.on("close", (code) => {
  // Strip ANSI so the scope regexes match colored Stryker output.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching ANSI escape sequences
  const plain = captured.replace(/\x1b\[[0-9;]*m/g, "");
  const mutatedFiles = plain.match(
    /Found (\d+) of \d+ file\(s\) to be mutated/,
  );
  const instrumented = plain.match(/Instrumented (\d+) source file\(s\)/);
  const testFiles = plain.match(/Found (\d+) test file\(s\)/);

  // Mis-scope guard: a zero-file scope means the paths matched nothing (the
  // repo-relative-path / wrong-cwd trap). This exits 0 in raw Stryker; here it
  // is a hard failure so a silent mis-scope cannot masquerade as success.
  const misScoped =
    (mutatedFiles && Number(mutatedFiles[1]) === 0) ||
    (instrumented && Number(instrumented[1]) === 0);
  if (misScoped) {
    process.stderr.write(
      "\nmutate-scoped: MIS-SCOPE — 0 files instrumented. The --mutate spec matched " +
        "nothing (paths are PACKAGE-relative; check for typos or a wrong package). " +
        "Aborting instead of reporting a hollow run.\n",
    );
    process.exit(1);
  }

  if (testFiles && Number(testFiles[1]) === 0) {
    process.stderr.write(
      "\nmutate-scoped: WARNING — 0 test files matched --testFiles; every mutant will " +
        "survive for lack of coverage. Check the testFiles spec.\n",
    );
  }

  process.stderr.write(
    `\nmutate-scoped: done. Confirm scope above matched intent — ` +
      `mutated files: ${mutatedFiles ? mutatedFiles[1] : "?"}, ` +
      `instrumented: ${instrumented ? instrumented[1] : "?"}, ` +
      `test files: ${testFiles ? testFiles[1] : "?"}.\n`,
  );
  process.exit(code ?? 1);
});
