const NodeEnvironment = require('jest-environment-node').default;
const { realpathSync } = require('node:fs');

/**
 * Jest environment that keeps `process.cwd()` live after `process.chdir()`.
 *
 * Why this exists
 * ---------------
 * `graceful-fs` (pulled in transitively by Jest) memoizes `process.cwd()` in the
 * Jest worker realm — the realm where the built-in `node:path` module lives and
 * reads its implicit base from. Under npm's flat node_modules that memo happened
 * to stay in sync; under pnpm's symlinked layout the worker-realm memo freezes at
 * the Jest start directory and is never invalidated, because the CLI's in-process
 * test runner (`src/services/in-process-cli-runner.ts`) calls `process.chdir()` on
 * the *sandbox* realm's process. The result: after a test changes directory into a temp
 * workspace, `process.cwd()` reports the new dir but `path.resolve('rel')` still
 * resolves against the frozen start dir — so commands that resolve a path relative
 * to cwd (e.g. `scenario-suite run` locating a suite's runbook) fail with
 * RUNBOOK_NOT_FOUND even though the production code is correct.
 *
 * The fix has to run in the worker realm (the sandbox cannot reach it), which is
 * exactly what a custom Jest environment constructor does. We replace the
 * memoizing `process.cwd` with a live one backed by `realpathSync.native('.')`,
 * which asks the kernel for the current directory on every call and therefore
 * tracks `process.chdir()`. This is test-infrastructure only — no production code
 * changes, and the CLI behaves correctly in real Node where this Jest/graceful-fs
 * interaction does not occur.
 */
class LiveCwdEnvironment extends NodeEnvironment {
  constructor(config, context) {
    super(config, context);
    const liveCwd = () => realpathSync.native('.');
    // Worker realm — node:path.resolve reads its implicit base from this process.
    process.cwd = liveCwd;
    // Sandbox realm — the process tests actually chdir.
    if (this.global && this.global.process) {
      this.global.process.cwd = liveCwd;
    }
  }
}

module.exports = LiveCwdEnvironment;
