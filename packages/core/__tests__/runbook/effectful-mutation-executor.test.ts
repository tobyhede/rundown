import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  CoreEffectfulMutationExecutor,
  type PreparedActorMutation,
} from '../../src/runbook/effectful-mutation-executor.js';
import { OpenDelegatedChildrenError } from '../../src/runbook/storage/runbook-store.js';
import type {
  AbandonedAttemptOutcome,
  AbandonedAttemptSetOutcome,
  DeadOwnerRecovery,
  ExecutionAttempt,
  ExecutionLeaseService,
} from '../../src/runbook/storage/execution-lease.js';
import {
  assertClaimGeneration,
  assertExecutionEpoch,
  assertExecutionToken,
  assertStateVersion,
  type CapturedAuthority,
  type GuardedMutationResult,
} from '../../src/runbook/storage/mutation-result.js';
import { assertClaimLookupKey } from '../../src/runbook/claim-id.js';
import { assertRunId } from '../../src/runbook/run-id.js';

// The executor's whole job is the sequence acquire → mark-effect → compute →
// commit → recovery, and its hard cases are the ones where a step fails AFTER
// the effect boundary. A real lease and a real store can reach the happy path
// but cannot cheaply reach "the commit threw and may or may not be durable",
// which is precisely the branch that must never repeat an ambiguous effect. The
// executor takes its lease through constructor DI and its persistence through
// the `commit` closure, so both are driven here as fakes.
//
// ACCEPTED MUTATION SURVIVORS in effectful-mutation-executor.ts (#485).
//
//  - Every `logger.warn` payload (object literals, the `runs:` array
//    declarations, and the `epoch`/`reason` fields). Diagnostics only: no caller
//    dispatches on them, and asserting log shapes would pin prose rather than
//    behaviour.
//  - `input.recoveryReason ?? DEFAULT_MID_EFFECT_REASON`. The reason reaches the
//    lease verbatim and is asserted below, but the default-vs-supplied
//    distinction is a passthrough with no branch of its own.

const RUN_ID = assertRunId(`rd_${'a'.repeat(32)}`);
const OTHER_RUN_ID = assertRunId(`rd_${'b'.repeat(32)}`);
const TOKEN = assertExecutionToken('a'.repeat(43));

function captured(runId = RUN_ID): CapturedAuthority {
  return {
    runId,
    claimKey: assertClaimLookupKey(`rdclk_${'1'.repeat(32)}`),
    claimGeneration: assertClaimGeneration(1),
    stateVersion: assertStateVersion(1),
  };
}

function attempt(runId = RUN_ID, phase: ExecutionAttempt['phase'] = 'claimed'): ExecutionAttempt {
  return { runId, token: TOKEN, epoch: assertExecutionEpoch(4), ownerPid: 1234, phase };
}

/** Minimal prepared mutation; the executor treats it as an opaque payload. */
const PREPARED = {
  previousState: {},
  nextState: {},
  snapshot: {},
  effects: [],
} as unknown as PreparedActorMutation;

interface FakeLease extends ExecutionLeaseService {
  acquire: jest.Mock<ExecutionLeaseService['acquire']>;
  acquireAll: jest.Mock<ExecutionLeaseService['acquireAll']>;
  markEffectStarted: jest.Mock<ExecutionLeaseService['markEffectStarted']>;
  markEffectStartedAll: jest.Mock<ExecutionLeaseService['markEffectStartedAll']>;
  releaseClaimed: jest.Mock<ExecutionLeaseService['releaseClaimed']>;
  releaseEffectStarted: jest.Mock<ExecutionLeaseService['releaseEffectStarted']>;
  abandonToRecovery: jest.Mock<ExecutionLeaseService['abandonToRecovery']>;
  abandonAllToRecovery: jest.Mock<ExecutionLeaseService['abandonAllToRecovery']>;
  recoverDeadOwner: jest.Mock<ExecutionLeaseService['recoverDeadOwner']>;
}

function makeLease(): FakeLease {
  const claimed = attempt();
  const started = attempt(RUN_ID, 'effect_started');
  return {
    acquire: jest.fn(async () => ({ kind: 'committed' as const, value: claimed })),
    acquireAll: jest.fn(async () => ({ kind: 'committed', value: [claimed] }) as const),
    markEffectStarted: jest.fn(async () => ({ kind: 'committed', value: started }) as const),
    markEffectStartedAll: jest.fn(async () => ({ kind: 'committed', value: [started] }) as const),
    releaseClaimed: jest.fn(async () => undefined),
    releaseEffectStarted: jest.fn(async () => undefined),
    abandonToRecovery: jest.fn(
      async (): Promise<AbandonedAttemptOutcome> => ({
        kind: 'recovery_required',
        runId: RUN_ID,
        epoch: assertExecutionEpoch(4),
        message: 'Recovery is required.',
      }),
    ),
    abandonAllToRecovery: jest.fn(
      async (): Promise<AbandonedAttemptSetOutcome> => ({
        kind: 'aggregate_recovery_required',
        attempts: [{ runId: RUN_ID, epoch: assertExecutionEpoch(4) }],
        message: 'Aggregate recovery is required.',
      }),
    ),
    recoverDeadOwner: jest.fn(
      async (): Promise<DeadOwnerRecovery> => ({ kind: 'missing', runId: RUN_ID }),
    ),
  };
}

const committedResult = {
  kind: 'committed',
  value: 'done',
} as const satisfies GuardedMutationResult<string>;
const superseded = {
  kind: 'claim_superseded',
  runId: RUN_ID,
  message: 'A newer claim controls this run.',
} as const satisfies GuardedMutationResult<never>;

let lease: FakeLease;
let executor: CoreEffectfulMutationExecutor;

beforeEach(() => {
  lease = makeLease();
  executor = new CoreEffectfulMutationExecutor(lease, 1234);
});

describe('CoreEffectfulMutationExecutor.run', () => {
  it('returns the committed result without touching recovery', async () => {
    const result = await executor.run({
      captured: captured(),
      compute: async () => PREPARED,
      commit: async () => committedResult,
    });

    expect(result).toEqual(committedResult);
    expect(lease.abandonToRecovery).not.toHaveBeenCalled();
    expect(lease.releaseEffectStarted).not.toHaveBeenCalled();
  });

  it('passes a commit-reported recovery_required straight back without re-recording it', async () => {
    // The commit already moved the attempt to recovery, so recording again would
    // be a second write against an attempt that is no longer in `effect_started`.
    const fromCommit = {
      kind: 'recovery_required',
      runId: RUN_ID,
      epoch: assertExecutionEpoch(4),
      message: 'The commit recorded recovery.',
    } as const;

    const result = await executor.run({
      captured: captured(),
      compute: async () => PREPARED,
      commit: async () => fromCommit,
    });

    expect(result).toEqual(fromCommit);
    expect(lease.abandonToRecovery).not.toHaveBeenCalled();
  });

  it('records recovery when the commit refuses for any other reason', async () => {
    // A refused commit after the effect ran leaves an ambiguous outcome, so the
    // refusal is converted into a recorded recovery rather than surfaced as-is.
    const result = await executor.run({
      captured: captured(),
      compute: async () => PREPARED,
      commit: async () => superseded,
      recoveryReason: 'effect_boundary_crossed',
    });

    expect(result).toMatchObject({ kind: 'recovery_required', runId: RUN_ID });
    expect(lease.abandonToRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, phase: 'effect_started' }),
      'effect_boundary_crossed',
    );
  });

  it('throws when a refused commit cannot be recorded for recovery', async () => {
    lease.abandonToRecovery.mockResolvedValue({
      kind: 'execution_in_progress',
      runId: RUN_ID,
      message: 'Another actor owns this run.',
    });

    await expect(
      executor.run({
        captured: captured(),
        compute: async () => PREPARED,
        commit: async () => superseded,
      }),
    ).rejects.toThrow(/completed but its refused commit could not be recorded for recovery/);
  });

  it('reconciles a thrown commit by re-issuing the exact commit', async () => {
    // The ambiguous case: the commit threw, but it may have been durable. The
    // exact re-issue is what distinguishes "lost the response" from "never
    // committed" — and a committed reconciliation must NOT record recovery.
    const commit = jest
      .fn<
        (a: ExecutionAttempt, p: PreparedActorMutation) => Promise<GuardedMutationResult<string>>
      >()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(committedResult);

    const result = await executor.run({
      captured: captured(),
      compute: async () => PREPARED,
      commit,
    });

    expect(result).toEqual(committedResult);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(lease.abandonToRecovery).not.toHaveBeenCalled();
  });

  it('accepts a recovery_required reconciliation of a thrown commit', async () => {
    const reconciled = {
      kind: 'recovery_required',
      runId: RUN_ID,
      epoch: assertExecutionEpoch(4),
      message: 'Recovery was already recorded.',
    } as const;
    const commit = jest
      .fn<
        (a: ExecutionAttempt, p: PreparedActorMutation) => Promise<GuardedMutationResult<string>>
      >()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(reconciled);

    const result = await executor.run({
      captured: captured(),
      compute: async () => PREPARED,
      commit,
    });

    expect(result).toEqual(reconciled);
    expect(lease.abandonToRecovery).not.toHaveBeenCalled();
  });

  it('records recovery when the reconciling commit also throws', async () => {
    const commit = jest
      .fn<
        (a: ExecutionAttempt, p: PreparedActorMutation) => Promise<GuardedMutationResult<string>>
      >()
      .mockRejectedValue(new Error('connection reset'));

    const result = await executor.run({
      captured: captured(),
      compute: async () => PREPARED,
      commit,
    });

    expect(result).toMatchObject({ kind: 'recovery_required' });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(lease.abandonToRecovery).toHaveBeenCalledTimes(1);
  });

  it('rethrows the original commit error when recovery cannot be recorded', async () => {
    // Never a contention-shaped refusal here: a thrown commit may already be
    // durable, and a refusal would invite the caller to retry — repeating the
    // very effect this fence exists to run once.
    lease.abandonToRecovery.mockResolvedValue({
      kind: 'execution_in_progress',
      runId: RUN_ID,
      message: 'Another actor owns this run.',
    });
    const commitError = new Error('connection reset');

    await expect(
      executor.run({
        captured: captured(),
        compute: async () => PREPARED,
        commit: async () => {
          throw commitError;
        },
      }),
    ).rejects.toBe(commitError);
  });

  it('releases the attempt and rethrows an open-delegated-children refusal un-reconciled', async () => {
    // The one commit failure with a provably non-durable outcome: the guard runs
    // before the transaction's first write. Recording recovery would park a run
    // whose state never changed.
    const openChildren = new OpenDelegatedChildrenError([]);
    const commit = jest
      .fn<
        (a: ExecutionAttempt, p: PreparedActorMutation) => Promise<GuardedMutationResult<string>>
      >()
      .mockRejectedValue(openChildren);

    await expect(
      executor.run({ captured: captured(), compute: async () => PREPARED, commit }),
    ).rejects.toBe(openChildren);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(lease.releaseEffectStarted).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, phase: 'effect_started' }),
    );
    expect(lease.abandonToRecovery).not.toHaveBeenCalled();
  });

  it('records recovery when the effect itself fails after the boundary', async () => {
    const result = await executor.run({
      captured: captured(),
      compute: async () => {
        throw new Error('the external effect died');
      },
      commit: async () => committedResult,
    });

    expect(result).toMatchObject({ kind: 'recovery_required' });
  });

  it('rethrows the effect error when recovery recording itself throws', async () => {
    lease.abandonToRecovery.mockRejectedValue(new Error('database is locked'));
    const effectError = new Error('the external effect died');

    await expect(
      executor.run({
        captured: captured(),
        compute: async () => {
          throw effectError;
        },
        commit: async () => committedResult,
      }),
    ).rejects.toBe(effectError);
  });

  it('refuses without running the effect when the lease cannot be acquired', async () => {
    lease.acquire.mockResolvedValue(superseded);
    const compute = jest.fn(async () => PREPARED);

    const result = await executor.run({
      captured: captured(),
      compute,
      commit: async () => committedResult,
    });

    expect(result).toEqual(superseded);
    expect(compute).not.toHaveBeenCalled();
    expect(lease.markEffectStarted).not.toHaveBeenCalled();
  });

  it('releases the claimed attempt when ownership is lost before the effect boundary', async () => {
    lease.markEffectStarted.mockResolvedValue(superseded);
    const compute = jest.fn(async () => PREPARED);

    const result = await executor.run({
      captured: captured(),
      compute,
      commit: async () => committedResult,
    });

    expect(result).toEqual(superseded);
    expect(compute).not.toHaveBeenCalled();
    expect(lease.releaseClaimed).toHaveBeenCalledWith([
      expect.objectContaining({ runId: RUN_ID, phase: 'claimed' }),
    ]);
  });
});

describe('CoreEffectfulMutationExecutor.runAll', () => {
  it('returns the committed aggregate result without touching recovery', async () => {
    const result = await executor.runAll({
      captured: [captured()],
      compute: async () => PREPARED,
      commit: async () => committedResult,
    });

    expect(result).toEqual(committedResult);
    expect(lease.abandonAllToRecovery).not.toHaveBeenCalled();
  });

  it('records aggregate recovery when the aggregate commit refuses', async () => {
    const result = await executor.runAll({
      captured: [captured()],
      compute: async () => PREPARED,
      commit: async () => superseded,
    });

    expect(result).toMatchObject({
      kind: 'aggregate_recovery_required',
      attempts: [{ runId: RUN_ID, epoch: 4 }],
    });
    expect(lease.abandonAllToRecovery).toHaveBeenCalledTimes(1);
  });

  it('throws when a refused aggregate commit cannot be recorded for recovery', async () => {
    lease.abandonAllToRecovery.mockResolvedValue({
      kind: 'execution_in_progress',
      runId: RUN_ID,
      message: 'Another actor owns this run.',
    });

    await expect(
      executor.runAll({
        captured: [captured()],
        compute: async () => PREPARED,
        commit: async () => superseded,
      }),
    ).rejects.toThrow(/aggregate effect completed but its refused commit could not be recorded/);
  });

  it('reconciles a thrown aggregate commit by re-issuing the exact commit', async () => {
    const commit = jest
      .fn<
        (
          a: readonly ExecutionAttempt[],
          p: PreparedActorMutation,
        ) => Promise<GuardedMutationResult<string>>
      >()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(committedResult);

    const result = await executor.runAll({
      captured: [captured()],
      compute: async () => PREPARED,
      commit,
    });

    expect(result).toEqual(committedResult);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(lease.abandonAllToRecovery).not.toHaveBeenCalled();
  });

  it('records aggregate recovery when the reconciling aggregate commit also throws', async () => {
    const commit = jest
      .fn<
        (
          a: readonly ExecutionAttempt[],
          p: PreparedActorMutation,
        ) => Promise<GuardedMutationResult<string>>
      >()
      .mockRejectedValue(new Error('connection reset'));

    const result = await executor.runAll({
      captured: [captured()],
      compute: async () => PREPARED,
      commit,
    });

    expect(result).toMatchObject({ kind: 'aggregate_recovery_required' });
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('rethrows the original aggregate commit error when recovery cannot be recorded', async () => {
    lease.abandonAllToRecovery.mockResolvedValue({
      kind: 'execution_in_progress',
      runId: RUN_ID,
      message: 'Another actor owns this run.',
    });
    const commitError = new Error('connection reset');

    await expect(
      executor.runAll({
        captured: [captured()],
        compute: async () => PREPARED,
        commit: async () => {
          throw commitError;
        },
      }),
    ).rejects.toBe(commitError);
  });

  it('records aggregate recovery when the aggregate effect fails after the boundary', async () => {
    const result = await executor.runAll({
      captured: [captured()],
      compute: async () => {
        throw new Error('the external effect died');
      },
      commit: async () => committedResult,
    });

    expect(result).toMatchObject({ kind: 'aggregate_recovery_required' });
  });

  // Acquisition happens in a retry loop, because a refused OPTIONAL target is
  // dropped and the whole set re-acquired rather than the aggregate failing. The
  // required/optional split is the difference between "close what you can" and
  // "change nothing", so both directions are driven here.
  it('drops a refused optional target and retries the acquisition without it', async () => {
    const refusal = {
      kind: 'claim_superseded',
      runId: OTHER_RUN_ID,
      message: 'The optional target lost its claim.',
    } as const;
    lease.acquireAll
      .mockResolvedValueOnce(refusal)
      .mockResolvedValueOnce({ kind: 'committed', value: [attempt()] });

    const result = await executor.runAll({
      captured: [captured(), captured(OTHER_RUN_ID)],
      optionalRunIds: [OTHER_RUN_ID],
      compute: async () => PREPARED,
      commit: async () => committedResult,
    });

    expect(result).toEqual(committedResult);
    expect(lease.acquireAll).toHaveBeenCalledTimes(2);
    // The retry names only the required run — the dropped target is absent from
    // the captured set, so preparation sees the shape it would have seen had the
    // target never been named.
    expect(lease.acquireAll.mock.calls[1][0]).toEqual([captured()]);
  });

  it('refuses without running the effect when a required target cannot be acquired', async () => {
    const refusal = {
      kind: 'claim_superseded',
      runId: RUN_ID,
      message: 'The required target lost its claim.',
    } as const;
    lease.acquireAll.mockResolvedValue(refusal);
    const compute = jest.fn(async () => PREPARED);

    const result = await executor.runAll({
      captured: [captured(), captured(OTHER_RUN_ID)],
      optionalRunIds: [OTHER_RUN_ID],
      compute,
      commit: async () => committedResult,
    });

    expect(result).toEqual(refusal);
    expect(compute).not.toHaveBeenCalled();
    expect(lease.acquireAll).toHaveBeenCalledTimes(1);
  });

  it('releases the already-acquired attempts when the effect boundary cannot be marked', async () => {
    // Nothing external ran, so the claimed attempts must be handed back rather
    // than left owned until dead-owner recovery reclaims them.
    const refusal = {
      kind: 'concurrent_modification',
      runId: RUN_ID,
      message: 'The run changed before the boundary.',
    } as const;
    const claimed = [attempt()];
    lease.acquireAll.mockResolvedValue({ kind: 'committed', value: claimed });
    lease.markEffectStartedAll.mockResolvedValue(refusal);
    const compute = jest.fn(async () => PREPARED);

    const result = await executor.runAll({
      captured: [captured()],
      compute,
      commit: async () => committedResult,
    });

    expect(result).toEqual(refusal);
    expect(compute).not.toHaveBeenCalled();
    expect(lease.releaseClaimed).toHaveBeenCalledWith(claimed);
  });

  it('rejects an empty captured set', async () => {
    await expect(
      executor.runAll({
        captured: [],
        compute: async () => PREPARED,
        commit: async () => committedResult,
      }),
    ).rejects.toThrow(/requires at least one captured run/);
  });

  it('rejects a captured set that repeats a run', async () => {
    await expect(
      executor.runAll({
        captured: [captured(), captured()],
        compute: async () => PREPARED,
        commit: async () => committedResult,
      }),
    ).rejects.toThrow(/repeats a captured run/);
  });

  it('rejects a captured set whose every member is optional', async () => {
    await expect(
      executor.runAll({
        captured: [captured(), captured(OTHER_RUN_ID)],
        optionalRunIds: [RUN_ID, OTHER_RUN_ID],
        compute: async () => PREPARED,
        commit: async () => committedResult,
      }),
    ).rejects.toThrow(/requires at least one required run/);
  });
});
