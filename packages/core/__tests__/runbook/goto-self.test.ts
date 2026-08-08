import { describe, it, expect } from '@jest/globals';
import { createActor } from 'xstate';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import type { ResolvedStep } from '../../src/runbook/types.js';

describe('GOTO to self (bounded re-execution)', () => {
  it('should increment selfGotoCount when GOTO targets current step by numeric name', () => {
    // Tests non-dynamic step that uses GOTO to itself by step number
    const steps: ResolvedStep[] = [
      {
        kind: 'base',
        name: '1',
        description: 'Retry Step',
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'GOTO', target: { step: '1' } } },
        },
      },
    ];

    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine);
    actor.start();

    expect(actor.getSnapshot().context.selfGotoCount).toBe(0);
    expect(actor.getSnapshot().value).toEqual({ 'step::1': 'idle' });

    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.selfGotoCount).toBe(1);
    expect(actor.getSnapshot().value).toEqual({ 'step::1': 'idle' });

    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.selfGotoCount).toBe(2);
    // The author's RETRY budget is a separate counter and no loop pass draws
    // on it — the two were one field, and each spent the other's budget.
    expect(actor.getSnapshot().context.retryCount).toBe(0);
  });

  it('should reset both counters when GOTO targets a different step', () => {
    const steps: ResolvedStep[] = [
      {
        kind: 'base',
        name: '1',
        description: 'Step One',
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'GOTO', target: { step: '2' } } },
        },
      },
      {
        kind: 'base',
        name: '2',
        description: 'Step Two',
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
        },
      },
    ];

    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine);
    actor.start();

    // Simulate some retries
    actor.send({ type: 'RETRY' });
    actor.send({ type: 'RETRY' });
    expect(actor.getSnapshot().context.retryCount).toBe(2);

    // FAIL with GOTO to different step should reset
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.retryCount).toBe(0);
    expect(actor.getSnapshot().context.selfGotoCount).toBe(0);
    expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
  });

  it('should increment selfGotoCount when GOTO targets same step and substep', () => {
    // Step-level transitions mirror parser DEFAULT_TRANSITIONS (PASS CONTINUE,
    // FAIL STOP). Substep-level transitions drive the actual behavior here.
    const steps: ResolvedStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Step with substeps',
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
        },
        substeps: [
          {
            id: 'a',
            description: 'Substep A',
            transitions: {
              pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
              fail: {
                kind: 'fail',
                retry: 0,
                action: { type: 'GOTO', target: { step: '1', substep: 'a' } },
              },
            },
          },
          {
            id: 'b',
            description: 'Substep B',
            transitions: {
              pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
              fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
            },
          },
        ],
      },
    ];

    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine);
    actor.start();

    // Initial state - starts at step 1 substep a
    expect(actor.getSnapshot().context.selfGotoCount).toBe(0);
    expect(actor.getSnapshot().value).toEqual({ 'step::1::a': 'idle' });

    // FAIL with GOTO to same step+substep should increment
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.selfGotoCount).toBe(1);
    expect(actor.getSnapshot().value).toEqual({ 'step::1::a': 'idle' });

    // Second FAIL should increment again
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.selfGotoCount).toBe(2);
    expect(actor.getSnapshot().context.retryCount).toBe(0);
  });

  it('should reset both counters when GOTO targets same step but different substep', () => {
    // Step-level transitions mirror parser DEFAULT_TRANSITIONS (PASS CONTINUE,
    // FAIL STOP). Substep-level transitions drive the actual behavior here.
    const steps: ResolvedStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Step with substeps',
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
        },
        substeps: [
          {
            id: 'a',
            description: 'Substep A',
            transitions: {
              pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
              fail: {
                kind: 'fail',
                retry: 0,
                action: { type: 'GOTO', target: { step: '1', substep: 'b' } },
              },
            },
          },
          {
            id: 'b',
            description: 'Substep B',
            transitions: {
              pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
              fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
            },
          },
        ],
      },
    ];

    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine);
    actor.start();

    // Initial state - starts at step 1 substep a
    expect(actor.getSnapshot().context.retryCount).toBe(0);
    expect(actor.getSnapshot().value).toEqual({ 'step::1::a': 'idle' });

    // Simulate some retries
    actor.send({ type: 'RETRY' });
    actor.send({ type: 'RETRY' });
    expect(actor.getSnapshot().context.retryCount).toBe(2);

    // FAIL with GOTO to same step but different substep should reset
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.retryCount).toBe(0);
    expect(actor.getSnapshot().context.selfGotoCount).toBe(0);
    expect(actor.getSnapshot().value).toEqual({ 'step::1::b': 'idle' });
  });
});
