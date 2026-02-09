import { describe, it, expect } from '@jest/globals';
import { createActor } from 'xstate';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import type { Step } from '../../src/runbook/types.js';


describe('runbook compiler', () => {
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
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'GOTO', target: { step: '{N}', substep: '1' } } }
              }
            }
          ]
        }
      ];

      const machine = compileRunbookToMachine(steps);
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
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: 'NEXT' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];
      const machine = compileRunbookToMachine(steps);
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
      const machine = compileRunbookToMachine(steps);
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
      const machine = compileRunbookToMachine(steps);
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
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: 'NEXT' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];
      const machine = compileRunbookToMachine(steps);
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
                pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: 'NEXT' } } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        }
      ];
      const machine = compileRunbookToMachine(steps);
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
                pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: 'NEXT' } } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        }
      ];
      const machine = compileRunbookToMachine(steps);
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
                pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: 'NEXT' } } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        }
      ];
      const machine = compileRunbookToMachine(steps);
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
                  retry: 0,
                  action: {
                    type: 'GOTO',
                    target: { step: 'NEXT', qualifier: { step: '{N}', substep: '{n}' } }
                  }
                },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        }
      ];
      const machine = compileRunbookToMachine(steps);
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
                  retry: 0,
                  action: {
                    type: 'GOTO',
                    target: { step: 'NEXT', qualifier: { step: '{N}' } }
                  }
                },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        }
      ];
      const machine = compileRunbookToMachine(steps);
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
                  retry: 0,
                  action: {
                    type: 'GOTO',
                    target: { step: 'NEXT', qualifier: { step: '1', substep: '{n}' } }
                  }
                },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        }
      ];
      const machine = compileRunbookToMachine(steps);
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
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: 'ErrorHandler',
          isDynamic: false,
          description: 'Named step - should be skipped by CONTINUE'
        }
      ];
      const machine = compileRunbookToMachine(steps);
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
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
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
      const machine = compileRunbookToMachine(steps);
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
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: 'NEXT' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'GOTO', target: { step: 'Recovery' } } }
          }
        },
        {
          name: 'Recovery',
          isDynamic: false,
          description: 'Recovery step',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '{N}' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];
      const machine = compileRunbookToMachine(steps);
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
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '{N}',
          isDynamic: true,
          description: 'Dynamic step',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: 'NEXT' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];
      const machine = compileRunbookToMachine(steps);
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
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: 'NEXT' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // GOTO NEXT without dynamic step should fail safely
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
    });
  });

  describe('lastAction preservation (bug fix)', () => {
    /**
     * These tests verify that the lastAction context field is correctly set
     * to reflect the ACTUAL transition defined in the runbook, not computed
     * from step number changes. This was a bug where CONTINUE transitions
     * were incorrectly displayed as "GOTO X" when steps weren't sequential.
     */

    it('sets lastAction to CONTINUE for CONTINUE transitions', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Step 2'
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.lastAction).toEqual({ type: 'CONTINUE' });
    });

    it('sets lastAction to CONTINUE even when jumping to non-sequential step via substeps', () => {
      // This is the key bug case: step 2 -> step 3.1 with CONTINUE
      // Previously displayed as "GOTO 3.1" because step numbers weren't sequential
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Step 1',
          substeps: [
            { id: '1', description: 'Substep 1.1', isDynamic: false },
            {
              id: '2',
              description: 'Substep 1.2',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Step 2 (no substeps)'
        },
        {
          name: '3',
          isDynamic: false,
          description: 'Step 3',
          substeps: [
            { id: '1', description: 'Substep 3.1', isDynamic: false },
            { id: '2', description: 'Substep 3.2', isDynamic: false }
          ]
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Start at 1.1, pass to 1.2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'CONTINUE' });

      // Pass 1.2, should CONTINUE to step 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'CONTINUE' });
      expect(actor.getSnapshot().value).toBe('step_2');

      // Pass step 2, should CONTINUE to step 3.1
      // This was the bug: showed "GOTO 3.1" but should be "CONTINUE"
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'CONTINUE' });
      expect(actor.getSnapshot().value).toBe('step_3_1');
    });

    it('sets lastAction to STOP for STOP transitions', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'FAIL' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.lastAction).toEqual({ type: 'STOP' });
    });

    it('sets lastAction to COMPLETE for COMPLETE transitions', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.lastAction).toEqual({ type: 'COMPLETE' });
    });

    it('sets lastAction to GOTO X for explicit GOTO transitions', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'GOTO', target: { step: 'ErrorHandler' } } }
          }
        },
        {
          name: 'ErrorHandler',
          isDynamic: false,
          description: 'Error handler'
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'FAIL' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: 'ErrorHandler' });
    });

    it('sets lastAction to GOTO X.Y for GOTO with substep', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2', substep: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Step 2',
          substeps: [
            { id: '1', description: 'Substep 2.1', isDynamic: false },
            { id: '2', description: 'Substep 2.2', isDynamic: false },
            { id: '3', description: 'Substep 2.3', isDynamic: false }
          ]
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: '2', substep: '3' });
    });

    it('sets lastAction to RETRY for RETRY transitions', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: {
              kind: 'fail',
              retry: 3,
              action: { type: 'STOP' }
            }
          }
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'FAIL' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.lastAction).toEqual({ type: 'RETRY' });
      expect(snapshot.context.retryCount).toBe(1);
    });

    it('sets lastAction to GOTO NEXT for dynamic transitions', () => {
      const steps: Step[] = [
        {
          name: '{N}',
          isDynamic: true,
          description: 'Dynamic step',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: 'NEXT' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO_NEXT' });
    });

    it('sets lastAction for GOTO event (external jump)', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Step 1'
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Step 2'
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'GOTO', target: { step: '2' } });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: '2' });
    });

    it('sets lastAction for explicit RETRY event', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Step 1'
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'RETRY' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.lastAction).toEqual({ type: 'RETRY' });
    });

    it('preserves lastAction with {N} placeholder for dynamic GOTO', () => {
      const steps: Step[] = [
        {
          name: '{N}',
          isDynamic: true,
          description: 'Dynamic step',
          substeps: [
            {
              id: '1',
              isDynamic: false,
              description: 'First substep',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '{N}', substep: '3' } } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            },
            { id: '2', isDynamic: false, description: 'Second substep' },
            { id: '3', isDynamic: false, description: 'Third substep' }
          ]
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      // Should preserve {N} for CLI to resolve with actual instance
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: '{N}', substep: '3' });
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
                pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        }
      ];
      const machine = compileRunbookToMachine(steps);
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
                pass: { kind: 'pass', retry: 0, action: { type: 'STOP' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      expect(snapshot.context.nextInstance).toBeUndefined();
      expect(snapshot.context.nextSubstepInstance).toBeUndefined();
    });
  });

  describe('resolveSimpleGotoTarget helper', () => {
    it('resolves numeric step target to correct state ID', () => {
      // This tests the behavior indirectly through GOTO action
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Step 2',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();

      expect(snapshot.value).toBe('step_2');
    });
  });

  describe('RETRY as transition property', () => {
    it('stays at current step during retry, then executes action', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 2, action: { type: 'GOTO', target: { step: '2' } } }
          }
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Step 2',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // First FAIL: stay at step 1 (retry 1/2)
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('step_1');
      expect(actor.getSnapshot().context.retryCount).toBe(1);

      // Second FAIL: stay at step 1 (retry 2/2)
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('step_1');
      expect(actor.getSnapshot().context.retryCount).toBe(2);

      // Third FAIL: exhausted, GOTO step 2
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('step_2');
      expect(actor.getSnapshot().context.retryCount).toBe(0);
    });

    it('works the same for PASS with retry', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 2, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // First PASS: stay (retry 1/2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_1');

      // Second PASS: stay (retry 2/2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_1');

      // Third PASS: exhausted, COMPLETE
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('COMPLETE');
    });
  });

  describe('RETRY with GOTO (loop pattern)', () => {
    it('stays at step during retries, then executes GOTO when exhausted', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Run Tests',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } }
          }
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Recovery and Fix',
          transitions: {
            all: true,
            pass: {
              kind: 'pass',
              retry: 2,
              action: { type: 'GOTO', target: { step: '1' } }
            },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '3',
          isDynamic: false,
          description: 'Commit Changes',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Step 1 FAIL -> CONTINUE to step 2
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('step_2');

      // Step 2 PASS -> RETRY GOTO 1 (should stay at step 2 for retry 1/2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_2');
      expect(actor.getSnapshot().context.retryCount).toBe(1);
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'RETRY' });

      // Step 2 PASS again -> RETRY GOTO 1 (should stay at step 2 for retry 2/2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_2');
      expect(actor.getSnapshot().context.retryCount).toBe(2);

      // Step 2 PASS again -> exhausted, execute GOTO to step 1
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('step_1');
      expect(snapshot.context.retryCount).toBe(0);
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: '1' });
    });

    it('STOPs when RETRY+GOTO exhausts retries', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Run Tests',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } }
          }
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Recovery and Fix',
          transitions: {
            all: true,
            pass: {
              kind: 'pass',
              retry: 2,
              action: { type: 'GOTO', target: { step: '1' } }
            },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '3',
          isDynamic: false,
          description: 'Commit Changes',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Step 1 FAIL -> step 2
      actor.send({ type: 'FAIL' });
      // Step 2 PASS -> RETRY (1/2), stay at step 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_2');
      expect(actor.getSnapshot().context.retryCount).toBe(1);

      // Step 2 PASS -> RETRY (2/2), stay at step 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_2');
      expect(actor.getSnapshot().context.retryCount).toBe(2);

      // Step 2 PASS -> retries exhausted, execute GOTO to step 1
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_1');

      // Step 1 FAIL -> step 2
      actor.send({ type: 'FAIL' });
      // Step 2 PASS -> fresh RETRY cycle, RETRY (1/2), stay at step 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_2');
      expect(actor.getSnapshot().context.retryCount).toBe(1);
    });
  });

  describe('FOR loop compilation', () => {
    it('iterates FOR loop the correct number of times via CONTINUE', () => {
      const steps: Step[] = [
        {
          name: '2',
          isDynamic: false,
          description: 'Setup',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '3',
          isDynamic: false,
          forClause: { start: 1, end: 3 },
          description: 'Process batches',
          substeps: [
            {
              id: '1',
              description: 'Fetch',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            },
            {
              id: '2',
              description: 'Process',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        },
        {
          name: '4',
          isDynamic: false,
          description: 'Commit',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Start at step_2, PASS to enter FOR step
      expect(actor.getSnapshot().value).toBe('step_2');
      actor.send({ type: 'PASS' }); // step_2 → step_3_1 (FOR initialized)

      expect(actor.getSnapshot().value).toBe('step_3_1');
      expect(actor.getSnapshot().context.forIteration).toBe(1);
      expect(actor.getSnapshot().context.forEnd).toBe(3);

      // Iteration 1: step_3_1 → step_3_2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_3_2');

      // Iteration 1: step_3_2 → loop back to step_3_1 (iteration 2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_3_1');
      expect(actor.getSnapshot().context.forIteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

      // Iteration 2: step_3_1 → step_3_2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_3_2');

      // Iteration 2: step_3_2 → loop back to step_3_1 (iteration 3)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_3_1');
      expect(actor.getSnapshot().context.forIteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);

      // Iteration 3: step_3_1 → step_3_2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_3_2');

      // Iteration 3: step_3_2 → exit loop → step_4
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_4');
      expect(actor.getSnapshot().context.forIteration).toBeUndefined();
      expect(actor.getSnapshot().context.forStart).toBeUndefined();
      expect(actor.getSnapshot().context.forEnd).toBeUndefined();
    });

    it('initializes FOR context when FOR step is the first state', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          forClause: { start: 1, end: 2 },
          description: 'First step is FOR',
          substeps: [
            {
              id: '1',
              description: 'Process',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Machine starts at step_1_1 (first substep of FOR step)
      expect(actor.getSnapshot().value).toBe('step_1_1');
      expect(actor.getSnapshot().context.forIteration).toBe(1);
      expect(actor.getSnapshot().context.forStart).toBe(1);
      expect(actor.getSnapshot().context.forEnd).toBe(2);

      // Iteration 1: PASS → loop back (iteration 2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_1_1');
      expect(actor.getSnapshot().context.forIteration).toBe(2);

      // Iteration 2: PASS → exit loop
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_2');
      expect(actor.getSnapshot().context.forIteration).toBeUndefined();
    });

    it('exits loop immediately when start equals end (single iteration)', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          forClause: { start: 5, end: 5 },
          description: 'Single iteration',
          substeps: [
            {
              id: '1',
              description: 'Process',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().value).toBe('step_1_1');
      expect(actor.getSnapshot().context.forIteration).toBe(5);

      // Single pass should exit loop (5 is not < 5)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_2');
      expect(actor.getSnapshot().context.forIteration).toBeUndefined();
    });

    it('stores named variable in FOR context', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          forClause: { variable: 'batch', start: 1, end: 2 },
          description: 'Named loop variable',
          substeps: [
            {
              id: '1',
              description: 'Process',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().context.forVariable).toBe('batch');
    });

    it('records iteration results including failures', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          forClause: { start: 1, end: 4 },
          description: 'Test with failures',
          substeps: [
            {
              id: '1',
              description: 'Single substep',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } }
              }
            }
          ]
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: PASS (forIteration=1, loop back)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().context.forIteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

      // Iteration 2: FAIL (forIteration=2, loop back)
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().context.forIteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'fail']);

      // Iteration 3: PASS (forIteration=3, loop back)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().context.forIteration).toBe(4);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'fail', 'pass']);

      // Iteration 4: PASS (forIteration=4, 4 < 4? NO, exit loop — records final result)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_2');
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'fail', 'pass', 'pass']);
    });

    it('handles FOR step without substeps gracefully', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          forClause: { start: 1, end: 2 },
          description: 'For without substeps',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Next',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Should handle FOR on step without substeps (treated as single state)
      actor.send({ type: 'PASS' });
      // Should move to step 2 (next step)
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('step_2');
    });

    it('initializes FOR context when GOTO enters FOR step', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Start',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Skipped'
        },
        {
          name: '3',
          isDynamic: false,
          forClause: { start: 1, end: 2 },
          description: 'FOR entered via GOTO',
          substeps: [
            {
              id: '1',
              description: 'Process',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        },
        {
          name: '4',
          isDynamic: false,
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // GOTO from step 1 to step 3
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_3_1');
      expect(actor.getSnapshot().context.forIteration).toBe(1);
      expect(actor.getSnapshot().context.forEnd).toBe(2);

      // Iteration 1: PASS → loop back
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_3_1');
      expect(actor.getSnapshot().context.forIteration).toBe(2);

      // Iteration 2: PASS → exit loop
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_4');
      expect(actor.getSnapshot().context.forIteration).toBeUndefined();
    });

    it('NEXT skips remaining substeps and advances to next iteration', () => {
      const steps: Step[] = [
        {
          name: '2',
          isDynamic: false,
          description: 'Setup',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '3',
          isDynamic: false,
          forClause: { start: 1, end: 3 },
          description: 'Process batches',
          substeps: [
            {
              id: '1',
              description: 'Fetch',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'NEXT' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            },
            {
              id: '2',
              description: 'Process (skipped by NEXT)',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        },
        {
          name: '4',
          isDynamic: false,
          description: 'Commit',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Setup step → FOR step first substep
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_3_1');
      expect(actor.getSnapshot().context.forIteration).toBe(1);

      // Iteration 1: PASS on substep 1 → NEXT → skip substep 2, go to iteration 2's substep 1
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_3_1'); // Loop back to first substep
      expect(actor.getSnapshot().context.forIteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

      // Iteration 2: PASS → NEXT → iteration 3
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_3_1');
      expect(actor.getSnapshot().context.forIteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);

      // Iteration 3 (last): PASS → NEXT → exit loop
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_4'); // Exit to next step
      expect(actor.getSnapshot().context.forIteration).toBeUndefined();
    });

    it('BREAK exits loop immediately regardless of remaining iterations', () => {
      const steps: Step[] = [
        {
          name: '2',
          isDynamic: false,
          description: 'Setup',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '3',
          isDynamic: false,
          forClause: { start: 1, end: 5 },
          description: 'Process batches',
          substeps: [
            {
              id: '1',
              description: 'Check',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'BREAK' } }
              }
            },
            {
              id: '2',
              description: 'Process',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        },
        {
          name: '4',
          isDynamic: false,
          description: 'Commit',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Setup → FOR
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_3_1');
      expect(actor.getSnapshot().context.forIteration).toBe(1);

      // Iteration 1: FAIL on substep 1 → BREAK → exit loop to step 4
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('step_4');
      expect(actor.getSnapshot().context.forIteration).toBeUndefined();
      expect(actor.getSnapshot().context.iterationResults).toEqual(['fail']);
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'BREAK' });
    });

    it('NEXT records iteration results correctly across iterations', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          forClause: { start: 1, end: 3 },
          description: 'Loop with NEXT on fail',
          substeps: [
            {
              id: '1',
              description: 'Step',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'NEXT' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'NEXT' } }
              }
            }
          ]
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: FAIL → NEXT
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().context.forIteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['fail']);

      // Iteration 2: PASS → NEXT
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().context.forIteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['fail', 'pass']);

      // Iteration 3 (last): PASS → NEXT → exit
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_2');
      expect(actor.getSnapshot().context.iterationResults).toEqual(['fail', 'pass', 'pass']);
    });

    it('BREAK records the final iteration result before exiting', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          forClause: { start: 1, end: 5 },
          description: 'Loop with early break',
          substeps: [
            {
              id: '1',
              description: 'Increment',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            },
            {
              id: '2',
              description: 'Check and break',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'BREAK' } }
              }
            }
          ]
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: PASS → loop back
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_1_2');
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_1_1');
      expect(actor.getSnapshot().context.forIteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

      // Iteration 2: PASS → PASS → loop back
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_1_2');
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_1_1');
      expect(actor.getSnapshot().context.forIteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);

      // Iteration 3: PASS → FAIL (BREAK)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_1_2');
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('step_2');
      expect(actor.getSnapshot().context.forIteration).toBeUndefined();
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass', 'fail']);
    });

    it('NEXT outside FOR loop goes to STOPPED', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'No FOR clause',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'NEXT' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'NEXT' });
    });

    it('BREAK outside FOR loop goes to STOPPED', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'No FOR clause',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'BREAK' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'BREAK' });
    });

    it('GOTO AT re-enters FOR step at specific iteration', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Start',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2', at: 2 } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          isDynamic: false,
          forClause: { start: 1, end: 3 },
          description: 'FOR loop',
          substeps: [
            {
              id: '1',
              description: 'Process',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        },
        {
          name: '3',
          isDynamic: false,
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // GOTO 2 AT 2 → enters FOR step at iteration 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_2_1');
      expect(actor.getSnapshot().context.forIteration).toBe(2);
      expect(actor.getSnapshot().context.forStart).toBe(1);
      expect(actor.getSnapshot().context.forEnd).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);

      // Iteration 2: PASS → loop back to iteration 3
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_2_1');
      expect(actor.getSnapshot().context.forIteration).toBe(3);

      // Iteration 3: PASS → exit
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_3');
    });

    it('GOTO without AT targeting FOR step resets to first iteration', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Start',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          isDynamic: false,
          forClause: { start: 1, end: 2 },
          description: 'FOR loop',
          substeps: [
            {
              id: '1',
              description: 'Process',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        },
        {
          name: '3',
          isDynamic: false,
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // GOTO 2 (no AT) → resets to iteration 1 (forClause.start)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step_2_1');
      expect(actor.getSnapshot().context.forIteration).toBe(1);
      expect(actor.getSnapshot().context.forEnd).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);
    });

    it('GOTO event with AT initializes FOR context correctly', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Start'
        },
        {
          name: '2',
          isDynamic: false,
          forClause: { variable: 'batch', start: 1, end: 5 },
          description: 'FOR loop',
          substeps: [
            {
              id: '1',
              description: 'Process',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        },
        {
          name: '3',
          isDynamic: false,
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Send external GOTO event with AT
      actor.send({ type: 'GOTO', target: { step: '2', at: 3 } });
      expect(actor.getSnapshot().value).toBe('step_2_1');
      expect(actor.getSnapshot().context.forIteration).toBe(3);
      expect(actor.getSnapshot().context.forStart).toBe(1);
      expect(actor.getSnapshot().context.forEnd).toBe(5);
      expect(actor.getSnapshot().context.forVariable).toBe('batch');
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);
      // AT qualifier is preserved in lastAction for state persistence
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'GOTO', target: '2', substep: '1', at: 3 });
    });

    it('GOTO event without AT to FOR step resets iteration', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Start'
        },
        {
          name: '2',
          isDynamic: false,
          forClause: { start: 1, end: 3 },
          description: 'FOR loop',
          substeps: [
            {
              id: '1',
              description: 'Process',
              isDynamic: false,
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            }
          ]
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // External GOTO without AT to FOR step → reset
      actor.send({ type: 'GOTO', target: { step: '2' } });
      expect(actor.getSnapshot().value).toBe('step_2_1');
      expect(actor.getSnapshot().context.forIteration).toBe(1);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);
      // No AT qualifier in lastAction
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'GOTO', target: '2', substep: '1' });
    });
  });
});
