import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Command } from 'commander';
import { Errors, TestWriter, setWriter, type OutputWriter } from '@rundown-org/core';

const abortDelegation = jest.fn<() => Promise<Record<string, unknown>>>();

jest.unstable_mockModule('../../src/helpers/lifecycle-seam-factory.js', () => ({
  buildNonDelegatingLifecycleSeam: () => ({ seam: { abortDelegation } }),
}));

const { registerAbortCommand } = await import('../../src/commands/abort.js');
const TOKEN = `rdtk_${'A'.repeat(32)}`;

describe('abort command transactional refusals', () => {
  let previousWriter: OutputWriter;
  let writer: TestWriter;
  let exitSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    writer = new TestWriter();
    previousWriter = setWriter(writer);
    process.exitCode = undefined;
    // A refusal arm never calls `process.exit` — it assigns `process.exitCode`.
    // Anything that DOES reach the hard exit here got there by falling through
    // to the exhaustive `default`, i.e. by a broken switch; intercepting it
    // turns that into a failed assertion in this worker rather than a killed
    // worker, so the failure is attributable to the arm that lost its label.
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)})`);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    setWriter(previousWriter);
    process.exitCode = undefined;
    abortDelegation.mockReset();
  });

  // Both halves matter and neither implies the other: the exit code is what the
  // call site owns (every transactional refusal exits 1, unconditionally), and
  // the emitted envelope is what proves the renderer actually ran — without it,
  // deleting the render call would still leave a passing exit-code assertion.
  it.each([
    {
      outcome: {
        kind: 'execution_in_progress',
        runId: `rd_${'1'.repeat(32)}`,
        epoch: 1,
        message: 'execution in progress',
      },
      code: 'EXECUTION_IN_PROGRESS',
    },
    {
      outcome: {
        kind: 'recovery_required',
        runId: `rd_${'2'.repeat(32)}`,
        epoch: 2,
        message: 'recovery required',
      },
      code: 'RECOVERY_REQUIRED',
    },
    {
      outcome: {
        kind: 'claim_superseded',
        runId: `rd_${'3'.repeat(32)}`,
        message: 'claim superseded',
      },
      code: 'STALE_CLAIM',
    },
    {
      outcome: {
        kind: 'concurrent_modification',
        runId: `rd_${'4'.repeat(32)}`,
        message: 'concurrent modification',
      },
      code: 'CONCURRENT_MODIFICATION',
    },
    {
      outcome: {
        kind: 'missing',
        runId: `rd_${'5'.repeat(32)}`,
        message: 'run missing',
      },
      code: 'RUN_TARGET_UNAVAILABLE',
    },
    {
      outcome: {
        kind: 'aggregate_recovery_required',
        message: 'aggregate recovery required',
        attempts: [{ runId: `rd_${'6'.repeat(32)}`, epoch: 3 }],
      },
      // Its own code, distinct from the single-run `RECOVERY_REQUIRED`: only
      // this arm carries a run set in `details.runs`.
      code: 'AGGREGATE_RECOVERY_REQUIRED',
    },
  ])('renders $outcome.kind as a command refusal', async ({ outcome, code }) => {
    abortDelegation.mockResolvedValue(outcome);
    const program = new Command().exitOverride();
    registerAbortCommand(program);

    await program.parseAsync(['node', 'rundown', 'abort', TOKEN]);

    expect(process.exitCode).toBe(1);
    const envelope = JSON.parse(writer.getStdout()) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      kind: 'error',
      command: 'abort',
      code,
      error: outcome.message,
    });
  });

  it('rethrows an error outcome under its own code instead of the needs-force diagnosis', async () => {
    // `error` is the switch arm immediately above `needs_force`, and neither
    // one is reachable end-to-end from the command tests. Losing the arm (its
    // case label emptied, or its `throw` deleted) drops an errored abort into
    // `needs_force`, which reports RD-811 "delegation already claimed" built
    // from fields the error outcome does not have — a confident, actionable,
    // and entirely wrong remediation for a failure with no claim involved.
    abortDelegation.mockResolvedValue({
      kind: 'error',
      error: Errors.delegationLockTimeout(`rd_${'9'.repeat(32)}`),
    });
    const program = new Command().exitOverride();
    registerAbortCommand(program);

    // Unlike the refusal arms, this one rethrows: `withErrorHandling` renders
    // the envelope and then hard-exits, which the shared spy converts to a throw.
    await expect(program.parseAsync(['node', 'rundown', 'abort', TOKEN])).rejects.toThrow(
      'process.exit(1)',
    );

    const envelope = JSON.parse(writer.getStdout()) as Record<string, unknown>;
    expect(envelope).toMatchObject({ kind: 'error', code: 'RD-810' });
    // The bearer the caller presented must not round-trip into the envelope.
    expect(writer.getStdout()).not.toContain(TOKEN);
  });

  it('carries every aggregate recovery attempt into the error details', async () => {
    // The one arm with structured details: the runs a caller must recover before
    // retrying travel in `details.runs`, not in the message.
    const attempts = [
      { runId: `rd_${'7'.repeat(32)}`, epoch: 3 },
      { runId: `rd_${'8'.repeat(32)}`, epoch: 4 },
    ];
    abortDelegation.mockResolvedValue({
      kind: 'aggregate_recovery_required',
      message: 'aggregate recovery required',
      attempts,
    });
    const program = new Command().exitOverride();
    registerAbortCommand(program);

    await program.parseAsync(['node', 'rundown', 'abort', TOKEN]);

    expect(process.exitCode).toBe(1);
    const envelope = JSON.parse(writer.getStdout()) as { details?: unknown };
    expect(envelope.details).toEqual({ runs: attempts });
  });
});
