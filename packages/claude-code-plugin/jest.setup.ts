// jest.setup.ts
// Environment configuration for tests

import { afterEach, expect } from '@jest/globals';
import { assertExitCodeClean } from './__tests__/helpers/exit-code.js';

// Disable logging in tests
process.env.TEST_ENV = 'jest';
process.env.RUNDOWN_PLUGIN_LOG = '0';

// Note: Test timeout is configured in jest.config.js via testTimeout option

// `rdx` and `rdpath` signal failure by assigning `process.exitCode` (never
// `process.exit`, which would tear down the runner). Jest clones `process` for each
// test file, but copies the clone's `exitCode` back to the real process at file
// teardown and seeds the next file's clone from it. So a test that leaves `exitCode`
// set poisons the *next file*, where the stale code is misread as an unrelated
// command's exit status.
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
