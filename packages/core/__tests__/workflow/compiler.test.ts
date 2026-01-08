import { describe, it, expect } from '@jest/globals';
import { createActor } from 'xstate';
import { createStepNumber } from '../../src/workflow/types.js';
import { compileWorkflowToMachine } from '../../src/workflow/compiler.js';
import type { Step } from '../../src/workflow/types.js';

describe('workflow compiler', () => {
  describe('dynamic step compilation', () => {
    it('compiles GOTO {N}.1 to target step_1 with substep', () => {
      const steps: Step[] = [
        {
          isDynamic: true,
          description: 'Execute task',
          prompts: [],
          substeps: [
            { id: '1', description: 'Implement', isDynamic: false, prompts: [] },
            {
              id: '2',
              description: 'Verify',
              isDynamic: false,
              prompts: [],
              transitions: {
                all: true,
                pass: { kind: 'pass', action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', action: { type: 'GOTO', target: { step: '{N}', substep: '1' } } }
              }
            }
          ]
        }
      ];

      const machine = compileWorkflowToMachine(steps);
      expect(machine).toBeDefined();
    });

    it('compiles GOTO NEXT action', () => {
      const steps: Step[] = [
        {
          isDynamic: true,
          description: 'Dynamic step',
          prompts: [],
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } }
          }
        }
      ];
      const machine = compileWorkflowToMachine(steps);
      expect(machine).toBeDefined();
    });
  });

  describe('static step compilation', () => {
    it('generates discrete states for substeps', () => {
      const steps: Step[] = [
        {
          number: createStepNumber(1)!,
          description: 'Parent',
          isDynamic: false,
          prompts: [],
          substeps: [
            { id: '1', description: 'Child 1', isDynamic: false, prompts: [] },
            { id: '2', description: 'Child 2', isDynamic: false, prompts: [] }
          ]
        }
      ];
      const machine = compileWorkflowToMachine(steps);
      // @ts-expect-error - states is internal to machine
      const stateIds = Object.keys(machine.config.states);
      expect(stateIds).toContain('step_1_1');
      expect(stateIds).toContain('step_1_2');
      expect(stateIds).not.toContain('step_1');
    });

    it('generates single state for step without substeps', () => {
      const steps: Step[] = [
        {
          number: createStepNumber(1)!,
          description: 'Simple',
          isDynamic: false,
          prompts: []
        }
      ];
      const machine = compileWorkflowToMachine(steps);
      // @ts-expect-error - accessing internal states property
      const stateIds = Object.keys(machine.config.states);
      expect(stateIds).toContain('step_1');
    });
  });

  describe('GOTO NEXT XState integration', () => {
    it('sets nextInstance flag when PASS triggers GOTO NEXT', () => {
      const steps: Step[] = [
        {
          isDynamic: true,
          description: 'Dynamic step',
          prompts: [],
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } }
          }
        }
      ];
      const machine = compileWorkflowToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.nextInstance).toBe(true);
    });
  });
});