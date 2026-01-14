import { describe, it, expect } from '@jest/globals';
import { createActor } from 'xstate';
import { compileWorkflowToMachine } from '../../src/workflow/compiler.js';
import type { Step } from '../../src/workflow/types.js';

describe('GOTO to self (implicit retry)', () => {
  it('should increment retryCount when GOTO targets current step via {N}', () => {
    // Use name: '{N}' to match how parser represents dynamic steps
    const steps: Step[] = [{
      name: '{N}',
      description: 'Dynamic step',
      isDynamic: true,
      transitions: {
        all: false,
        pass: { kind: 'pass', action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', action: { type: 'GOTO', target: { step: '{N}' } } }
      }
    }];

    const machine = compileWorkflowToMachine(steps);
    const actor = createActor(machine);
    actor.start();

    // Initial state - state ID is step_{N} (string, not nested object)
    expect(actor.getSnapshot().context.retryCount).toBe(0);
    expect(actor.getSnapshot().value).toBe('step_{N}');

    // First FAIL - should increment retryCount (GOTO to self)
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.retryCount).toBe(1);
    expect(actor.getSnapshot().value).toBe('step_{N}');

    // Second FAIL - should increment again
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.retryCount).toBe(2);

    // Third FAIL - should increment again
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.retryCount).toBe(3);
  });

  it('should increment retryCount when GOTO targets current step by numeric name', () => {
    // Tests non-dynamic step that uses GOTO to itself by step number
    const steps: Step[] = [{
      name: '1',
      description: 'Retry Step',
      isDynamic: false,
      transitions: {
        all: false,
        pass: { kind: 'pass', action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', action: { type: 'GOTO', target: { step: '1' } } }
      }
    }];

    const machine = compileWorkflowToMachine(steps);
    const actor = createActor(machine);
    actor.start();

    expect(actor.getSnapshot().context.retryCount).toBe(0);
    expect(actor.getSnapshot().value).toBe('step_1');

    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.retryCount).toBe(1);
    expect(actor.getSnapshot().value).toBe('step_1');

    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.retryCount).toBe(2);
  });

  it('should reset retryCount when GOTO targets different step', () => {
    const steps: Step[] = [
      {
        name: '1',
        title: 'Step One',
        transitions: {
          all: false,
          pass: { kind: 'pass', action: { type: 'CONTINUE' } },
          fail: { kind: 'fail', action: { type: 'GOTO', target: { step: '2' } } }
        }
      },
      {
        name: '2',
        title: 'Step Two',
        transitions: {
          all: false,
          pass: { kind: 'pass', action: { type: 'COMPLETE' } },
          fail: { kind: 'fail', action: { type: 'STOP' } }
        }
      }
    ];

    const machine = compileWorkflowToMachine(steps);
    const actor = createActor(machine);
    actor.start();

    // Simulate some retries
    actor.send({ type: 'RETRY' });
    actor.send({ type: 'RETRY' });
    expect(actor.getSnapshot().context.retryCount).toBe(2);

    // FAIL with GOTO to different step should reset
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.retryCount).toBe(0);
    expect(actor.getSnapshot().value).toBe('step_2');
  });

  it('should increment retryCount when GOTO targets same step and substep', () => {
    // Transitions must be defined at substep level when step has substeps
    const steps: Step[] = [{
      name: '1',
      description: 'Step with substeps',
      substeps: [
        {
          id: 'a',
          title: 'Substep A',
          transitions: {
            all: false,
            pass: { kind: 'pass', action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', action: { type: 'GOTO', target: { step: '1', substep: 'a' } } }
          }
        },
        { id: 'b', title: 'Substep B' }
      ]
    }];

    const machine = compileWorkflowToMachine(steps);
    const actor = createActor(machine);
    actor.start();

    // Initial state - starts at step 1 substep a
    expect(actor.getSnapshot().context.retryCount).toBe(0);
    expect(actor.getSnapshot().value).toBe('step_1_a');

    // FAIL with GOTO to same step+substep should increment
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.retryCount).toBe(1);
    expect(actor.getSnapshot().value).toBe('step_1_a');

    // Second FAIL should increment again
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.retryCount).toBe(2);
  });

  it('should reset retryCount when GOTO targets same step but different substep', () => {
    // Transitions must be defined at substep level when step has substeps
    const steps: Step[] = [{
      name: '1',
      description: 'Step with substeps',
      substeps: [
        {
          id: 'a',
          title: 'Substep A',
          transitions: {
            all: false,
            pass: { kind: 'pass', action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', action: { type: 'GOTO', target: { step: '1', substep: 'b' } } }
          }
        },
        { id: 'b', title: 'Substep B' }
      ]
    }];

    const machine = compileWorkflowToMachine(steps);
    const actor = createActor(machine);
    actor.start();

    // Initial state - starts at step 1 substep a
    expect(actor.getSnapshot().context.retryCount).toBe(0);
    expect(actor.getSnapshot().value).toBe('step_1_a');

    // Simulate some retries
    actor.send({ type: 'RETRY' });
    actor.send({ type: 'RETRY' });
    expect(actor.getSnapshot().context.retryCount).toBe(2);

    // FAIL with GOTO to same step but different substep should reset
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.retryCount).toBe(0);
    expect(actor.getSnapshot().value).toBe('step_1_b');
  });
});
