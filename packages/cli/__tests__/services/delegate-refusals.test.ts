import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Command } from 'commander';
import { TestWriter, setWriter, type OutputWriter } from '@rundown-org/core';

// Sibling of `abort-refusals.test.ts`, for the same reason and against the same
// union. `delegate`'s two switches each carry the six-member transactional
// refusal arm, and only `execution_in_progress` is reachable end-to-end (by
// seeding execution ownership, as delegate.test.ts does). The remaining five
// arise from a lost CAS race, a superseded claim, a run deleted mid-mutation, or
// a multi-run recovery — none of which a single-process test can stage without
// racing itself. Substituting the seam is what lets a test assert them, so an
// emptied case label is caught here rather than shipping as a delegate that
// reports `Unexpected delegate outcome` where it should report `STALE_CLAIM`.
const issueDelegation = jest.fn<() => Promise<Record<string, unknown>>>();

// Captured before the mock is registered: `jest.unstable_mockModule` does not
// hoist, so this top-level await runs first and yields the real barrel to spread.
const actualCore = await import('@rundown-org/core');

jest.unstable_mockModule('@rundown-org/core', () => ({
  ...actualCore,
  // Every service `buildDelegateSeam` constructs is inert here: the command's
  // path to the switch runs through the seam alone, and real constructors would
  // open the state store for a run this test never creates.
  RunbookStateManager: class {},
  SessionService: class {},
  RunbookActorService: class {},
  ExecutionLifecycleService: class {},
  RunbookCompletionService: class {},
  DelegationScanService: class {},
  createEffectfulActorMutationRunner: () => ({}),
  RunbookLifecycleCommandService: class {
    readonly issueDelegation = issueDelegation;
  },
}));

const { registerDelegateCommand } = await import('../../src/commands/delegate.js');

const TOKEN = `rdtk_${'A'.repeat(32)}`;
const CLAIM_ID = `rdclm_${'a'.repeat(32)}_${'A'.repeat(43)}`;

/** The five transactional refusals delegate cannot stage end-to-end, plus their codes. */
const REFUSALS = [
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
    outcome: { kind: 'missing', runId: `rd_${'5'.repeat(32)}`, message: 'run missing' },
    code: 'RUN_TARGET_UNAVAILABLE',
  },
  {
    outcome: {
      kind: 'aggregate_recovery_required',
      message: 'aggregate recovery required',
      attempts: [{ runId: `rd_${'6'.repeat(32)}`, epoch: 3 }],
    },
    // Distinct from the single-run `RECOVERY_REQUIRED`: only this arm carries
    // `details.runs`, so an agent routing on `code` can tell the shapes apart.
    code: 'AGGREGATE_RECOVERY_REQUIRED',
  },
] as const;

describe('delegate command transactional refusals', () => {
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
    issueDelegation.mockReset();
  });

  /**
   * Drive `rd delegate` with the seam stubbed to one outcome.
   *
   * @param argv - Argument vector after `rundown delegate`.
   * @param outcome - The seam outcome to return.
   * @returns The parsed JSON envelope written to stdout.
   */
  async function runDelegate(
    argv: readonly string[],
    outcome: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    issueDelegation.mockResolvedValue(outcome);
    const program = new Command().exitOverride();
    registerDelegateCommand(program);
    await program.parseAsync(['node', 'rundown', 'delegate', ...argv]);
    return JSON.parse(writer.getStdout()) as Record<string, unknown>;
  }

  // Both halves matter and neither implies the other: the exit code is what the
  // call site owns (every transactional refusal exits 1), and the envelope is
  // what proves the renderer ran — without it, deleting the render call would
  // still leave a passing exit-code assertion.
  it.each(REFUSALS)('renders $outcome.kind on the --retry path', async ({ outcome, code }) => {
    const envelope = await runDelegate(['--retry', TOKEN, '--claim-id', CLAIM_ID], outcome);

    expect(process.exitCode).toBe(1);
    expect(envelope).toMatchObject({ kind: 'error', command: 'delegate', code });
    expect(envelope.error).toBe(outcome.message);
  });

  it.each(REFUSALS)('renders $outcome.kind on the fresh-issue path', async ({ outcome, code }) => {
    const envelope = await runDelegate(
      ['child.runbook.md', '--step', '1.1', '--claim-id', CLAIM_ID],
      outcome,
    );

    expect(process.exitCode).toBe(1);
    expect(envelope).toMatchObject({ kind: 'error', command: 'delegate', code });
    expect(envelope.error).toBe(outcome.message);
  });

  it('carries every aggregate recovery attempt into the fresh-issue error details', async () => {
    // The one arm with structured details: the runs a caller must recover before
    // retrying travel in `details.runs`, not in the message.
    const attempts = [
      { runId: `rd_${'7'.repeat(32)}`, epoch: 3 },
      { runId: `rd_${'8'.repeat(32)}`, epoch: 4 },
    ];

    const envelope = await runDelegate(['child.runbook.md', '--step', '1.1'], {
      kind: 'aggregate_recovery_required',
      message: 'aggregate recovery required',
      attempts,
    });

    expect(process.exitCode).toBe(1);
    expect(envelope.details).toEqual({ runs: attempts });
  });
});
