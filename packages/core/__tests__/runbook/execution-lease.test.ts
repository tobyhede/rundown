import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  classifyExecutionLease,
  commandOutcomeUnknownMessage,
  currentLeaseHolder,
  holdInFlightAttempt,
  refuseUnderLease,
  type ExecutionLease,
  type LeaseDecision,
} from '../../src/runbook/execution-lease.js';
import { deriveExecutionAt } from '../../src/runbook/targeting.js';
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
  // The parent process is alive and is not this one: it stands in for a
  // second `rundown` process. The injected identity reports 'self-start' for
  // every live pid.
  const OTHER = process.ppid;

  it('reads another live process with a matching start id as In Progress', () => {
    const lease = leaseFor(OTHER, 'self-start');
    expect(classifyExecutionLease(RUN, lease, identity)).toEqual({ kind: 'in_progress', lease });
  });

  it('reads another process whose start id differs (a recycled pid) as Interrupted', () => {
    const lease = leaseFor(OTHER, 'an earlier process');
    expect(classifyExecutionLease(RUN, lease, identity)).toEqual({ kind: 'interrupted', lease });
  });

  it('reads a pid with no process as Interrupted', () => {
    const lease = leaseFor(deadPid(), null);
    expect(classifyExecutionLease(RUN, lease, identity).kind).toBe('interrupted');
  });

  it('reads another live process with no recorded start id as In Progress', () => {
    const lease = leaseFor(OTHER, null);
    expect(classifyExecutionLease(RUN, lease, identity).kind).toBe('in_progress');
  });

  it('reads this process as In Progress while one of its turns holds the attempt', () => {
    const lease = leaseFor(process.pid, 'self-start');
    using _held = holdInFlightAttempt(RUN, lease);
    expect(classifyExecutionLease(RUN, lease, identity)).toEqual({ kind: 'in_progress', lease });
  });

  it('reads this process as Interrupted once no turn holds the attempt', () => {
    const lease = leaseFor(process.pid, 'self-start');
    {
      using _held = holdInFlightAttempt(RUN, lease);
    }
    expect(classifyExecutionLease(RUN, lease, identity)).toEqual({ kind: 'interrupted', lease });
  });

  it('reads this process as Interrupted for an attempt it never held', () => {
    const lease = leaseFor(process.pid, 'self-start');
    expect(classifyExecutionLease(RUN, lease, identity).kind).toBe('interrupted');
  });

  it('keys the held attempt by run and attempt', () => {
    const lease = leaseFor(process.pid, 'self-start');
    using _held = holdInFlightAttempt(RUN, lease);
    const otherRun = assertRunId(`rd_${'b'.repeat(32)}`);
    expect(classifyExecutionLease(otherRun, lease, identity).kind).toBe('interrupted');
    expect(classifyExecutionLease(RUN, { ...lease, attempt: 4 }, identity).kind).toBe(
      'interrupted',
    );
  });

  it('describes this process as the holder it would record', () => {
    expect(currentLeaseHolder(identity)).toEqual({ pid: process.pid, startId: 'self-start' });
  });
});

describe('commandOutcomeUnknownMessage', () => {
  it('names the step, the cause, that the command is never repeated, and the token-bearing decisions', () => {
    const message = commandOutcomeUnknownMessage(
      RUN,
      { step: '2', substep: '1' },
      'Timeout of 30000 ms exceeded',
    );
    expect(message).toContain('Step 2.1');
    expect(message).toContain('Interrupted');
    expect(message).toContain('Timeout of 30000 ms exceeded');
    expect(message).toContain('never repeats');
    const suggestions = message.match(/`rundown [^`]*`/g) ?? [];
    expect(suggestions).toEqual([
      '`rundown fail --step 2.1 --token <owner_token>`',
      '`rundown goto <step> --token <owner_token>`',
      '`rundown stop --token <owner_token>`',
    ]);
  });
});

describe('refuseUnderLease', () => {
  const decisions: readonly LeaseDecision[] = [
    'pass',
    'complete',
    'fail',
    'goto',
    'stop',
    'prune',
    'collect',
    'retry',
    'release',
  ];

  it('lets every decision proceed when no lease is held', () => {
    for (const decision of decisions) {
      expect(refuseUnderLease(RUN, CURSOR, null, decision, identity)).toBeUndefined();
    }
  });

  it('refuses every decision while the attempt is In Progress', () => {
    const lease = leaseFor(process.ppid, 'self-start');
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
    const lease = leaseFor(process.ppid, 'an earlier process');
    for (const decision of ['pass', 'complete', 'collect', 'retry'] as const) {
      const refusal = refuseUnderLease(RUN, { step: '2', substep: '1' }, lease, decision, identity);
      expect(refusal).toMatchObject({ kind: 'execution_interrupted', step: '2.1', lease });
      expect(refusal?.message).toContain('rundown fail --step 2.1');
      expect(refusal?.message).toContain('never repeats');
    }
  });

  it('suggests only commands that carry the Owner Token placeholder, never a token', () => {
    const lease = leaseFor(process.ppid, 'an earlier process');
    const message = refuseUnderLease(
      RUN,
      { step: '2', substep: '1' },
      lease,
      'pass',
      identity,
    )?.message;
    expect(message).toContain('`rundown fail --step 2.1 --token <owner_token>`');
    expect(message).toContain('`rundown goto <step> --token <owner_token>`');
    expect(message).toContain('`rundown stop --token <owner_token>`');
    // Every suggested `rundown …` command names the token.
    const suggestions = message?.match(/`rundown [^`]*`/g) ?? [];
    expect(suggestions).toHaveLength(3);
    for (const suggestion of suggestions) expect(suggestion).toContain('--token <owner_token>');
  });

  it('names the step exactly as status does, for every cursor shape', () => {
    const lease = leaseFor(process.ppid, 'self-start');
    const cursors = [{ step: '2' }, { step: '2', substep: '1' }, { step: '2', substep: '' }];
    for (const cursor of cursors) {
      expect(refuseUnderLease(RUN, cursor, lease, 'pass', identity)?.step).toBe(
        deriveExecutionAt(cursor.step, cursor.substep),
      );
    }
  });

  it('lets fail, goto, stop, prune and release decide an Interrupted attempt', () => {
    const lease = leaseFor(process.ppid, 'an earlier process');
    for (const decision of ['fail', 'goto', 'stop', 'prune', 'release'] as const) {
      expect(refuseUnderLease(RUN, CURSOR, lease, decision, identity)).toBeUndefined();
    }
  });
});
