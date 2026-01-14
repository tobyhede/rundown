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
});
