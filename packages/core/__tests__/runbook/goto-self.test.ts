import { describe, it, expect } from '@jest/globals';
import { createActor } from 'xstate';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import type { Step } from '../../src/runbook/types.js';

describe('GOTO to self (implicit retry)', () => {
  it('should increment retryCount when GOTO targets current step by numeric name', () => {
    // Tests non-dynamic step that uses GOTO to itself by step number
    const steps: Step[] = [
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

    expect(actor.getSnapshot().context.retryCount).toBe(0);
    expect(actor.getSnapshot().value).toBe('step::1');

    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.retryCount).toBe(1);
    expect(actor.getSnapshot().value).toBe('step::1');

    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.retryCount).toBe(2);
  });

  it('should reset retryCount when GOTO targets different step', () => {
    const steps: Step[] = [
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
    expect(actor.getSnapshot().value).toBe('step::2');
  });

  it('should increment retryCount when GOTO targets same step and substep', () => {
    // Transitions must be defined at substep level when step has substeps
    const steps: Step[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Step with substeps',
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
    expect(actor.getSnapshot().context.retryCount).toBe(0);
    expect(actor.getSnapshot().value).toBe('step::1::a');

    // FAIL with GOTO to same step+substep should increment
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.retryCount).toBe(1);
    expect(actor.getSnapshot().value).toBe('step::1::a');

    // Second FAIL should increment again
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.retryCount).toBe(2);
  });

  it('should reset retryCount when GOTO targets same step but different substep', () => {
    // Transitions must be defined at substep level when step has substeps
    const steps: Step[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Step with substeps',
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
    expect(actor.getSnapshot().value).toBe('step::1::a');

    // Simulate some retries
    actor.send({ type: 'RETRY' });
    actor.send({ type: 'RETRY' });
    expect(actor.getSnapshot().context.retryCount).toBe(2);

    // FAIL with GOTO to same step but different substep should reset
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.retryCount).toBe(0);
    expect(actor.getSnapshot().value).toBe('step::1::b');
  });
});
