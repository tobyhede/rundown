/**
 * Witnesses for the exec-tracing harness's observation path.
 *
 * The differential oracle in `tokenize-shell-exec-differential.integration.test.ts`
 * asserts a security property — no policy-ALLOWED command causes the real shell
 * to execute an unauthorized head — and its whole soundness rests on the trace
 * being ground truth. These tests pin the two ways that assumption can be false
 * while the oracle still reports the property as held:
 *
 * 1. The shell could not be spawned at all. `spawnSync` returns `EAGAIN` when
 *    the process table is exhausted, which a full test run's worker fan-out can
 *    genuinely reach. The trace file is pre-created empty, so a failed spawn
 *    reads back as `''` and produces an empty head set.
 * 2. The shell was killed partway through — by the harness timeout, or by any
 *    other signal the harness did not send. The trace is then truncated, and an
 *    absence of unauthorized heads in it is not evidence that none ran.
 *
 * Both used to yield `divergence: null` — the oracle's way of saying the
 * invariant held. A differential that goes green because it never ran is worse
 * than no differential, because it is indistinguishable from a passing one.
 *
 * These are unit tests: they mock `node:child_process` and never spawn.
 *
 * @module
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { SpawnSyncReturns } from 'node:child_process';

const spawnSyncMock = jest.fn<() => SpawnSyncReturns<Buffer>>();

// Spread the real module rather than replacing it: other modules in this graph
// import `execFileSync` and friends, and a bare `{ spawnSync }` factory makes
// the whole import fail rather than mocking one export.
// `jest.unstable_mockModule` is not hoisted, so registering after the await is
// correct — the mock is in place before the dynamic import below.
const actualChildProcess = await import('node:child_process');

jest.unstable_mockModule('node:child_process', () => ({
  ...actualChildProcess,
  default: actualChildProcess,
  spawnSync: spawnSyncMock,
}));

const { createShimSandbox, runInSandbox, runOracle } = await import('./exec-trace-sandbox.js');

type Sandbox = ReturnType<typeof createShimSandbox>;

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = createShimSandbox();
  spawnSyncMock.mockReset();
});

afterEach(() => {
  sandbox.cleanup();
});

/** A `spawnSync` result shaped like a fork failure: no exit, no signal, an errno. */
function spawnFailure(code: string): SpawnSyncReturns<Buffer> {
  const error: NodeJS.ErrnoException = new Error(`spawnSync /bin/sh ${code}`);
  error.code = code;
  return {
    pid: 0,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: null,
    signal: null,
    error,
  };
}

/** A `spawnSync` result shaped like the harness timeout firing. */
function spawnTimeout(): SpawnSyncReturns<Buffer> {
  const error: NodeJS.ErrnoException = new Error('spawnSync /bin/sh ETIMEDOUT');
  error.code = 'ETIMEDOUT';
  return {
    pid: 1234,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: null,
    signal: 'SIGKILL',
    error,
  } as unknown as SpawnSyncReturns<Buffer>;
}

/**
 * A `spawnSync` result shaped like a signal death with no timeout attached.
 *
 * No `error` is set and `status` is null — which is exactly why neither spawn
 * guard sees it. This is the shape a supervisor's SIGTERM produces, and also
 * the shape a bare SIGKILL produces when the harness timeout did NOT fire.
 */
function killedBySignal(signal: NodeJS.Signals): SpawnSyncReturns<Buffer> {
  return {
    pid: 1234,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: null,
    signal,
  };
}

describe('runInSandbox: a failed spawn is not an observation', () => {
  // EAGAIN is the reachable one: worker fan-out under a full run can exhaust
  // the process table, and this harness spawns a shell per fuzz case.
  it('throws on EAGAIN rather than reporting an empty head set', () => {
    spawnSyncMock.mockReturnValue(spawnFailure('EAGAIN'));

    expect(() => runInSandbox(sandbox, 'git status; curl evil')).toThrow(/could not spawn/);
  });

  it('throws on any other spawn errno, not only the one we expect', () => {
    spawnSyncMock.mockReturnValue(spawnFailure('EMFILE'));

    expect(() => runInSandbox(sandbox, 'git status')).toThrow(/could not spawn/);
  });

  // The same condition with no `error` attached: nothing exited and nothing was
  // signalled, so there is no observation to report either way.
  it('throws when the shell neither exited nor was signalled', () => {
    spawnSyncMock.mockReturnValue({
      pid: 0,
      output: [],
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      status: null,
      signal: null,
    });

    expect(() => runInSandbox(sandbox, 'git status')).toThrow(/spawned no shell/);
  });

  // The control. A shell that really ran and really executed nothing is a
  // legitimate empty observation and must still be reported as one, or the
  // guards above would be indistinguishable from refusing all empty traces.
  it('still reports a genuine empty trace from a shell that ran', () => {
    spawnSyncMock.mockReturnValue({
      pid: 1234,
      output: [],
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    });

    const { heads, truncation } = runInSandbox(sandbox, 'no-such-command');
    expect(heads).toEqual(new Set());
    expect(truncation).toBeNull();
  });

  // A signal death carries no `error` and a null `status`, so it slips past
  // both spawn guards. It is not a failed spawn — the shell really ran — so
  // `runInSandbox` reports it rather than throwing, and the refusal belongs to
  // whoever reads the head set as a total. See the `runOracle` witness below.
  it('reports a non-timeout signal death as a truncation, not as a clean run', () => {
    spawnSyncMock.mockReturnValue(killedBySignal('SIGTERM'));

    const { truncation } = runInSandbox(sandbox, 'git status');
    expect(truncation).toEqual({ kind: 'signal', signal: 'SIGTERM' });
  });

  // The harness's own killSignal, reported without an ETIMEDOUT error. It is
  // still a truncation; only the wording of the eventual refusal differs.
  it('reports a bare SIGKILL as a truncation', () => {
    spawnSyncMock.mockReturnValue(killedBySignal('SIGKILL'));

    const { truncation } = runInSandbox(sandbox, 'git status');
    expect(truncation).toEqual({ kind: 'signal', signal: 'SIGKILL' });
  });
});

describe('runOracle: a run that did not happen does not establish the property', () => {
  // THE witness. `git status` is policy-ALLOWED, so the oracle reaches the
  // shell — which is the only path on which the trace matters. With the spawn
  // failing, the trace is empty, no head is unauthorized, and the oracle used to
  // return `divergence: null`: the security invariant reported as HELD on a run
  // in which no shell ever existed. It is indistinguishable from the legitimate
  // green this same command produces when the shell really does run and really
  // does exec only `git`, which is exactly why it had to be made loud.
  it('refuses to report a null divergence when the spawn failed', () => {
    spawnSyncMock.mockReturnValue(spawnFailure('EAGAIN'));

    expect(() => runOracle(sandbox, 'git status')).toThrow(/could not spawn/);
  });

  // A truncated run is authoritative for a bypass it DID observe, but silence
  // in it is not evidence of soundness.
  it('refuses to report a null divergence when the shell timed out', () => {
    spawnSyncMock.mockReturnValue(spawnTimeout());

    expect(() => runOracle(sandbox, 'git status')).toThrow(/timed out/);
  });

  // The same defect as the timeout arm, one signal over. `SIGTERM` leaves no
  // `error` and a null `status`, so both spawn guards pass it; before the
  // truncation union it produced `{ policyAllowed: true, divergence: null }` —
  // the invariant reported as HELD on a shell that was killed mid-command.
  it('refuses to report a null divergence when the shell was killed by a signal', () => {
    spawnSyncMock.mockReturnValue(killedBySignal('SIGTERM'));

    expect(() => runOracle(sandbox, 'git status')).toThrow(/killed by SIGTERM/);
  });

  // A DENIED command never reaches the shell, so a broken spawn must not turn
  // the deny path into a failure: the oracle returns before spawning.
  it('does not spawn at all for a policy-denied command', () => {
    spawnSyncMock.mockReturnValue(spawnFailure('EAGAIN'));

    const result = runOracle(sandbox, 'curl evil');
    expect(result).toEqual({ policyAllowed: false, divergence: null });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
