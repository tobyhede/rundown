import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Command } from 'commander';
import { TestWriter, setWriter, type OutputWriter } from '@rundown-org/core';

const abortDelegation = jest.fn<() => Promise<Record<string, unknown>>>();

jest.unstable_mockModule('../../src/helpers/lifecycle-seam-factory.js', () => ({
  buildNonDelegatingLifecycleSeam: () => ({ seam: { abortDelegation } }),
}));

const { registerAbortCommand } = await import('../../src/commands/abort.js');
const TOKEN = `rdtk_${'A'.repeat(32)}`;

describe('abort command transactional refusals', () => {
  let previousWriter: OutputWriter;
  let writer: TestWriter;

  beforeEach(() => {
    writer = new TestWriter();
    previousWriter = setWriter(writer);
    process.exitCode = undefined;
  });

  afterEach(() => {
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
