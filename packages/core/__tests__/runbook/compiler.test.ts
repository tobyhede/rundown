import { describe, it, expect } from '@jest/globals';
import { createActor } from 'xstate';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import type { Step } from '../../src/runbook/types.js';


describe('runbook compiler', () => {
  describe('static step compilation', () => {
    it('generates discrete states for substeps', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Parent',
          substeps: [
            { id: '1', description: 'Child 1' },
            { id: '2', description: 'Child 2' }
          ]
        }
      ];
      const machine = compileRunbookToMachine(steps);
      // @ts-expect-error - states is internal to machine
      const stateIds = Object.keys(machine.config.states);
      expect(stateIds).toContain('step::1::1');
      expect(stateIds).toContain('step::1::2');
      expect(stateIds).not.toContain('step::1');
    });

    it('generates single state for step without substeps', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Simple'
        }
      ];
      const machine = compileRunbookToMachine(steps);
      // @ts-expect-error - accessing internal states property
      const stateIds = Object.keys(machine.config.states);
      expect(stateIds).toContain('step::1');
    });
  });

  describe('CONTINUE with named steps', () => {
    it('skips named step and returns COMPLETE when no more numbered steps', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Setup',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: 'ErrorHandler',
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
          description: 'First',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: 'ErrorHandler',
          description: 'Named - skipped'
        },
        {
          name: '2',
          description: 'Second'
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('step::2');
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
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
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
          description: 'Step 1',
          substeps: [
            { id: '1', description: 'Substep 1.1' },
            {
              id: '2',
              description: 'Substep 1.2',
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
          description: 'Step 2 (no substeps)'
        },
        {
          name: '3',
          description: 'Step 3',
          substeps: [
            { id: '1', description: 'Substep 3.1' },
            { id: '2', description: 'Substep 3.2' }
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
      expect(actor.getSnapshot().value).toBe('step::2');

      // Pass step 2, should CONTINUE to step 3.1
      // This was the bug: showed "GOTO 3.1" but should be "CONTINUE"
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'CONTINUE' });
      expect(actor.getSnapshot().value).toBe('step::3::1');
    });

    it('sets lastAction to STOP for STOP transitions', () => {
      const steps: Step[] = [
        {
          name: '1',
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
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'GOTO', target: { step: 'ErrorHandler' } } }
          }
        },
        {
          name: 'ErrorHandler',
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
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2', substep: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          description: 'Step 2',
          substeps: [
            { id: '1', description: 'Substep 2.1' },
            { id: '2', description: 'Substep 2.2' },
            { id: '3', description: 'Substep 2.3' }
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

    it('sets lastAction for GOTO event (external jump)', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Step 1'
        },
        {
          name: '2',
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

  });

  describe('resolveSimpleGotoTarget helper', () => {
    it('resolves numeric step target to correct state ID', () => {
      // This tests the behavior indirectly through GOTO action
      const steps: Step[] = [
        {
          name: '1',
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
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

      expect(snapshot.value).toBe('step::2');
    });
  });

  describe('RETRY as transition property', () => {
    it('stays at current step during retry, then executes action', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 2, action: { type: 'GOTO', target: { step: '2' } } }
          }
        },
        {
          name: '2',
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
      expect(actor.getSnapshot().value).toBe('step::1');
      expect(actor.getSnapshot().context.retryCount).toBe(1);

      // Second FAIL: stay at step 1 (retry 2/2)
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('step::1');
      expect(actor.getSnapshot().context.retryCount).toBe(2);

      // Third FAIL: exhausted, GOTO step 2
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.retryCount).toBe(0);
    });

    it('works the same for PASS with retry', () => {
      const steps: Step[] = [
        {
          name: '1',
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
      expect(actor.getSnapshot().value).toBe('step::1');

      // Second PASS: stay (retry 2/2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1');

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
          description: 'Run Tests',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } }
          }
        },
        {
          name: '2',
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
      expect(actor.getSnapshot().value).toBe('step::2');

      // Step 2 PASS -> RETRY GOTO 1 (should stay at step 2 for retry 1/2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.retryCount).toBe(1);
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'RETRY' });

      // Step 2 PASS again -> RETRY GOTO 1 (should stay at step 2 for retry 2/2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.retryCount).toBe(2);

      // Step 2 PASS again -> exhausted, execute GOTO to step 1
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('step::1');
      expect(snapshot.context.retryCount).toBe(0);
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: '1' });
    });

    it('STOPs when RETRY+GOTO exhausts retries', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Run Tests',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } }
          }
        },
        {
          name: '2',
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
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.retryCount).toBe(1);

      // Step 2 PASS -> RETRY (2/2), stay at step 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.retryCount).toBe(2);

      // Step 2 PASS -> retries exhausted, execute GOTO to step 1
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1');

      // Step 1 FAIL -> step 2
      actor.send({ type: 'FAIL' });
      // Step 2 PASS -> fresh RETRY cycle, RETRY (1/2), stay at step 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.retryCount).toBe(1);
    });
  });

  describe('FOR loop compilation', () => {
    it('iterates FOR loop the correct number of times via CONTINUE', () => {
      const steps: Step[] = [
        {
          name: '2',
          description: 'Setup',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '3',
          forClause: { start: 1, end: 3 },
          description: 'Process batches',
          substeps: [
            {
              id: '1',
              description: 'Fetch',
                  transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            },
            {
              id: '2',
              description: 'Process',
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

      // Start at step::2, PASS to enter FOR step
      expect(actor.getSnapshot().value).toBe('step::2');
      actor.send({ type: 'PASS' }); // step::2 → step::3::1 (FOR initialized)

      expect(actor.getSnapshot().value).toBe('step::3::1');
      const top1 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(top1.iteration).toBe(1);
      expect(top1.end).toBe(3);

      // Iteration 1: step::3::1 → step::3::2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::2');

      // Iteration 1: step::3::2 → loop back to step::3::1 (iteration 2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::1');
      const top2 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(top2.iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

      // Iteration 2: step::3::1 → step::3::2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::2');

      // Iteration 2: step::3::2 → loop back to step::3::1 (iteration 3)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::1');
      const top3 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(top3.iteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);

      // Iteration 3: step::3::1 → step::3::2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::2');

      // Iteration 3: step::3::2 → exit loop → step::4
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::4');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('initializes FOR context when FOR step is the first state', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          description: 'First step is FOR',
          substeps: [
            {
              id: '1',
              description: 'Process',
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

      // Machine starts at step::1::1 (first substep of FOR step)
      expect(actor.getSnapshot().value).toBe('step::1::1');
      const top = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(top.iteration).toBe(1);
      expect(top.start).toBe(1);
      expect(top.end).toBe(2);

      // Iteration 1: PASS → loop back (iteration 2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::1');
      const top2a = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(top2a.iteration).toBe(2);

      // Iteration 2: PASS → exit loop
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('exits loop immediately when start equals end (single iteration)', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 5, end: 5 },
          description: 'Single iteration',
          substeps: [
            {
              id: '1',
              description: 'Process',
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

      expect(actor.getSnapshot().value).toBe('step::1::1');
      const topSingle = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topSingle.iteration).toBe(5);

      // Single pass should exit loop (5 is not < 5)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('stores named variable in FOR context', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { variable: 'batch', start: 1, end: 2 },
          description: 'Named loop variable',
          substeps: [
            {
              id: '1',
              description: 'Process',
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

      const topVar = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topVar.variable).toBe('batch');
    });

    it('records iteration results including failures', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 1, end: 4 },
          description: 'Test with failures',
          substeps: [
            {
              id: '1',
              description: 'Single substep',
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
      const topRes1 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topRes1.iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

      // Iteration 2: FAIL (forIteration=2, loop back)
      actor.send({ type: 'FAIL' });
      const topRes2 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topRes2.iteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'fail']);

      // Iteration 3: PASS (forIteration=3, loop back)
      actor.send({ type: 'PASS' });
      const topRes3 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topRes3.iteration).toBe(4);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'fail', 'pass']);

      // Iteration 4: PASS (forIteration=4, 4 < 4? NO, exit loop — records final result)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'fail', 'pass', 'pass']);
    });

    it('handles FOR step without substeps gracefully', () => {
      const steps: Step[] = [
        {
          name: '1',
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
      expect(snapshot.value).toBe('step::2');
    });

    it('initializes FOR context when GOTO enters FOR step', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Start',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          description: 'Skipped'
        },
        {
          name: '3',
          forClause: { start: 1, end: 2 },
          description: 'FOR entered via GOTO',
          substeps: [
            {
              id: '1',
              description: 'Process',
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
      expect(actor.getSnapshot().value).toBe('step::3::1');
      const topGoto1 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topGoto1.iteration).toBe(1);
      expect(topGoto1.end).toBe(2);

      // Iteration 1: PASS → loop back
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::1');
      const topGoto2 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topGoto2.iteration).toBe(2);

      // Iteration 2: PASS → exit loop
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::4');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('NEXT skips remaining substeps and advances to next iteration', () => {
      const steps: Step[] = [
        {
          name: '2',
          description: 'Setup',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '3',
          forClause: { start: 1, end: 3 },
          description: 'Process batches',
          substeps: [
            {
              id: '1',
              description: 'Fetch',
                  transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'NEXT' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            },
            {
              id: '2',
              description: 'Process (skipped by NEXT)',
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
      expect(actor.getSnapshot().value).toBe('step::3::1');
      const topNext1 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topNext1.iteration).toBe(1);

      // Iteration 1: PASS on substep 1 → NEXT → skip substep 2, go to iteration 2's substep 1
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::1'); // Loop back to first substep
      const topNext2 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topNext2.iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

      // Iteration 2: PASS → NEXT → iteration 3
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::1');
      const topNext3 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topNext3.iteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);

      // Iteration 3 (last): PASS → NEXT → exit loop
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::4'); // Exit to next step
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('BREAK exits loop immediately regardless of remaining iterations', () => {
      const steps: Step[] = [
        {
          name: '2',
          description: 'Setup',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '3',
          forClause: { start: 1, end: 5 },
          description: 'Process batches',
          substeps: [
            {
              id: '1',
              description: 'Check',
                  transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'BREAK' } }
              }
            },
            {
              id: '2',
              description: 'Process',
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
      expect(actor.getSnapshot().value).toBe('step::3::1');
      const topBreak1 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topBreak1.iteration).toBe(1);

      // Iteration 1: FAIL on substep 1 → BREAK → exit loop to step 4
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('step::4');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['fail']);
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'BREAK' });
    });

    it('NEXT records iteration results correctly across iterations', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'Loop with NEXT on fail',
          substeps: [
            {
              id: '1',
              description: 'Step',
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
      const topNextRes1 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topNextRes1.iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['fail']);

      // Iteration 2: PASS → NEXT
      actor.send({ type: 'PASS' });
      const topNextRes2 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topNextRes2.iteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['fail', 'pass']);

      // Iteration 3 (last): PASS → NEXT → exit
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.iterationResults).toEqual(['fail', 'pass', 'pass']);
    });

    it('BREAK records the final iteration result before exiting', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 1, end: 5 },
          description: 'Loop with early break',
          substeps: [
            {
              id: '1',
              description: 'Increment',
                  transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            },
            {
              id: '2',
              description: 'Check and break',
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
      expect(actor.getSnapshot().value).toBe('step::1::2');
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::1');
      const topBreakRes1 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topBreakRes1.iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

      // Iteration 2: PASS → PASS → loop back
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::2');
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::1');
      const topBreakRes2 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topBreakRes2.iteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);

      // Iteration 3: PASS → FAIL (BREAK)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::2');
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass', 'fail']);
    });

    it('NEXT outside FOR loop goes to STOPPED', () => {
      const steps: Step[] = [
        {
          name: '1',
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
          description: 'Start',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2', at: 2 } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          forClause: { start: 1, end: 3 },
          description: 'FOR loop',
          substeps: [
            {
              id: '1',
              description: 'Process',
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
      expect(actor.getSnapshot().value).toBe('step::2::1');
      const topAt1 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topAt1.iteration).toBe(2);
      expect(topAt1.start).toBe(1);
      expect(topAt1.end).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);

      // Iteration 2: PASS → loop back to iteration 3
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2::1');
      const topAt2 = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topAt2.iteration).toBe(3);

      // Iteration 3: PASS → exit
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3');
    });

    it('GOTO without AT targeting FOR step resets to first iteration', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Start',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          forClause: { start: 1, end: 2 },
          description: 'FOR loop',
          substeps: [
            {
              id: '1',
              description: 'Process',
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
      expect(actor.getSnapshot().value).toBe('step::2::1');
      const topNoAt = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topNoAt.iteration).toBe(1);
      expect(topNoAt.end).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);
    });

    it('GOTO event with AT initializes FOR context correctly', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Start'
        },
        {
          name: '2',
          forClause: { variable: 'batch', start: 1, end: 5 },
          description: 'FOR loop',
          substeps: [
            {
              id: '1',
              description: 'Process',
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
      expect(actor.getSnapshot().value).toBe('step::2::1');
      const topEvtAt = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topEvtAt.iteration).toBe(3);
      expect(topEvtAt.start).toBe(1);
      expect(topEvtAt.end).toBe(5);
      expect(topEvtAt.variable).toBe('batch');
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);
      // AT qualifier is preserved in lastAction for state persistence
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'GOTO', target: '2', substep: '1', at: 3 });
    });

    it('GOTO event without AT to FOR step resets iteration', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Start'
        },
        {
          name: '2',
          forClause: { start: 1, end: 3 },
          description: 'FOR loop',
          substeps: [
            {
              id: '1',
              description: 'Process',
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
      expect(actor.getSnapshot().value).toBe('step::2::1');
      const topEvtNoAt = actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topEvtNoAt.iteration).toBe(1);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);
      // No AT qualifier in lastAction
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'GOTO', target: '2', substep: '1' });
    });

    it('GOTO from inside FOR loop to non-FOR step clears forStack', () => {
      // Step 1: non-FOR step
      // Step 2: FOR 1..3 with substeps, substep 1 PASS action = GOTO 1
      // Step 3: exit step
      // Flow: enter FOR at step 2, PASS substep 1 → GOTO step 1 → forStack cleared
      // Then GOTO back to step 2 → fresh loop (forStack has new context)
      const steps: Step[] = [
        {
          name: '1',
          description: 'Non-FOR target',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          forClause: { start: 1, end: 3 },
          description: 'FOR step',
          substeps: [
            {
              id: '1',
              description: 'Substep with GOTO out',
                  transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '1' } } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            },
            {
              id: '2',
              description: 'Substep 2',
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
          description: 'After loop',
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

      // Enter FOR step via GOTO from step 1
      actor.send({ type: 'PASS' }); // step::1 → step::2::1
      expect(actor.getSnapshot().value).toBe('step::2::1');
      const ctx1 = actor.getSnapshot().context;
      expect(ctx1.forStack.length).toBe(1);
      expect(ctx1.forStack[0].iteration).toBe(1);

      // PASS substep 1 → GOTO step 1 (non-FOR) — forStack should be cleared
      actor.send({ type: 'PASS' }); // step::2::1 → step::1
      expect(actor.getSnapshot().value).toBe('step::1');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
      expect(actor.getSnapshot().context.iterationResults).toBeUndefined();

      // Re-enter FOR step → fresh loop context
      actor.send({ type: 'PASS' }); // step::1 → step::2::1 (fresh FOR)
      expect(actor.getSnapshot().value).toBe('step::2::1');
      const ctx2 = actor.getSnapshot().context;
      expect(ctx2.forStack.length).toBe(1);
      expect(ctx2.forStack[0].iteration).toBe(1);
      expect(ctx2.iterationResults).toEqual([]);
    });

    it('GOTO AT with unresolved template string falls back to loop start', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Start',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2', at: '{{Offset}}' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          forClause: { start: 1, end: 3 },
          description: 'FOR loop',
          substeps: [
            {
              id: '1',
              description: 'Process',
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

      // GOTO 2 AT {{Offset}} — unresolved string should fall back to start (1)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2::1');
      const top = actor.getSnapshot().context.forStack[0];
      expect(top.iteration).toBe(1); // Falls back to start
      expect(top.start).toBe(1);
      expect(top.end).toBe(3);
    });

    it('GOTO AT with built-in {{Index}} resolves at runtime', () => {
      // When AT references built-in {{Index}}, it should
      // resolve to the current iteration value, not fall back to start.
      const steps: Step[] = [
        {
          name: '1',
          description: 'Loop A',
          forClause: { start: 1, end: 5, variable: 'item' },
          substeps: [
            {
              id: '1',
              description: 'Sub',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: {
                  type: 'GOTO', target: { step: '2', at: '{{Index}}' }
                }}
              }
            }
          ]
        },
        {
          name: '2',
          description: 'Loop B',
          forClause: { start: 1, end: 5 },
          substeps: [
            {
              id: '1',
              description: 'Sub',
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
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } }
          }
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Advance to iteration 3
      actor.send({ type: 'PASS' }); // iter 1 → 2
      actor.send({ type: 'PASS' }); // iter 2 → 3

      // FAIL at iteration 3 → GOTO 2 AT {{Index}} → should resolve to AT 3
      actor.send({ type: 'FAIL' });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe('step::2::1');
      expect(snap.context.forStack[0].iteration).toBe(3);
    });

    it('GOTO AT with named loop variable resolves at runtime', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Loop A',
          forClause: { start: 1, end: 5, variable: 'item' },
          substeps: [
            {
              id: '1',
              description: 'Sub',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: {
                  type: 'GOTO', target: { step: '2', at: '{{item}}' }
                }}
              }
            }
          ]
        },
        {
          name: '2',
          description: 'Loop B',
          forClause: { start: 1, end: 5 },
          substeps: [
            {
              id: '1',
              description: 'Sub',
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
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } }
          }
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Advance to iteration 3
      actor.send({ type: 'PASS' }); // iter 1 -> 2
      actor.send({ type: 'PASS' }); // iter 2 -> 3

      // FAIL at iteration 3 -> GOTO 2 AT {{item}} -> resolves to AT 3
      actor.send({ type: 'FAIL' });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe('step::2::1');
      expect(snap.context.forStack[0].iteration).toBe(3);
    });

    it('GOTO event targeting non-first FOR substep initializes loop context', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Start',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          forClause: { start: 1, end: 3 },
          description: 'FOR with 2 substeps',
          substeps: [
            {
              id: '1',
              description: 'First',
                  transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            },
            {
              id: '2',
              description: 'Second',
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

      // Send GOTO event targeting second substep of FOR step
      actor.send({ type: 'GOTO', target: { step: '2', substep: '2' } });
      expect(actor.getSnapshot().value).toBe('step::2::2');

      // Should have FOR context initialized (not cleared by buildSimpleGotoAssign)
      const ctx = actor.getSnapshot().context;
      expect(ctx.forStack.length).toBe(1);
      expect(ctx.forStack[0].iteration).toBe(1);
      expect(ctx.forStack[0].start).toBe(1);
      expect(ctx.forStack[0].end).toBe(3);
      expect(ctx.iterationResults).toEqual([]);
    });

  });

  const DEFAULT_TRANSITIONS = {
    all: true,
    pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
    fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } }
  };

  describe('implicit 1..1 loop model', () => {
    it('non-FOR step with substeps creates implicit ForContext on entry', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Step with substeps, no FOR',
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ]
        },
        {
          name: '2',
          description: 'Next step',
          transitions: { ...DEFAULT_TRANSITIONS, pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } } }
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      const ctx = actor.getSnapshot().context;
      expect(ctx.forStack).toHaveLength(1);
      expect(ctx.forStack[0]).toEqual({
        stepId: '1',
        iteration: 1,
        start: 1,
        end: 1,
        implicit: true,
      });
    });

    it('implicit 1..1 loop never loops back on CONTINUE', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Step with substeps, no FOR',
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ]
        },
        {
          name: '2',
          description: 'Next step',
          transitions: { ...DEFAULT_TRANSITIONS, pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } } }
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // substep 1 -> substep 2
      actor.send({ type: 'PASS' }); // substep 2 -> exits to step 2

      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('iterationResults is undefined after implicit loop exit', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Single substep, no FOR',
          substeps: [
            { id: '1', description: 'Only sub', transitions: DEFAULT_TRANSITIONS },
          ]
        },
        {
          name: '2',
          description: 'Next step',
          transitions: { ...DEFAULT_TRANSITIONS, pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } } }
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' });

      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.iterationResults).toBeUndefined();
    });

    it('GOTO to non-FOR step with substeps initializes implicit ForContext', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Source',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          description: 'Target with substeps, no FOR',
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ]
        },
        {
          name: '3',
          description: 'Final',
          transitions: { ...DEFAULT_TRANSITIONS, pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } } }
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // GOTO step 2

      expect(actor.getSnapshot().value).toBe('step::2::1');
      const ctx = actor.getSnapshot().context;
      expect(ctx.forStack).toHaveLength(1);
      expect(ctx.forStack[0]).toEqual(
        expect.objectContaining({ stepId: '2', implicit: true })
      );
    });

    it('NEXT in non-FOR step still goes to STOPPED', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Step with NEXT but no FOR',
          substeps: [
            {
              id: '1', description: 'Sub',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'NEXT' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            },
          ]
        },
        { name: '2', description: 'Unreachable', transitions: DEFAULT_TRANSITIONS }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
    });

    it('BREAK in non-FOR step still goes to STOPPED', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Step with BREAK but no FOR',
          substeps: [
            {
              id: '1', description: 'Sub',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'BREAK' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            },
          ]
        },
        { name: '2', description: 'Unreachable', transitions: DEFAULT_TRANSITIONS }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
    });

    it('explicit FOR loop behavior is unchanged', () => {
      // Regression: existing FOR 1..3 must still loop correctly
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'FOR step',
          substeps: [
            { id: '1', description: 'Sub', transitions: DEFAULT_TRANSITIONS },
          ]
        },
        {
          name: '2',
          description: 'After loop',
          transitions: { ...DEFAULT_TRANSITIONS, pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } } }
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::1'); // loops back
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(2);

      // Iteration 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::1');
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(3);

      // Iteration 3 (last)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2'); // exits
      expect(actor.getSnapshot().context.forStack).toEqual([]);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass', 'pass']);
    });

    it('intra-loop GOTO preserves forStack', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Loop step',
          forClause: { start: 1, end: 3 },
          substeps: [
            {
              id: '1',
              description: 'First sub',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: {
                  type: 'GOTO', target: { step: '1', substep: '2' }
                }}
              }
            },
            {
              id: '2',
              description: 'Second sub',
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
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } }
          }
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // First iteration: FAIL on substep 1 → GOTO 1.2 (intra-loop)
      actor.send({ type: 'FAIL' });
      let snap = actor.getSnapshot();
      expect(snap.value).toBe('step::1::2');
      // forStack should be preserved with iteration 1
      expect(snap.context.forStack).toHaveLength(1);
      expect(snap.context.forStack[0].iteration).toBe(1);

      // PASS substep 2 → should loop back to substep 1 at iteration 2
      actor.send({ type: 'PASS' });
      snap = actor.getSnapshot();
      expect(snap.value).toBe('step::1::1');
      expect(snap.context.forStack[0].iteration).toBe(2);

      // Second iteration: PASS both → loop back at iteration 3
      actor.send({ type: 'PASS' }); // 1.1 → 1.2
      actor.send({ type: 'PASS' }); // 1.2 → loop back
      snap = actor.getSnapshot();
      expect(snap.value).toBe('step::1::1');
      expect(snap.context.forStack[0].iteration).toBe(3);

      // Third iteration (last): PASS both → exit loop
      actor.send({ type: 'PASS' }); // 1.1 → 1.2
      actor.send({ type: 'PASS' }); // 1.2 → exit
      snap = actor.getSnapshot();
      expect(snap.value).toBe('step::2');
      expect(snap.context.forStack).toEqual([]);
    });

    it('GOTO action with substep to cross-loop FOR step initializes forStack', () => {
      // Step 1 (non-FOR) → PASS: GOTO 2.1 → Step 2 (FOR 1..3)
      // Verifies that forStack is initialized (not cleared by buildSimpleGotoAssign)
      const steps: Step[] = [
        {
          name: '1',
          description: 'Source step',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2', substep: '1' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          description: 'FOR target',
          forClause: { start: 1, end: 3, variable: 'i' },
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ]
        },
        {
          name: '3',
          description: 'Final',
          transitions: { ...DEFAULT_TRANSITIONS, pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } } }
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // GOTO 2.1
      expect(actor.getSnapshot().value).toBe('step::2::1');
      const ctx = actor.getSnapshot().context;
      expect(ctx.forStack).toHaveLength(1);
      expect(ctx.forStack[0].stepId).toBe('2');
      expect(ctx.forStack[0].iteration).toBe(1);
      expect(ctx.forStack[0].start).toBe(1);
      expect(ctx.forStack[0].end).toBe(3);
      expect(ctx.forStack[0].variable).toBe('i');
      expect(ctx.iterationResults).toEqual([]);
    });

    it('GOTO action with substep + AT to FOR step resolves iteration', () => {
      // Step 1 (non-FOR) → PASS: GOTO 2.1 AT 2 → Step 2 (FOR 1..3) at iteration 2
      const steps: Step[] = [
        {
          name: '1',
          description: 'Source step',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2', substep: '1', at: 2 } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          description: 'FOR target',
          forClause: { start: 1, end: 3, variable: 'batch' },
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ]
        },
        {
          name: '3',
          description: 'Final',
          transitions: { ...DEFAULT_TRANSITIONS, pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } } }
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // GOTO 2.1 AT 2
      expect(actor.getSnapshot().value).toBe('step::2::1');
      const ctx = actor.getSnapshot().context;
      expect(ctx.forStack).toHaveLength(1);
      expect(ctx.forStack[0].iteration).toBe(2);
      expect(ctx.forStack[0].variable).toBe('batch');
      expect(ctx.iterationResults).toEqual([]);
      expect(ctx.lastAction).toEqual({ type: 'GOTO', target: '2', substep: '1', at: 2 });
    });

    it('GOTO action with substep to implicit (non-FOR) step initializes implicit forStack', () => {
      // Step 1 → PASS: GOTO 2.2 → Step 2 (non-FOR with substeps)
      const steps: Step[] = [
        {
          name: '1',
          description: 'Source step',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2', substep: '2' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          description: 'Target with substeps, no FOR',
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ]
        },
        {
          name: '3',
          description: 'Final',
          transitions: { ...DEFAULT_TRANSITIONS, pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } } }
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // GOTO 2.2
      expect(actor.getSnapshot().value).toBe('step::2::2');
      const ctx = actor.getSnapshot().context;
      expect(ctx.forStack).toHaveLength(1);
      expect(ctx.forStack[0]).toEqual(
        expect.objectContaining({ stepId: '2', implicit: true })
      );
      expect(ctx.iterationResults).toBeUndefined();
    });

    it('GOTO event to non-FOR substep uses unified ForContext path', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Source step',
          substeps: [
            { id: '1', description: 'Sub', transitions: DEFAULT_TRANSITIONS },
          ]
        },
        {
          name: '2',
          description: 'Target with substeps, no FOR',
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ]
        },
        {
          name: '3',
          description: 'Final',
          transitions: { ...DEFAULT_TRANSITIONS, pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } } }
        }
      ];
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // External GOTO to step 2's second substep
      actor.send({ type: 'GOTO', target: { step: '2', substep: '2' } });

      expect(actor.getSnapshot().value).toBe('step::2::2');
      const ctx = actor.getSnapshot().context;
      expect(ctx.forStack).toHaveLength(1);
      expect(ctx.forStack[0]).toEqual(
        expect.objectContaining({ stepId: '2', implicit: true })
      );
    });
  });

  describe('post-loop aggregation', () => {
    it('PASS ALL fails when any iteration failed', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'Loop with PASS ALL',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          },
          substeps: [
            {
              id: '1',
              description: 'Process',
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
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: PASS
      actor.send({ type: 'PASS' });
      // Iteration 2: FAIL
      actor.send({ type: 'FAIL' });
      // Iteration 3: PASS
      actor.send({ type: 'PASS' });

      // After loop exit, PASS ALL should evaluate to FAIL because iteration 2 failed
      // The parent step's transitions have all=true (pessimistic: PASS ALL / FAIL ANY)
      const snapshot = actor.getSnapshot();

      // PASS ALL with one failure → aggregation fails → STOP
      expect(snapshot.value).toBe('STOPPED');
      expect(snapshot.context.iterationResults).toEqual(['pass', 'fail', 'pass']);
    });

    it('PASS ALL fails when first iteration failed', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'Loop with PASS ALL',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          },
          substeps: [
            {
              id: '1',
              description: 'Check',
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
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: FAIL
      actor.send({ type: 'FAIL' });
      // Iteration 2: PASS
      actor.send({ type: 'PASS' });
      // Iteration 3: PASS
      actor.send({ type: 'PASS' });

      const snapshot = actor.getSnapshot();

      // FAIL ANY with one failure → aggregation fails → STOP
      expect(snapshot.value).toBe('STOPPED');
      expect(snapshot.context.iterationResults).toEqual(['fail', 'pass', 'pass']);
    });

    it('PASS ALL succeeds when all iterations pass', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'Loop with all passes',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          },
          substeps: [
            {
              id: '1',
              description: 'Always pass',
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
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // All iterations pass
      actor.send({ type: 'PASS' }); // iter 1
      actor.send({ type: 'PASS' }); // iter 2
      actor.send({ type: 'PASS' }); // iter 3

      // Should reach step 2 (PASS ALL with all passes → CONTINUE)
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('step::2');
      expect(snapshot.context.iterationResults).toEqual(['pass', 'pass', 'pass']);
    });

    it('PASS ANY succeeds when one iteration passes', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'Loop with PASS ANY',
          transitions: {
            all: false,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          },
          substeps: [
            {
              id: '1',
              description: 'Process',
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
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: FAIL
      actor.send({ type: 'FAIL' });
      // Iteration 2: PASS
      actor.send({ type: 'PASS' });
      // Iteration 3: FAIL
      actor.send({ type: 'FAIL' });

      // PASS ANY with one pass → aggregation passes → CONTINUE to step 2
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('step::2');
      expect(snapshot.context.iterationResults).toEqual(['fail', 'pass', 'fail']);
    });

    it('BREAK triggers aggregation on accumulated results', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 1, end: 5 },
          description: 'Loop with BREAK',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } }
              }
            },
            {
              id: '2',
              description: 'Maybe break',
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
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: PASS substep 1, PASS substep 2 → loop back
      actor.send({ type: 'PASS' });
      actor.send({ type: 'PASS' });
      // Iteration 2: PASS substep 1, PASS substep 2 → loop back
      actor.send({ type: 'PASS' });
      actor.send({ type: 'PASS' });
      // Iteration 3: PASS substep 1, FAIL substep 2 → BREAK
      actor.send({ type: 'PASS' });
      actor.send({ type: 'FAIL' });

      // BREAK at iter 3 with all passes so far → aggregation uses 3 results
      // PASS ALL: results are [pass, pass, fail] → has failure → STOP
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      expect(snapshot.context.iterationResults).toEqual(['pass', 'pass', 'fail']);
    });

    it('NEXT at last iteration triggers aggregation', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          description: 'Loop with NEXT',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'NEXT' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'NEXT' } }
              }
            },
            {
              id: '2',
              description: 'Skipped by NEXT',
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
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: PASS substep 1 → NEXT (skip substep 2, loop back)
      actor.send({ type: 'PASS' });
      // Iteration 2: PASS substep 1 → NEXT (last iteration, exit loop)
      actor.send({ type: 'PASS' });

      // PASS ALL with all passes → aggregation passes → CONTINUE to step 2
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('step::2');
      expect(snapshot.context.iterationResults).toEqual(['pass', 'pass']);
    });

    it('FAIL ALL triggers when all iterations fail under PASS ANY mode', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'Loop with PASS ANY',
          transitions: {
            all: false,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          },
          substeps: [
            {
              id: '1',
              description: 'Process',
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
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // All iterations fail
      actor.send({ type: 'FAIL' }); // iter 1
      actor.send({ type: 'FAIL' }); // iter 2
      actor.send({ type: 'FAIL' }); // iter 3

      // PASS ANY with zero passes → aggregation fails → STOP
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      expect(snapshot.context.iterationResults).toEqual(['fail', 'fail', 'fail']);
    });

    it('PASS ALL with GOTO target records GOTO lastAction and initializes forStack for target FOR step', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          description: 'Loop that GOTOs on pass',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3', at: 1 } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          },
          substeps: [
            {
              id: '1',
              description: 'Process',
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
          description: 'Skipped step',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } }
          }
        },
        {
          name: '3',
          forClause: { start: 1, end: 3 },
          description: 'Target FOR step',
          substeps: [
            {
              id: '1',
              description: 'Target substep',
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

      // All iterations pass
      actor.send({ type: 'PASS' }); // iter 1
      actor.send({ type: 'PASS' }); // iter 2

      // PASS ALL succeeds → GOTO 3 AT 1
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('step::3::1');
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: '3', at: 1 });
      expect(snapshot.context.forStack).toEqual([
        { stepId: '3', iteration: 1, start: 1, end: 3 }
      ]);
      expect(snapshot.context.iterationResults).toEqual([]);
    });

    it('FAIL ANY with COMPLETE action records COMPLETE lastAction', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          description: 'Loop that COMPLETEs on fail',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'COMPLETE' } }
          },
          substeps: [
            {
              id: '1',
              description: 'Process',
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
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: PASS
      actor.send({ type: 'PASS' });
      // Iteration 2: FAIL
      actor.send({ type: 'FAIL' });

      // PASS ALL with one failure → aggregation fails → COMPLETE
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
      expect(snapshot.context.lastAction).toEqual({ type: 'COMPLETE' });
    });

    it('PASS ALL with STOP action records STOP lastAction', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          description: 'Loop that STOPs on pass',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'STOP' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } }
          },
          substeps: [
            {
              id: '1',
              description: 'Process',
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
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } }
          }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // All iterations pass
      actor.send({ type: 'PASS' }); // iter 1
      actor.send({ type: 'PASS' }); // iter 2

      // PASS ALL succeeds → STOP
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      expect(snapshot.context.lastAction).toEqual({ type: 'STOP' });
    });
  });

  describe('descending FOR loop ranges', () => {
    it('iterates descending range (3, 2, 1) via CONTINUE', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 3, end: 1 },
          description: 'Descending loop',
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS
            }
          ]
        },
        {
          name: '2',
          description: 'Done',
          transitions: { ...DEFAULT_TRANSITIONS, pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } } }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration starts at 3
      expect(actor.getSnapshot().value).toBe('step::1::1');
      const top1 = actor.getSnapshot().context.forStack[0];
      expect(top1.iteration).toBe(3);
      expect(top1.start).toBe(3);
      expect(top1.end).toBe(1);

      // Iteration 3 → 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::1');
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

      // Iteration 2 → 1
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::1');
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(1);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);

      // Iteration 1 (last) → exit loop
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass', 'pass']);
    });

    it('BREAK exits descending loop immediately', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 5, end: 1 },
          description: 'Descending with break',
          substeps: [
            {
              id: '1',
              description: 'Check',
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
          description: 'Done',
          transitions: { ...DEFAULT_TRANSITIONS, pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } } }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(5);

      // FAIL → BREAK immediately
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'BREAK' });
    });

    it('NEXT skips to next descending iteration', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 3, end: 1 },
          description: 'Descending with NEXT',
          substeps: [
            {
              id: '1',
              description: 'First',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'NEXT' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
              }
            },
            {
              id: '2',
              description: 'Skipped by NEXT',
              transitions: DEFAULT_TRANSITIONS
            }
          ]
        },
        {
          name: '2',
          description: 'Done',
          transitions: { ...DEFAULT_TRANSITIONS, pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } } }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(3);

      // NEXT at 3 → skip to 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::1');
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(2);

      // NEXT at 2 → skip to 1
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::1');
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(1);

      // NEXT at 1 (last) → exit loop
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('GOTO AT into descending range', () => {
      const steps: Step[] = [
        {
          name: '1',
          description: 'Start',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2', at: 4 } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
          }
        },
        {
          name: '2',
          forClause: { start: 5, end: 1 },
          description: 'Descending FOR',
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS
            }
          ]
        },
        {
          name: '3',
          description: 'Done',
          transitions: { ...DEFAULT_TRANSITIONS, pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } } }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // GOTO 2 AT 4 → enters at iteration 4 in a 5..1 loop
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2::1');
      const top = actor.getSnapshot().context.forStack[0];
      expect(top.iteration).toBe(4);
      expect(top.start).toBe(5);
      expect(top.end).toBe(1);

      // 4 → 3
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(3);

      // 3 → 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(2);

      // 2 → 1
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(1);

      // 1 (last) → exit
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('single iteration when start equals end in descending context', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 5, end: 5 },
          description: 'Single iteration',
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS
            }
          ]
        },
        {
          name: '2',
          description: 'Done',
          transitions: { ...DEFAULT_TRANSITIONS, pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } } }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(5);

      // Single pass exits immediately
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('records iteration results correctly for descending loop', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 3, end: 1 },
          description: 'Descending with mixed results',
          substeps: [
            {
              id: '1',
              description: 'Process',
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
          description: 'Done',
          transitions: { ...DEFAULT_TRANSITIONS, pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } } }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 3: PASS
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

      // Iteration 2: FAIL
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(1);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'fail']);

      // Iteration 1 (last): PASS → exit
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'fail', 'pass']);
    });

    it('iterates descending range with two substeps', () => {
      const steps: Step[] = [
        {
          name: '1',
          forClause: { start: 3, end: 1 },
          description: 'Descending with two substeps',
          substeps: [
            {
              id: '1',
              description: 'First check',
              transitions: DEFAULT_TRANSITIONS
            },
            {
              id: '2',
              description: 'Second check',
              transitions: DEFAULT_TRANSITIONS
            }
          ]
        },
        {
          name: '2',
          description: 'Done',
          transitions: { ...DEFAULT_TRANSITIONS, pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } } }
        }
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1 (value=3): substep 1 pass, substep 2 pass
      actor.send({ type: 'PASS' });
      actor.send({ type: 'PASS' });

      // Verify loop-back happened (still in step 1, iteration=2)
      let snapshot = actor.getSnapshot();
      expect(snapshot.context.forStack[0]?.iteration).toBe(2);

      // Iteration 2 (value=2): substep 1 pass, substep 2 pass
      actor.send({ type: 'PASS' });
      actor.send({ type: 'PASS' });

      snapshot = actor.getSnapshot();
      expect(snapshot.context.forStack[0]?.iteration).toBe(1);

      // Iteration 3 (value=1): substep 1 pass, substep 2 pass -> exit loop
      actor.send({ type: 'PASS' });
      actor.send({ type: 'PASS' });

      snapshot = actor.getSnapshot();
      // Should have exited to step 2
      expect(snapshot.value).toBe('step::2');
      expect(snapshot.context.iterationResults).toEqual(['pass', 'pass', 'pass']);
    });
  });
});
