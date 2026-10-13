import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  classifyExecutionLease,
  currentLeaseHolder,
  refuseUnderLease,
  type ExecutionLease,
  type LeaseDecision,
} from '../../src/runbook/execution-lease.js';
import { createProcessIdentity } from '../../src/runbook/process-identity.js';
import { assertRunId } from '../../src/runbook/run-id.js';

/**
 * The lease rule (#902): a held lease is In Progress while its `(pid, start
 * id)` is alive and Interrupted once it is not; In Progress refuses every
 * decision, Interrupted refuses only the decisions that would pass the
 * unknown effect.
 */

const RUN = assertRunId(`rd_${'a'.repeat(32)}`);
const CURSOR = { step: '2' } as const;
const identity = createProcessIdentity(() => 'self-start');

function leaseFor(pid: number, startId: string | null): ExecutionLease {
  return { attempt: 3, pid, startId, startedAt: '2026-10-13T00:00:00.000Z' };
}

/** A pid that certainly names no process: a child that already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return child.pid;
}

describe('classifyExecutionLease', () => {
  it('reads a live holder with a matching start id as In Progress', () => {
    const lease = leaseFor(process.pid, 'self-start');
    expect(classifyExecutionLease(lease, identity)).toEqual({ kind: 'in_progress', lease });
  });

  it('reads a recycled pid (start id differs) as Interrupted', () => {
    const lease = leaseFor(process.pid, 'an earlier process');
    expect(classifyExecutionLease(lease, identity)).toEqual({ kind: 'interrupted', lease });
  });

  it('reads a pid with no process as Interrupted', () => {
    const lease = leaseFor(deadPid(), null);
    expect(classifyExecutionLease(lease, identity).kind).toBe('interrupted');
  });

  it('reads a live pid with no recorded start id as In Progress', () => {
    const lease = leaseFor(process.pid, null);
    expect(classifyExecutionLease(lease, identity).kind).toBe('in_progress');
  });

  it('describes this process as the holder it would record', () => {
    expect(currentLeaseHolder(identity)).toEqual({ pid: process.pid, startId: 'self-start' });
  });
});

describe('refuseUnderLease', () => {
  const decisions: readonly LeaseDecision[] = ['pass', 'complete', 'fail', 'goto', 'stop'];

  it('lets every decision proceed when no lease is held', () => {
    for (const decision of decisions) {
      expect(refuseUnderLease(RUN, CURSOR, null, decision, identity)).toBeUndefined();
    }
  });

  it('refuses every decision while the attempt is In Progress', () => {
    const lease = leaseFor(process.pid, 'self-start');
    for (const decision of decisions) {
      expect(refuseUnderLease(RUN, CURSOR, lease, decision, identity)).toMatchObject({
        kind: 'execution_in_progress',
        runId: RUN,
        step: '2',
        lease,
      });
    }
  });

  it('refuses pass and complete on an Interrupted attempt, naming the decisions that clear it', () => {
    const lease = leaseFor(process.pid, 'an earlier process');
    for (const decision of ['pass', 'complete'] as const) {
      const refusal = refuseUnderLease(RUN, { step: '2', substep: '1' }, lease, decision, identity);
      expect(refusal).toMatchObject({ kind: 'execution_interrupted', step: '2.1', lease });
      expect(refusal?.message).toContain('rundown fail --step 2.1');
      expect(refusal?.message).toContain('never repeats');
    }
  });

  it('lets fail, goto and stop decide an Interrupted attempt', () => {
    const lease = leaseFor(process.pid, 'an earlier process');
    for (const decision of ['fail', 'goto', 'stop'] as const) {
      expect(refuseUnderLease(RUN, CURSOR, lease, decision, identity)).toBeUndefined();
    }
  });
});
