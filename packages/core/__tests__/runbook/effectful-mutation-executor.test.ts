import { describe, it, expect } from '@jest/globals';
import { CoreEffectfulMutationExecutor } from '../../src/runbook/effectful-mutation-executor.js';
import type {
  ExecutionAttempt,
  ExecutionLeaseService,
  DeadOwnerRecovery,
} from '../../src/runbook/storage/execution-lease.js';
import {
  generateExecutionToken,
  assertExecutionEpoch,
  type CapturedAuthority,
  type GuardedMutationResult,
} from '../../src/runbook/storage/mutation-result.js';
import type { RunId } from '../../src/runbook/run-id.js';

const RUN_ID = 'rd_00000000000000000000000000000001' as RunId;

/** Build an owned attempt in the given phase for the fixture run. */
function ownedAttempt(phase: ExecutionAttempt['phase']): ExecutionAttempt {
  return {
    runId: RUN_ID,
    token: generateExecutionToken(),
    epoch: assertExecutionEpoch(1),
    ownerPid: process.pid,
    phase,
  };
}

/** Minimal captured authority; the executor only reads `runId` in these tests. */
function captured(): CapturedAuthority {
  return { runId: RUN_ID } as CapturedAuthority;
}

/**
 * A lease stub that acquires and marks effect-started successfully, then makes
 * `abandonToRecovery` throw — modelling a recovery-write failure after the
 * effect boundary was crossed.
 */
class AbandonThrowsLease implements ExecutionLeaseService {
  async acquire(): Promise<GuardedMutationResult<ExecutionAttempt>> {
    return { kind: 'committed', value: ownedAttempt('claimed') };
  }
  async markEffectStarted(): Promise<GuardedMutationResult<ExecutionAttempt>> {
    return { kind: 'committed', value: ownedAttempt('effect_started') };
  }
  async abandonToRecovery(): Promise<
    GuardedMutationResult<{
      readonly runId: RunId;
      readonly epoch: ReturnType<typeof assertExecutionEpoch>;
    }>
  > {
    throw new Error('recovery-write failed');
  }
  async recoverDeadOwner(): Promise<DeadOwnerRecovery> {
    throw new Error('unused');
  }
  async acquireAll(): Promise<GuardedMutationResult<readonly ExecutionAttempt[]>> {
    throw new Error('unused');
  }
}

describe('CoreEffectfulMutationExecutor compute-failure recovery', () => {
  it('returns recovery_required even when abandonToRecovery throws after a compute failure', async () => {
    const executor = new CoreEffectfulMutationExecutor(new AbandonThrowsLease());

    const result = await executor.run({
      captured: captured(),
      compute: () => {
        throw new Error('effect blew up mid-flight');
      },
      commit: () => {
        throw new Error('commit must not run after a compute failure');
      },
    });

    // The recovery-write error must NOT mask the typed post-boundary outcome.
    expect(result.kind).toBe('recovery_required');
    if (result.kind === 'recovery_required') {
      expect(result.runId).toBe(RUN_ID);
      expect(result.epoch).toBe(1);
    }
  });
});
