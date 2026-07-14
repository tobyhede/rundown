import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect } from '@jest/globals';
import { assertExitCodeClean } from './__tests__/helpers/exit-code.js';
import {
  captureProcessState,
  diffProcessState,
  formatProcessStateDrift,
  restoreProcessState,
  type ProcessStateSnapshot,
} from './__tests__/helpers/process-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Set bundled runbooks path to dist/runbooks for tests
process.env.BUNDLED_RUNBOOKS_PATH = path.join(__dirname, 'dist', 'runbooks');

// CLI commands and helpers signal failure by assigning `process.exitCode` (never
// `process.exit`, which would tear down the in-process runner). Jest clones
// `process` for each test file, but copies the clone's `exitCode` back to the real
// process at file teardown and seeds the next file's clone from it. So a test that
// drives a helper directly and leaves `exitCode` set poisons the *next file*, whose
// first CLI invocation reports the stale code as its own.
//
// Discard anything inherited from an earlier file, so the guard below can only ever
// blame a leak that originated here.
process.exitCode = undefined;

// Fail the test that leaked, rather than resetting silently and letting the failure
// surface somewhere unrelated. Reset before asserting so one offender cannot cascade
// into every test after it.
afterEach(() => {
  const leaked = process.exitCode;
  process.exitCode = undefined;
  assertExitCodeClean(leaked, expect.getState().currentTestName ?? '<unknown test>');
});

// `process.env` and the working directory are process-wide (Jest's env object writes
// through to the real process), and — unlike `process.exitCode` — no CLI code path
// legitimately leaves them mutated. Drift is always a bug in the test, so it is failed
// unconditionally, with no opt-out.
//
// Both hooks are root-scoped, so they bracket the file's own `describe`-scoped hooks:
// the snapshot is taken before any inner `beforeEach` mutates env, and the check runs
// after any inner `afterEach` restores it. A file that restores from its own
// *root*-scoped `afterEach` runs after this one and will be reported — restore from a
// describe-scoped hook or inside the test instead.
let processState: ProcessStateSnapshot;

beforeEach(() => {
  processState = captureProcessState();
});

afterEach(() => {
  const drift = diffProcessState(processState);
  restoreProcessState(processState);
  const message = formatProcessStateDrift(
    drift,
    expect.getState().currentTestName ?? '<unknown test>',
  );
  if (message !== undefined) throw new Error(message);
});
