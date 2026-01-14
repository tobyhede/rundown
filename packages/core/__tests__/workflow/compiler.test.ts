import { describe, it, expect } from '@jest/globals';
import { createActor } from 'xstate';
import { compileWorkflowToMachine } from '../../src/workflow/compiler.js';
import type { Step } from '../../src/workflow/types.js';

describe('workflow compiler', () => {
  describe('dynamic step compilation', () => {
    it('compiles GOTO {N}.1 to target step_1 with substep', () => {
      const steps: Step[] = [
        {
          name: '{N}',
          isDynamic: true,
          description: 'Execute task',
          substeps: [
            { id: '1', description: 'Implement', isDynamic: false },
            {
              id: '2',
              description: 'Verify',
              isDynamic: false,
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
          name: '{N}',
          isDynamic: true,
          description: 'Dynamic step',
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
          name: '1',
          description: 'Parent',
          isDynamic: false,
          substeps: [
            { id: '1', description: 'Child 1', isDynamic: false },
            { id: '2', description: 'Child 2', isDynamic: false }
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
          name: '1',
          description: 'Simple',
          isDynamic: false
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
          name: '{N}',
          isDynamic: true,
          description: 'Dynamic step',
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

  describe('GOTO NEXT from dynamic substep', () => {
    it('advances substep only when unqualified GOTO NEXT from {N}.{n}', () => {
      const steps: Step[] = [
        {
          name: '{N}',
          isDynamic: true,
          description: 'Dynamic step with dynamic substep',
          substeps: [
            {
              id: '{n}',
              isDynamic: true,
              description: 'Dynamic substep',
              transitions: {
                all: true,
                pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT' } } },
                fail: { kind: 'fail', action: { type: 'STOP' } }
              }
            }
          ]
        }
      ];
      const machine = compileWorkflowToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.nextSubstepInstance).toBe(true);
      expect(snapshot.context.nextInstance).toBeUndefined();
    });

    it('advances step when unqualified GOTO NEXT from {N}.1 (static substep)', () => {
      const steps: Step[] = [
        {
          name: '{N}',
          isDynamic: true,
          description: 'Dynamic step with static substep',
          substeps: [
            {
              id: '1',
              isDynamic: false,
              description: 'Static substep',
              transitions: {
                all: true,
                pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT' } } },
                fail: { kind: 'fail', action: { type: 'STOP' } }
              }
            }
          ]
        }
      ];
      const machine = compileWorkflowToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.nextInstance).toBe(true);
      expect(snapshot.context.nextSubstepInstance).toBeUndefined();
    });

    it('advances substep when unqualified GOTO NEXT from 1.{n} (no {N} step required)', () => {
      // Key case: static step 1 with dynamic substep - NO {N} step exists
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Static step with dynamic substep',
          substeps: [
            {
              id: '{n}',
              isDynamic: true,
              description: 'Dynamic substep',
              transitions: {
                all: true,
                pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT' } } },
                fail: { kind: 'fail', action: { type: 'STOP' } }
              }
            }
          ]
        }
      ];
      const machine = compileWorkflowToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      // Should advance substep, not require/find {N} step
      expect(snapshot.context.nextSubstepInstance).toBe(true);
      expect(snapshot.context.nextInstance).toBeUndefined();
    });

    it('advances substep when qualified GOTO NEXT {N}.{n} is used', () => {
      const steps: Step[] = [
        {
          name: '{N}',
          isDynamic: true,
          description: 'Dynamic step',
          substeps: [
            {
              id: '{n}',
              isDynamic: true,
              description: 'Dynamic substep',
              transitions: {
                all: true,
                pass: {
                  kind: 'pass',
                  action: {
                    type: 'GOTO',
                    target: { step: 'NEXT', qualifier: { step: '{N}', substep: '{n}' } }
                  }
                },
                fail: { kind: 'fail', action: { type: 'STOP' } }
              }
            }
          ]
        }
      ];
      const machine = compileWorkflowToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.nextSubstepInstance).toBe(true);
      expect(snapshot.context.nextInstance).toBeUndefined();
    });

    it('advances step when qualified GOTO NEXT {N} is used', () => {
      const steps: Step[] = [
        {
          name: '{N}',
          isDynamic: true,
          description: 'Dynamic step',
          substeps: [
            {
              id: '{n}',
              isDynamic: true,
              description: 'Dynamic substep',
              transitions: {
                all: true,
                pass: {
                  kind: 'pass',
                  action: {
                    type: 'GOTO',
                    target: { step: 'NEXT', qualifier: { step: '{N}' } }
                  }
                },
                fail: { kind: 'fail', action: { type: 'STOP' } }
              }
            }
          ]
        }
      ];
      const machine = compileWorkflowToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.nextInstance).toBe(true);
      expect(snapshot.context.nextSubstepInstance).toBeUndefined();
    });

    it('advances substep when qualified GOTO NEXT 1.{n} without {N} step', () => {
      // Key case: qualified GOTO NEXT X.{n} should work without {N} step
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Static step with dynamic substep',
          substeps: [
            {
              id: '{n}',
              isDynamic: true,
              description: 'Dynamic substep',
              transitions: {
                all: true,
                pass: {
                  kind: 'pass',
                  action: {
                    type: 'GOTO',
                    target: { step: 'NEXT', qualifier: { step: '1', substep: '{n}' } }
                  }
                },
                fail: { kind: 'fail', action: { type: 'STOP' } }
              }
            }
          ]
        }
      ];
      const machine = compileWorkflowToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      // Should advance substep in step 1, no {N} step required
      expect(snapshot.context.nextSubstepInstance).toBe(true);
      expect(snapshot.context.nextInstance).toBeUndefined();
    });
  });

  describe('CONTINUE with named steps', () => {
    it('skips named step and returns COMPLETE when no more numbered steps', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Setup',
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', action: { type: 'STOP' } }
          }
        },
        {
          name: 'ErrorHandler',
          isDynamic: false,
          description: 'Named step - should be skipped by CONTINUE'
        }
      ];
      const machine = compileWorkflowToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // PASS on step 1 should go to COMPLETE, not ErrorHandler
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
    });

    it('continues to next numbered step, skipping named steps in between', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'First',
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', action: { type: 'STOP' } }
          }
        },
        {
          name: 'ErrorHandler',
          isDynamic: false,
          description: 'Named - skipped'
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Second'
        }
      ];
      const machine = compileWorkflowToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('step_2');
    });
  });

  describe('GOTO {N} resolution', () => {
    it('targets dynamic step without substep suffix when step has no substeps', () => {
      const steps: Step[] = [
        {
          name: '{N}',
          isDynamic: true,
          description: 'Dynamic step without substeps',
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT' } } },
            fail: { kind: 'fail', action: { type: 'GOTO', target: { step: 'Recovery' } } }
          }
        },
        {
          name: 'Recovery',
          isDynamic: false,
          description: 'Recovery step',
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } }
          }
        }
      ];
      const machine = compileWorkflowToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Fail -> Recovery
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('step_Recovery');

      // Pass -> GOTO {N} should go to step_{N}, not step_{N}_1
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_{N}');
    });
  });

  describe('GOTO NEXT with non-first dynamic step', () => {
    it('targets dynamic step even when static step is first', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Static setup step',
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', action: { type: 'STOP' } }
          }
        },
        {
          name: '{N}',
          isDynamic: true,
          description: 'Dynamic step',
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

      // Pass step 1 -> go to {N}
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_{N}');

      // Pass {N} -> GOTO NEXT should stay on {N} with nextInstance flag
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('step_{N}');
      expect(snapshot.context.nextInstance).toBe(true);
    });

    it('returns STOPPED when GOTO NEXT used without dynamic step', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Static step with invalid GOTO NEXT',
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

      // GOTO NEXT without dynamic step should fail safely
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
    });
  });

  describe('flag clearing in terminal transitions', () => {
    it('clears flags when transition reaches COMPLETE', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Step that completes',
          substeps: [
            {
              id: '1',
              isDynamic: false,
              description: 'Substep',
              transitions: {
                all: true,
                pass: { kind: 'pass', action: { type: 'COMPLETE' } },
                fail: { kind: 'fail', action: { type: 'STOP' } }
              }
            }
          ]
        }
      ];
      const machine = compileWorkflowToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
      expect(snapshot.context.nextInstance).toBeUndefined();
      expect(snapshot.context.nextSubstepInstance).toBeUndefined();
    });

    it('clears flags when transition reaches STOPPED', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Step that stops',
          substeps: [
            {
              id: '1',
              isDynamic: false,
              description: 'Substep',
              transitions: {
                all: true,
                pass: { kind: 'pass', action: { type: 'STOP' } },
                fail: { kind: 'fail', action: { type: 'STOP' } }
              }
            }
          ]
        }
      ];
      const machine = compileWorkflowToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      expect(snapshot.context.nextInstance).toBeUndefined();
      expect(snapshot.context.nextSubstepInstance).toBeUndefined();
    });
  });
});
