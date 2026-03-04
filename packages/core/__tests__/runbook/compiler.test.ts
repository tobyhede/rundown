import { describe, it, expect } from '@jest/globals';
import { createActor } from 'xstate';
import { parseRunbookDocument } from '@rundown-org/parser';
import { compileRunbookToMachine, MAX_FILE_ITERATIONS } from '../../src/runbook/compiler.js';
import type {
  Step,
  BaseStep,
  StepWithCommand,
  StepWithSubsteps,
  StepWithFor,
} from '../../src/runbook/types.js';

describe('runbook compiler', () => {
  /** Input type: Step variants without the `kind` discriminant. */
  type StepInput =
    | Omit<BaseStep, 'kind'>
    | Omit<StepWithCommand, 'kind'>
    | Omit<StepWithSubsteps, 'kind'>
    | Omit<StepWithFor, 'kind'>;

  const DEFAULT_TRANSITIONS = {
    all: true,
    pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
    fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
  };

  /** Infer and inject `kind` on each step object so raw literals satisfy the Step union. */
  function inferSteps(raw: StepInput[]): Step[] {
    return raw.map((s) => {
      const kind =
        'forClause' in s
          ? 'for'
          : 'substeps' in s
            ? 'substeps'
            : 'command' in s
              ? 'command'
              : 'base';
      return { ...s, kind } as Step;
    });
  }

  function createRunbook(markdown: string): Step[] {
    const runbook = parseRunbookDocument(markdown);
    return [...runbook.steps];
  }

  describe('static step compilation', () => {
    it('generates discrete states for substeps', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Parent',
          substeps: [
            { id: '1', description: 'Child 1' },
            { id: '2', description: 'Child 2' },
          ],
        },
      ]);
      const machine = compileRunbookToMachine(steps);
      // @ts-expect-error - states is internal to machine
      const stateIds = Object.keys(machine.config.states);
      expect(stateIds).toContain('step::1::1');
      expect(stateIds).toContain('step::1::2');
      expect(stateIds).toContain('step::1'); // parent aggregation state
    });

    it('generates single state for step without substeps', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Simple',
        },
      ]);
      const machine = compileRunbookToMachine(steps);
      // @ts-expect-error - accessing internal states property
      const stateIds = Object.keys(machine.config.states);
      expect(stateIds).toContain('step::1');
    });

    it('parent state passes through for non-FOR step without transitions', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Non-FOR step, no transitions',
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ],
        },
        {
          name: '2',
          description: 'Next step',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // 1.1
      actor.send({ type: 'PASS' }); // 1.2 -> parent -> step::2

      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.iterationResults).toBeUndefined();
    });

    it('explicit H3 runbook substeps with runbooks get CONTINUE defaults', () => {
      const steps = [
        ...parseRunbookDocument(`## 1. Review package
### 1.1 Review pass
- review-pass.runbook.md
### 1.2 Review fail
- review-fail.runbook.md

## 2. Done
- PASS: COMPLETE
`).steps,
      ];

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // 1.1 CONTINUE -> 1.2
      actor.send({ type: 'FAIL' }); // 1.2 CONTINUE -> parent -> unconditional exit to step 2

      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.iterationResults).toBeUndefined();
    });

    it('last substep transitions to parent state', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step with substeps',
          forClause: { start: 1, end: 3 },
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // 1.1 -> 1.2
      actor.send({ type: 'PASS' }); // 1.2 -> parent -> loop-back -> 1.1

      // Should be back at first substep (iteration 2)
      expect(actor.getSnapshot().value).toBe('step::1::1');
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);
    });

    it('non-FOR substeps with FAIL ANY: STOP short-circuits on first failure', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Review step',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
            {
              id: '2',
              description: 'Check 2',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // 1.1 fails — fail-fast: FAIL ANY (all=true) short-circuits to STOPPED immediately
      actor.send({ type: 'FAIL' });

      expect(actor.getSnapshot().value).toBe('STOPPED');
      expect(actor.getSnapshot().context.iterationResults).toEqual(['fail']);
    });
  });

  describe('CONTINUE with named steps', () => {
    it('skips named step and returns COMPLETE when no more numbered steps', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Setup',
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: 'ErrorHandler',
          description: 'Named step - should be skipped by CONTINUE',
        },
      ]);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // PASS on step 1 should go to COMPLETE, not ErrorHandler
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
    });

    it('continues to next numbered step, skipping named steps in between', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'First',
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: 'ErrorHandler',
          description: 'Named - skipped',
        },
        {
          name: '2',
          description: 'Second',
        },
      ]);
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
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          description: 'Step 2',
        },
      ]);
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
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          substeps: [
            { id: '1', description: 'Substep 1.1' },
            {
              id: '2',
              description: 'Substep 1.2',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '2',
          description: 'Step 2 (no substeps)',
        },
        {
          name: '3',
          description: 'Step 3',
          substeps: [
            { id: '1', description: 'Substep 3.1' },
            { id: '2', description: 'Substep 3.2' },
          ],
        },
      ]);
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
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'FAIL' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.lastAction).toEqual({ type: 'STOP' });
    });

    it('sets lastAction to COMPLETE for COMPLETE transitions', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.lastAction).toEqual({ type: 'COMPLETE' });
    });

    it('sets lastAction to GOTO X for explicit GOTO transitions', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: {
              kind: 'fail',
              retry: 0,
              action: { type: 'GOTO', target: { step: 'ErrorHandler' } },
            },
          },
        },
        {
          name: 'ErrorHandler',
          description: 'Error handler',
        },
      ]);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'FAIL' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: 'ErrorHandler' });
    });

    it('sets lastAction to GOTO X.Y for GOTO with substep', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          transitions: {
            all: true,
            pass: {
              kind: 'pass',
              retry: 0,
              action: { type: 'GOTO', target: { step: '2', substep: '3' } },
            },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          name: '2',
          description: 'Step 2',
          substeps: [
            { id: '1', description: 'Substep 2.1' },
            { id: '2', description: 'Substep 2.2' },
            { id: '3', description: 'Substep 2.3' },
          ],
        },
      ]);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: '2', substep: '3' });
    });

    it('sets lastAction to RETRY for RETRY transitions', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: {
              kind: 'fail',
              retry: 3,
              action: { type: 'STOP' },
            },
          },
        },
      ]);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'FAIL' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.lastAction).toEqual({ type: 'RETRY' });
      expect(snapshot.context.retryCount).toBe(1);
    });

    it('sets lastAction for GOTO event (external jump)', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
        },
        {
          name: '2',
          description: 'Step 2',
        },
      ]);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'GOTO', target: { step: '2' } });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: '2' });
    });

    it('sets lastAction for explicit RETRY event', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
        },
      ]);
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
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          name: '2',
          description: 'Step 2',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

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
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 2, action: { type: 'GOTO', target: { step: '2' } } },
          },
        },
        {
          name: '2',
          description: 'Step 2',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

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
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 2, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

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
      const steps = inferSteps([
        {
          name: '1',
          description: 'Run Tests',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
          },
        },
        {
          name: '2',
          description: 'Recovery and Fix',
          transitions: {
            all: true,
            pass: {
              kind: 'pass',
              retry: 2,
              action: { type: 'GOTO', target: { step: '1' } },
            },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          name: '3',
          description: 'Commit Changes',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

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
      const steps = inferSteps([
        {
          name: '1',
          description: 'Run Tests',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
          },
        },
        {
          name: '2',
          description: 'Recovery and Fix',
          transitions: {
            all: true,
            pass: {
              kind: 'pass',
              retry: 2,
              action: { type: 'GOTO', target: { step: '1' } },
            },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          name: '3',
          description: 'Commit Changes',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

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
      const steps = inferSteps([
        {
          name: '2',
          description: 'Setup',
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '3',
          forClause: { start: 1, end: 3 },
          description: 'Process batches',
          substeps: [
            {
              id: '1',
              description: 'Fetch',
              transitions: DEFAULT_TRANSITIONS,
            },
            {
              id: '2',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '4',
          description: 'Commit',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Start at step::2, PASS to enter FOR step
      expect(actor.getSnapshot().value).toBe('step::2');
      actor.send({ type: 'PASS' }); // step::2 → step::3::1 (FOR initialized)

      expect(actor.getSnapshot().value).toBe('step::3::1');
      const top1 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(top1.iteration).toBe(1);
      expect(top1.end).toBe(3);

      // Iteration 1: step::3::1 → step::3::2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::2');

      // Iteration 1: step::3::2 → loop back to step::3::1 (iteration 2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::1');
      const top2 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(top2.iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

      // Iteration 2: step::3::1 → step::3::2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::2');

      // Iteration 2: step::3::2 → loop back to step::3::1 (iteration 3)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::1');
      const top3 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
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
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          description: 'First step is FOR',
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Machine starts at step::1::1 (first substep of FOR step)
      expect(actor.getSnapshot().value).toBe('step::1::1');
      const top =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(top.iteration).toBe(1);
      expect(top.start).toBe(1);
      expect(top.end).toBe(2);

      // Iteration 1: PASS → loop back (iteration 2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::1');
      const top2a =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(top2a.iteration).toBe(2);

      // Iteration 2: PASS → exit loop
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('exits loop immediately when start equals end (single iteration)', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 5, end: 5 },
          description: 'Single iteration',
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().value).toBe('step::1::1');
      const topSingle =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topSingle.iteration).toBe(5);

      // Single pass should exit loop (5 is not < 5)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('stores named variable in FOR context', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { variable: 'batch', start: 1, end: 2 },
          description: 'Named loop variable',
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      const topVar =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topVar.variable).toBe('batch');
    });

    it('records iteration results including failures', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 4 },
          description: 'Test with failures',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Single substep',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: PASS (forIteration=1, loop back)
      actor.send({ type: 'PASS' });
      const topRes1 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topRes1.iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

      // Iteration 2: FAIL (forIteration=2, loop back)
      actor.send({ type: 'FAIL' });
      const topRes2 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topRes2.iteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'fail']);

      // Iteration 3: PASS (forIteration=3, loop back)
      actor.send({ type: 'PASS' });
      const topRes3 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topRes3.iteration).toBe(4);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'fail', 'pass']);

      // Iteration 4: PASS (forIteration=4, 4 < 4? NO, exit loop — FAIL ANY: STOP)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'fail', 'pass']);
      expect(actor.getSnapshot().context.substepResults).toEqual(['pass']);
    });

    it('handles FOR step without substeps gracefully', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          substeps: [],
          description: 'For without substeps',
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          description: 'Next',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // FOR with empty substeps is auto-skipped, machine starts at step 2
      expect(actor.getSnapshot().value).toBe('step::2');
      // PASS on step 2 completes the runbook
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('COMPLETE');
    });

    it('initializes FOR context when GOTO enters FOR step', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Start',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          name: '2',
          description: 'Skipped',
        },
        {
          name: '3',
          forClause: { start: 1, end: 2 },
          description: 'FOR entered via GOTO',
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '4',
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // GOTO from step 1 to step 3
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::1');
      const topGoto1 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topGoto1.iteration).toBe(1);
      expect(topGoto1.end).toBe(2);

      // Iteration 1: PASS → loop back
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::1');
      const topGoto2 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topGoto2.iteration).toBe(2);

      // Iteration 2: PASS → exit loop
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::4');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('NEXT skips remaining substeps and advances to next iteration', () => {
      const steps = inferSteps([
        {
          name: '2',
          description: 'Setup',
          transitions: DEFAULT_TRANSITIONS,
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
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
            {
              id: '2',
              description: 'Process (skipped by NEXT)',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '4',
          description: 'Commit',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Setup step → FOR step first substep
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::1');
      const topNext1 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topNext1.iteration).toBe(1);

      // Iteration 1: PASS on substep 1 → NEXT → skip substep 2, go to iteration 2's substep 1
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::1'); // Loop back to first substep
      const topNext2 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topNext2.iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

      // Iteration 2: PASS → NEXT → iteration 3
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::1');
      const topNext3 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topNext3.iteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);

      // Iteration 3 (last): PASS → NEXT → exit loop
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::4'); // Exit to next step
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('BREAK exits loop immediately regardless of remaining iterations', () => {
      const steps = inferSteps([
        {
          name: '2',
          description: 'Setup',
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '3',
          forClause: { start: 1, end: 5 },
          description: 'Process batches',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'BREAK' } },
              },
            },
            {
              id: '2',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '4',
          description: 'Commit',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Setup → FOR
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3::1');
      const topBreak1 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topBreak1.iteration).toBe(1);

      // Iteration 1: FAIL on substep 1 → BREAK → exit loop → FAIL ANY: STOP
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);
      expect(actor.getSnapshot().context.substepResults).toEqual(['fail']);
    });

    it('NEXT records iteration results correctly across iterations', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'Loop with NEXT on fail',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Step',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'NEXT' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'NEXT' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: FAIL → NEXT
      actor.send({ type: 'FAIL' });
      const topNextRes1 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topNextRes1.iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['fail']);

      // Iteration 2: PASS → NEXT
      actor.send({ type: 'PASS' });
      const topNextRes2 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topNextRes2.iteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['fail', 'pass']);

      // Iteration 3 (last): PASS → NEXT → exit → FAIL ANY: STOP
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
      expect(actor.getSnapshot().context.iterationResults).toEqual(['fail', 'pass']);
      expect(actor.getSnapshot().context.substepResults).toEqual(['pass']);
    });

    it('BREAK records the final iteration result before exiting', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 5 },
          description: 'Loop with early break',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Increment',
              transitions: DEFAULT_TRANSITIONS,
            },
            {
              id: '2',
              description: 'Check and break',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'BREAK' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: PASS → loop back
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::2');
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::1');
      const topBreakRes1 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topBreakRes1.iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

      // Iteration 2: PASS → PASS → loop back
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::2');
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::1');
      const topBreakRes2 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topBreakRes2.iteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);

      // Iteration 3: PASS → FAIL (BREAK) → exit loop → FAIL ANY: STOP
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::2');
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);
      expect(actor.getSnapshot().context.substepResults).toEqual(['pass', 'fail']);
    });

    it('NEXT outside FOR loop goes to STOPPED', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'No FOR clause',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'NEXT' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'NEXT' });
    });

    it('BREAK outside FOR loop goes to STOPPED', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'No FOR clause',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'BREAK' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'BREAK' });
    });

    it('GOTO AT re-enters FOR step at specific iteration', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Start',
          transitions: {
            all: true,
            pass: {
              kind: 'pass',
              retry: 0,
              action: { type: 'GOTO', target: { step: '2', at: 2 } },
            },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          name: '2',
          forClause: { start: 1, end: 3 },
          description: 'FOR loop',
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '3',
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // GOTO 2 AT 2 → enters FOR step at iteration 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2::1');
      const topAt1 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topAt1.iteration).toBe(2);
      expect(topAt1.start).toBe(1);
      expect(topAt1.end).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);

      // Iteration 2: PASS → loop back to iteration 3
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2::1');
      const topAt2 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topAt2.iteration).toBe(3);

      // Iteration 3: PASS → exit
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::3');
    });

    it('GOTO without AT targeting FOR step resets to first iteration', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Start',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          name: '2',
          forClause: { start: 1, end: 2 },
          description: 'FOR loop',
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '3',
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // GOTO 2 (no AT) → resets to iteration 1 (forClause.start)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2::1');
      const topNoAt =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topNoAt.iteration).toBe(1);
      expect(topNoAt.end).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);
    });

    it('GOTO event with AT initializes FOR context correctly', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Start',
        },
        {
          name: '2',
          forClause: { variable: 'batch', start: 1, end: 5 },
          description: 'FOR loop',
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '3',
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Send external GOTO event with AT
      actor.send({ type: 'GOTO', target: { step: '2', at: 3 } });
      expect(actor.getSnapshot().value).toBe('step::2::1');
      const topEvtAt =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topEvtAt.iteration).toBe(3);
      expect(topEvtAt.start).toBe(1);
      expect(topEvtAt.end).toBe(5);
      expect(topEvtAt.variable).toBe('batch');
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);
      // AT qualifier is preserved in lastAction for state persistence
      expect(actor.getSnapshot().context.lastAction).toEqual({
        type: 'GOTO',
        target: '2',
        substep: '1',
        at: 3,
      });
    });

    it('GOTO event without AT to FOR step resets iteration', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Start',
        },
        {
          name: '2',
          forClause: { start: 1, end: 3 },
          description: 'FOR loop',
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // External GOTO without AT to FOR step → reset
      actor.send({ type: 'GOTO', target: { step: '2' } });
      expect(actor.getSnapshot().value).toBe('step::2::1');
      const topEvtNoAt =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topEvtNoAt.iteration).toBe(1);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);
      // No AT qualifier in lastAction
      expect(actor.getSnapshot().context.lastAction).toEqual({
        type: 'GOTO',
        target: '2',
        substep: '1',
      });
    });

    it('GOTO from inside FOR loop to non-FOR step clears forStack', () => {
      // Step 1: non-FOR step
      // Step 2: FOR 1..3 with substeps, substep 1 PASS action = GOTO 1
      // Step 3: exit step
      // Flow: enter FOR at step 2, PASS substep 1 → GOTO step 1 → forStack cleared
      // Then GOTO back to step 2 → fresh loop (forStack has new context)
      const steps = inferSteps([
        {
          name: '1',
          description: 'Non-FOR target',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
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
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
            {
              id: '2',
              description: 'Substep 2',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '3',
          description: 'After loop',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

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
      const steps = inferSteps([
        {
          name: '1',
          description: 'Start',
          transitions: {
            all: true,
            pass: {
              kind: 'pass',
              retry: 0,
              action: { type: 'GOTO', target: { step: '2', at: '{{Offset}}' } },
            },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          name: '2',
          forClause: { start: 1, end: 3 },
          description: 'FOR loop',
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '3',
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

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
      const steps = inferSteps([
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
                fail: {
                  kind: 'fail',
                  retry: 0,
                  action: {
                    type: 'GOTO',
                    target: { step: '2', at: '{{Index}}' },
                  },
                },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Loop B',
          forClause: { start: 1, end: 5 },
          substeps: [
            {
              id: '1',
              description: 'Sub',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '3',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);
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
      const steps = inferSteps([
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
                fail: {
                  kind: 'fail',
                  retry: 0,
                  action: {
                    type: 'GOTO',
                    target: { step: '2', at: '{{item}}' },
                  },
                },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Loop B',
          forClause: { start: 1, end: 5 },
          substeps: [
            {
              id: '1',
              description: 'Sub',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '3',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);
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
      const steps = inferSteps([
        {
          name: '1',
          description: 'Start',
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          forClause: { start: 1, end: 3 },
          description: 'FOR with 2 substeps',
          substeps: [
            {
              id: '1',
              description: 'First',
              transitions: DEFAULT_TRANSITIONS,
            },
            {
              id: '2',
              description: 'Second',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '3',
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

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

  describe('implicit 1..1 loop model', () => {
    it('non-FOR step with substeps creates implicit ForContext on entry', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step with substeps, no FOR',
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ],
        },
        {
          name: '2',
          description: 'Next step',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);
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
        variable: undefined,
        source: { kind: 'range' as const },
      });
    });

    it('implicit 1..1 loop never loops back on CONTINUE', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step with substeps, no FOR',
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ],
        },
        {
          name: '2',
          description: 'Next step',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // substep 1 -> substep 2
      actor.send({ type: 'PASS' }); // substep 2 -> exits to step 2

      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('iterationResults is undefined after implicit loop exit', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Single substep, no FOR',
          substeps: [{ id: '1', description: 'Only sub', transitions: DEFAULT_TRANSITIONS }],
        },
        {
          name: '2',
          description: 'Next step',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' });

      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.iterationResults).toBeUndefined();
    });

    it('GOTO to non-FOR step with substeps initializes implicit ForContext', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Source',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          name: '2',
          description: 'Target with substeps, no FOR',
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ],
        },
        {
          name: '3',
          description: 'Final',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // GOTO step 2

      expect(actor.getSnapshot().value).toBe('step::2::1');
      const ctx = actor.getSnapshot().context;
      expect(ctx.forStack).toHaveLength(1);
      expect(ctx.forStack[0]).toEqual(expect.objectContaining({ stepId: '2', implicit: true }));
    });

    it('NEXT in non-FOR step still goes to STOPPED', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step with NEXT but no FOR',
          substeps: [
            {
              id: '1',
              description: 'Sub',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'NEXT' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
          ],
        },
        { name: '2', description: 'Unreachable', transitions: DEFAULT_TRANSITIONS },
      ]);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
    });

    it('BREAK in non-FOR step still goes to STOPPED', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step with BREAK but no FOR',
          substeps: [
            {
              id: '1',
              description: 'Sub',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'BREAK' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
          ],
        },
        { name: '2', description: 'Unreachable', transitions: DEFAULT_TRANSITIONS },
      ]);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
    });

    it('explicit FOR loop behavior is unchanged', () => {
      // Regression: existing FOR 1..3 must still loop correctly
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'FOR step',
          substeps: [{ id: '1', description: 'Sub', transitions: DEFAULT_TRANSITIONS }],
        },
        {
          name: '2',
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);
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

      // Iteration 3 (last) — final iteration computed inline
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2'); // exits
      expect(actor.getSnapshot().context.forStack).toEqual([]);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);
      expect(actor.getSnapshot().context.substepResults).toEqual(['pass']);
    });

    it('intra-loop GOTO preserves forStack', () => {
      const steps = inferSteps([
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
                fail: {
                  kind: 'fail',
                  retry: 0,
                  action: {
                    type: 'GOTO',
                    target: { step: '1', substep: '2' },
                  },
                },
              },
            },
            {
              id: '2',
              description: 'Second sub',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '2',
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);
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
      const steps = inferSteps([
        {
          name: '1',
          description: 'Source step',
          transitions: {
            all: true,
            pass: {
              kind: 'pass',
              retry: 0,
              action: { type: 'GOTO', target: { step: '2', substep: '1' } },
            },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          name: '2',
          description: 'FOR target',
          forClause: { start: 1, end: 3, variable: 'i' },
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ],
        },
        {
          name: '3',
          description: 'Final',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);
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
      const steps = inferSteps([
        {
          name: '1',
          description: 'Source step',
          transitions: {
            all: true,
            pass: {
              kind: 'pass',
              retry: 0,
              action: { type: 'GOTO', target: { step: '2', substep: '1', at: 2 } },
            },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          name: '2',
          description: 'FOR target',
          forClause: { start: 1, end: 3, variable: 'batch' },
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ],
        },
        {
          name: '3',
          description: 'Final',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);
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
      const steps = inferSteps([
        {
          name: '1',
          description: 'Source step',
          transitions: {
            all: true,
            pass: {
              kind: 'pass',
              retry: 0,
              action: { type: 'GOTO', target: { step: '2', substep: '2' } },
            },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          name: '2',
          description: 'Target with substeps, no FOR',
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ],
        },
        {
          name: '3',
          description: 'Final',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // GOTO 2.2
      expect(actor.getSnapshot().value).toBe('step::2::2');
      const ctx = actor.getSnapshot().context;
      expect(ctx.forStack).toHaveLength(1);
      expect(ctx.forStack[0]).toEqual(expect.objectContaining({ stepId: '2', implicit: true }));
      expect(ctx.iterationResults).toBeUndefined();
    });

    it('GOTO event to non-FOR substep uses unified ForContext path', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Source step',
          substeps: [{ id: '1', description: 'Sub', transitions: DEFAULT_TRANSITIONS }],
        },
        {
          name: '2',
          description: 'Target with substeps, no FOR',
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ],
        },
        {
          name: '3',
          description: 'Final',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // External GOTO to step 2's second substep
      actor.send({ type: 'GOTO', target: { step: '2', substep: '2' } });

      expect(actor.getSnapshot().value).toBe('step::2::2');
      const ctx = actor.getSnapshot().context;
      expect(ctx.forStack).toHaveLength(1);
      expect(ctx.forStack[0]).toEqual(expect.objectContaining({ stepId: '2', implicit: true }));
    });
  });

  describe('post-loop aggregation', () => {
    it('PASS ALL fails when any iteration failed', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'Loop with PASS ALL',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

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
      expect(snapshot.context.iterationResults).toEqual(['pass', 'fail']);
      expect(snapshot.context.substepResults).toEqual(['pass']);
    });

    it('PASS ALL fails when first iteration failed', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'Loop with PASS ALL',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

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
      expect(snapshot.context.iterationResults).toEqual(['fail', 'pass']);
      expect(snapshot.context.substepResults).toEqual(['pass']);
    });

    it('PASS ALL succeeds when all iterations pass', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'Loop with all passes',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Always pass',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '2',
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

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
      expect(snapshot.context.iterationResults).toEqual(['pass', 'pass']);
      expect(snapshot.context.substepResults).toEqual(['pass']);
    });

    it('PASS ANY succeeds when one iteration passes', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'Loop with PASS ANY',
          transitions: {
            all: false,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

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
      expect(snapshot.context.iterationResults).toEqual(['fail', 'pass']);
      expect(snapshot.context.substepResults).toEqual(['fail']);
    });

    it('BREAK triggers aggregation on accumulated results', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 5 },
          description: 'Loop with BREAK',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
            {
              id: '2',
              description: 'Maybe break',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'BREAK' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

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

      // BREAK at iter 3 with two loop-backs → aggregation uses substepResults
      // PASS ALL: substepResults [pass, fail] → has failure → STOP
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      expect(snapshot.context.iterationResults).toEqual(['pass', 'pass']);
      expect(snapshot.context.substepResults).toEqual(['pass', 'fail']);
    });

    it('NEXT at last iteration triggers aggregation', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          description: 'Loop with NEXT',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'NEXT' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'NEXT' } },
              },
            },
            {
              id: '2',
              description: 'Skipped by NEXT',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

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
      expect(snapshot.context.iterationResults).toEqual(['pass']);
      expect(snapshot.context.substepResults).toEqual(['pass']);
    });

    it('FAIL ALL triggers when all iterations fail under PASS ANY mode', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'Loop with PASS ANY',
          transitions: {
            all: false,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

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
      expect(snapshot.context.iterationResults).toEqual(['fail', 'fail']);
      expect(snapshot.context.substepResults).toEqual(['fail']);
    });

    it('PASS ALL with GOTO target records GOTO lastAction and initializes forStack for target FOR step', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          description: 'Loop that GOTOs on pass',
          transitions: {
            all: true,
            pass: {
              kind: 'pass',
              retry: 0,
              action: { type: 'GOTO', target: { step: '3', at: 1 } },
            },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Skipped step',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
        {
          name: '3',
          forClause: { start: 1, end: 3 },
          description: 'Target FOR step',
          substeps: [
            {
              id: '1',
              description: 'Target substep',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
      ]);

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
        {
          stepId: '3',
          iteration: 1,
          start: 1,
          end: 3,
          variable: undefined,
          implicit: false,
          source: { kind: 'range' as const },
        },
      ]);
      expect(snapshot.context.iterationResults).toEqual([]);
    });

    it('FAIL ANY with COMPLETE action records COMPLETE lastAction', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          description: 'Loop that COMPLETEs on fail',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'COMPLETE' } },
          },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

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
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          description: 'Loop that STOPs on pass',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'STOP' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
          },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

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

    it('PASS ALL failure triggers fail-path GOTO to non-FOR step', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          description: 'Loop that GOTOs on fail',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
          },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Skipped',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
        {
          name: '3',
          description: 'Error handler',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // iter 1 passes
      actor.send({ type: 'FAIL' }); // iter 2 fails

      // PASS ALL with one failure → aggregation fails → GOTO 3
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('step::3');
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: '3' });
      expect(snapshot.context.iterationResults).toEqual(['pass']);
      expect(snapshot.context.substepResults).toEqual(['fail']);
      expect(snapshot.context.forStack).toEqual([]);
    });

    it('PASS ALL failure triggers fail-path GOTO AT to target FOR step', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          description: 'Loop that GOTOs AT on fail',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: {
              kind: 'fail',
              retry: 0,
              action: { type: 'GOTO', target: { step: '3', at: 2 } },
            },
          },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Skipped',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
        {
          name: '3',
          forClause: { start: 1, end: 4 },
          description: 'Recovery loop',
          substeps: [
            {
              id: '1',
              description: 'Recover',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // iter 1 passes
      actor.send({ type: 'FAIL' }); // iter 2 fails

      // PASS ALL with one failure → aggregation fails → GOTO 3 AT 2
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('step::3::1');
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: '3', at: 2 });
      expect(snapshot.context.forStack).toEqual([
        {
          stepId: '3',
          iteration: 2,
          start: 1,
          end: 4,
          variable: undefined,
          implicit: false,
          source: { kind: 'range' as const },
        },
      ]);
      expect(snapshot.context.iterationResults).toEqual([]);
    });

    it('PASS ANY success triggers pass-path GOTO to non-FOR step', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'Loop with PASS ANY and GOTO',
          transitions: {
            all: false,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Skipped',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
        {
          name: '3',
          description: 'Success handler',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'FAIL' }); // iter 1 fails
      actor.send({ type: 'PASS' }); // iter 2 passes
      actor.send({ type: 'FAIL' }); // iter 3 fails

      // PASS ANY with one pass → aggregation passes → GOTO 3
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('step::3');
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: '3' });
      expect(snapshot.context.iterationResults).toEqual(['fail', 'pass']);
      expect(snapshot.context.substepResults).toEqual(['fail']);
      expect(snapshot.context.forStack).toEqual([]);
    });

    it('BREAK triggers aggregation and exits via pass-path GOTO', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 5 },
          description: 'Loop with BREAK and GOTO',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
            {
              id: '2',
              description: 'Maybe break',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'BREAK' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Skipped',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
        {
          name: '3',
          description: 'Post-break target',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: substep 1 PASS→CONTINUE, substep 2 PASS→BREAK
      actor.send({ type: 'PASS' }); // sub 1
      actor.send({ type: 'PASS' }); // sub 2 → BREAK

      // BREAK on iteration 1 with [PASS, PASS] → no loop-back, only substepResults
      // PASS ALL: no failures → aggregation passes → GOTO 3
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('step::3');
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: '3' });
      expect(snapshot.context.iterationResults).toEqual([]);
      expect(snapshot.context.substepResults).toEqual(['pass', 'pass']);
      expect(snapshot.context.forStack).toEqual([]);
    });
  });

  describe('descending FOR loop ranges', () => {
    it('iterates descending range (3, 2, 1) via CONTINUE', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 3, end: 1 },
          description: 'Descending loop',
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

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

      // Iteration 1 (last) → exit loop (final iteration computed inline)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);
      expect(actor.getSnapshot().context.substepResults).toEqual(['pass']);
    });

    it('BREAK exits descending loop immediately', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 5, end: 1 },
          description: 'Descending with break',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'BREAK' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(5);

      // FAIL → BREAK → exit loop → FAIL ANY: STOP
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('NEXT skips to next descending iteration', () => {
      const steps = inferSteps([
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
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
            {
              id: '2',
              description: 'Skipped by NEXT',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

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
      const steps = inferSteps([
        {
          name: '1',
          description: 'Start',
          transitions: {
            all: true,
            pass: {
              kind: 'pass',
              retry: 0,
              action: { type: 'GOTO', target: { step: '2', at: 4 } },
            },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          name: '2',
          forClause: { start: 5, end: 1 },
          description: 'Descending FOR',
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '3',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

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
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 5, end: 5 },
          description: 'Single iteration',
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

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
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 3, end: 1 },
          description: 'Descending with mixed results',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                all: true,
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

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

      // Iteration 1 (last): PASS → exit → FAIL ANY: STOP
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'fail']);
      expect(actor.getSnapshot().context.substepResults).toEqual(['pass']);
    });

    it('iterates descending range with two substeps', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 3, end: 1 },
          description: 'Descending with two substeps',
          substeps: [
            {
              id: '1',
              description: 'First check',
              transitions: DEFAULT_TRANSITIONS,
            },
            {
              id: '2',
              description: 'Second check',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

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
      // Should have exited to step 2 (final iteration computed inline)
      expect(snapshot.value).toBe('step::2');
      expect(snapshot.context.iterationResults).toEqual(['pass', 'pass']);
      expect(snapshot.context.substepResults).toEqual(['pass', 'pass']);
    });
  });

  describe('data source FOR loops', () => {
    it('creates ForContext with array source', () => {
      const steps = createRunbook(`
## 1. Process items
- FOR item IN {{ items }}
- PASS ALL: CONTINUE

### 1.1 Handle item
- PASS: CONTINUE

\`\`\`bash
echo "processing"
\`\`\`
`);
      const sources = {
        items: { kind: 'array' as const, items: ['alpha', 'beta', 'gamma'] },
      };
      const machine = compileRunbookToMachine(steps, { sources });
      const actor = createActor(machine);
      actor.start();

      const ctx = actor.getSnapshot().context;
      const top = ctx.forStack[0];
      expect(top.source).toEqual({ kind: 'array', items: ['alpha', 'beta', 'gamma'] });
      expect(top.start).toBe(1);
      expect(top.end).toBe(3); // clamped to items.length
      expect(top.variable).toBe('item');

      actor.stop();
    });

    it('iterates over array source values with currentValue advancing each iteration', () => {
      const steps = createRunbook(`
## 1. Process items
- FOR item IN {{ items }}
- PASS ALL: CONTINUE

### 1.1 Handle item
- PASS: CONTINUE

\`\`\`bash
echo "processing"
\`\`\`
`);
      const sources = {
        items: { kind: 'array' as const, items: ['alpha', 'beta', 'gamma'] },
      };
      const machine = compileRunbookToMachine(steps, { sources });
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: currentValue is undefined (resolved by ForIterationService)
      let ctx = actor.getSnapshot().context;
      let top = ctx.forStack[0];
      expect(top.iteration).toBe(1);
      expect(top.currentValue).toBeUndefined();

      // Send PASS to advance to iteration 2
      actor.send({ type: 'PASS' });
      ctx = actor.getSnapshot().context;
      top = ctx.forStack[0];
      expect(top.iteration).toBe(2);
      expect(top.currentValue).toBeUndefined();

      // Send PASS to advance to iteration 3
      actor.send({ type: 'PASS' });
      ctx = actor.getSnapshot().context;
      top = ctx.forStack[0];
      expect(top.iteration).toBe(3);
      expect(top.currentValue).toBeUndefined();

      // Send PASS to exit loop (no more iterations)
      actor.send({ type: 'PASS' });
      ctx = actor.getSnapshot().context;
      expect(ctx.forStack).toEqual([]);

      actor.stop();
    });

    it('clamps window end to array length', () => {
      const steps = createRunbook(`
## 1. Process items
- FOR item IN 1 TO 100 OF {{ items }}
- PASS ALL: CONTINUE

### 1.1 Handle item
- PASS: CONTINUE

\`\`\`bash
echo "processing"
\`\`\`
`);
      const sources = {
        items: { kind: 'array' as const, items: ['a', 'b', 'c'] },
      };
      const machine = compileRunbookToMachine(steps, { sources });
      const actor = createActor(machine);
      actor.start();

      const ctx = actor.getSnapshot().context;
      const top = ctx.forStack[0];
      expect(top.end).toBe(3); // clamped from 100 to items.length
      expect(top.source).toEqual({ kind: 'array', items: ['a', 'b', 'c'] });

      actor.stop();
    });

    it('rejects undefined source variable', () => {
      const steps = createRunbook(`
## 1. Process items
- FOR item IN {{ missing }}
- PASS ALL: CONTINUE

### 1.1 Handle item
- PASS: CONTINUE

\`\`\`bash
echo "processing"
\`\`\`
`);
      // No sources entry for 'missing'
      const machine = compileRunbookToMachine(steps, { sources: {} });
      const actor = createActor(machine);

      // XState v5 surfaces entry action errors through the actor's error state
      let capturedError: unknown;
      actor.subscribe({
        error: (err) => {
          capturedError = err;
        },
      });
      actor.start();
      expect(capturedError).toBeDefined();
      expect(String(capturedError)).toMatch(/Data source "missing" is not defined/);
      expect(actor.getSnapshot().status).toBe('error');
    });

    it('handles empty array source (0 iterations)', () => {
      const steps = createRunbook(`
## 1. Process items
- FOR item IN {{ items }}
- PASS ALL: CONTINUE

### 1.1 Handle item
- PASS: CONTINUE

\`\`\`bash
echo "processing"
\`\`\`
`);
      const sources = {
        items: { kind: 'array' as const, items: [] },
      };
      const machine = compileRunbookToMachine(steps, { sources });
      const actor = createActor(machine);
      actor.start();

      const ctx = actor.getSnapshot().context;
      const top = ctx.forStack[0];
      expect(top.end).toBe(1); // empty → end equals start, no iterations
      // Loop should exit immediately on first PASS
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().context.forStack).toEqual([]);

      actor.stop();
    });

    it('iterates windowed array source (2 TO 4) with correct currentValue', () => {
      const steps = createRunbook(`
## 1. Process items
- FOR item IN 2 TO 4 OF {{ items }}
- PASS ALL: CONTINUE

### 1.1 Handle item
- PASS: CONTINUE

\`\`\`bash
echo "processing"
\`\`\`
`);
      const sources = {
        items: { kind: 'array' as const, items: ['a', 'b', 'c', 'd', 'e'] },
      };
      const machine = compileRunbookToMachine(steps, { sources });
      const actor = createActor(machine);
      actor.start();

      // Iteration 2: currentValue is undefined (resolved by ForIterationService)
      let ctx = actor.getSnapshot().context;
      let top = ctx.forStack[0];
      expect(top.iteration).toBe(2);
      expect(top.currentValue).toBeUndefined();

      // Send PASS to advance to iteration 3
      actor.send({ type: 'PASS' });
      ctx = actor.getSnapshot().context;
      top = ctx.forStack[0];
      expect(top.iteration).toBe(3);
      expect(top.currentValue).toBeUndefined();

      // Send PASS to advance to iteration 4
      actor.send({ type: 'PASS' });
      ctx = actor.getSnapshot().context;
      top = ctx.forStack[0];
      expect(top.iteration).toBe(4);
      expect(top.currentValue).toBeUndefined();

      // Send PASS to exit loop (no more iterations)
      actor.send({ type: 'PASS' });
      ctx = actor.getSnapshot().context;
      expect(ctx.forStack).toEqual([]);

      actor.stop();
    });

    it('GOTO intra-loop preserves forStack with array source', () => {
      const DEFAULT_TRANSITIONS_LOCAL = {
        all: true,
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
      };

      const steps = inferSteps([
        {
          name: '1',
          description: 'Loop step',
          forClause: { start: 1, end: 2, variable: 'item', source: 'items' },
          substeps: [
            {
              id: '1',
              description: 'First sub',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: {
                  kind: 'fail' as const,
                  retry: 0,
                  action: { type: 'GOTO' as const, target: { step: '1', substep: '2' } },
                },
              },
            },
            {
              id: '2',
              description: 'Second sub',
              transitions: DEFAULT_TRANSITIONS_LOCAL,
            },
          ],
        },
        {
          name: '2',
          description: 'After loop',
          transitions: {
            ...DEFAULT_TRANSITIONS_LOCAL,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
          },
        },
      ]);
      const sources = { items: { kind: 'array' as const, items: ['x', 'y'] } };
      const machine = compileRunbookToMachine(steps, { sources });
      const actor = createActor(machine);
      actor.start();

      // Initial state: iteration 1, currentValue undefined (resolved by ForIterationService)
      let ctx = actor.getSnapshot().context;
      let top = ctx.forStack[0];
      expect(top.iteration).toBe(1);
      expect(top.currentValue).toBeUndefined();
      expect(top.source).toEqual({ kind: 'array', items: ['x', 'y'] });

      // Send FAIL to trigger GOTO 1.2
      actor.send({ type: 'FAIL' });
      ctx = actor.getSnapshot().context;
      top = ctx.forStack[0];
      // forStack should still be preserved with same iteration
      expect(top.iteration).toBe(1);
      expect(top.currentValue).toBeUndefined();
      expect(top.source).toEqual({ kind: 'array', items: ['x', 'y'] });

      // Send PASS at 1.2 to loop back to 1.1 iteration 2
      actor.send({ type: 'PASS' });
      ctx = actor.getSnapshot().context;
      top = ctx.forStack[0];
      expect(top.iteration).toBe(2);
      expect(top.currentValue).toBeUndefined();

      actor.stop();
    });

    it('GOTO cross-loop initializes forStack for array source step', () => {
      const DEFAULT_TRANSITIONS_LOCAL = {
        all: true,
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
      };

      const steps = inferSteps([
        {
          name: '1',
          description: 'Source step',
          transitions: {
            all: true,
            pass: {
              kind: 'pass' as const,
              retry: 0,
              action: { type: 'GOTO' as const, target: { step: '2', substep: '1' } },
            },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        },
        {
          name: '2',
          description: 'FOR target',
          forClause: { start: 1, end: 3, variable: 'item', source: 'items' },
          substeps: [{ id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS_LOCAL }],
        },
        {
          name: '3',
          description: 'Final',
          transitions: {
            ...DEFAULT_TRANSITIONS_LOCAL,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
          },
        },
      ]);
      const sources = { items: { kind: 'array' as const, items: ['a', 'b', 'c'] } };
      const machine = compileRunbookToMachine(steps, { sources });
      const actor = createActor(machine);
      actor.start();

      // Send PASS to trigger GOTO 2.1
      actor.send({ type: 'PASS' });
      const ctx = actor.getSnapshot().context;
      const top = ctx.forStack[0];

      // Verify forStack initialized with array source at iteration 1
      // currentValue is undefined — resolved by ForIterationService before execution
      expect(top.source).toEqual({ kind: 'array', items: ['a', 'b', 'c'] });
      expect(top.start).toBe(1);
      expect(top.end).toBe(3);
      expect(top.iteration).toBe(1);
      expect(top.currentValue).toBeUndefined();

      actor.stop();
    });

    it('GOTO cross-loop with AT into array source resolves correct currentValue', () => {
      const DEFAULT_TRANSITIONS_LOCAL = {
        all: true,
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
      };

      const steps = inferSteps([
        {
          name: '1',
          description: 'Source step',
          transitions: {
            all: true,
            pass: {
              kind: 'pass' as const,
              retry: 0,
              action: { type: 'GOTO' as const, target: { step: '2', substep: '1', at: 2 } },
            },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        },
        {
          name: '2',
          description: 'FOR target',
          forClause: { start: 1, end: 3, variable: 'item', source: 'items' },
          substeps: [{ id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS_LOCAL }],
        },
        {
          name: '3',
          description: 'Final',
          transitions: {
            ...DEFAULT_TRANSITIONS_LOCAL,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
          },
        },
      ]);
      const sources = { items: { kind: 'array' as const, items: ['a', 'b', 'c'] } };
      const machine = compileRunbookToMachine(steps, { sources });
      const actor = createActor(machine);
      actor.start();

      // Send PASS to trigger GOTO 2.1 AT 2
      actor.send({ type: 'PASS' });
      const ctx = actor.getSnapshot().context;
      const top = ctx.forStack[0];

      // Verify forStack initialized with array source at iteration 2
      // currentValue is undefined — resolved by ForIterationService before execution
      expect(top.source).toEqual({ kind: 'array', items: ['a', 'b', 'c'] });
      expect(top.start).toBe(1);
      expect(top.end).toBe(3);
      expect(top.iteration).toBe(2);
      expect(top.currentValue).toBeUndefined();

      actor.stop();
    });

    it('iterates descending array source window (4 TO 2)', () => {
      const steps = createRunbook(`
## 1. Process items
- FOR item IN 4 TO 2 OF {{ items }}
- PASS ALL: CONTINUE

### 1.1 Handle item
- PASS: CONTINUE

\`\`\`bash
echo "processing"
\`\`\`
`);
      const sources = {
        items: { kind: 'array' as const, items: ['a', 'b', 'c', 'd', 'e'] },
      };
      const machine = compileRunbookToMachine(steps, { sources });
      const actor = createActor(machine);
      actor.start();

      // Iteration 4 (start)
      let ctx = actor.getSnapshot().context;
      let top = ctx.forStack[0];
      expect(top.iteration).toBe(4);
      expect(top.start).toBe(4);
      expect(top.end).toBe(2);

      // Send PASS to advance to iteration 3
      actor.send({ type: 'PASS' });
      ctx = actor.getSnapshot().context;
      top = ctx.forStack[0];
      expect(top.iteration).toBe(3);

      // Send PASS to advance to iteration 2
      actor.send({ type: 'PASS' });
      ctx = actor.getSnapshot().context;
      top = ctx.forStack[0];
      expect(top.iteration).toBe(2);

      // Send PASS to exit loop (no more iterations)
      actor.send({ type: 'PASS' });
      ctx = actor.getSnapshot().context;
      expect(ctx.forStack).toEqual([]);

      actor.stop();
    });

    it('compiles descending file source window (3 TO 1)', () => {
      const DEFAULT_TRANSITIONS_LOCAL = {
        all: true,
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
      };

      const steps = inferSteps([
        {
          name: '1',
          description: 'File loop',
          forClause: { start: 3, end: 1, variable: 'server', source: 'servers' },
          substeps: [
            {
              id: '1',
              description: 'Process {{server}}',
              transitions: DEFAULT_TRANSITIONS_LOCAL,
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS_LOCAL,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
          },
        },
      ]);

      const sources = {
        servers: { kind: 'file' as const, path: '/tmp/servers.txt', format: 'text' as const },
      };

      const machine = compileRunbookToMachine(steps, { sources });
      const actor = createActor(machine);
      actor.start();

      const ctx = actor.getSnapshot().context;
      const top = ctx.forStack[0];

      expect(top.source).toEqual({
        kind: 'file',
        path: '/tmp/servers.txt',
        format: 'text',
        snapshot: null,
      });
      expect(top.start).toBe(3);
      expect(top.end).toBe(1);
      expect(top.iteration).toBe(3);
      expect(top.currentValue).toBeUndefined();

      actor.stop();
    });
  });

  describe('MAX_FILE_ITERATIONS circuit breaker', () => {
    it('is exported as a positive number', () => {
      expect(typeof MAX_FILE_ITERATIONS).toBe('number');
      expect(MAX_FILE_ITERATIONS).toBeGreaterThan(0);
      expect(MAX_FILE_ITERATIONS).toBe(10_000);
    });

    it('stops file source loop when currentValue is undefined (no execution layer)', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'File loop',
          forClause: {
            variable: 'line',
            start: 1,
            source: 'lines',
          },
          substeps: [
            {
              id: '1',
              description: 'Process {{line}}',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
      ]);

      const machine = compileRunbookToMachine(steps, {
        sources: {
          lines: { kind: 'file', path: '/tmp/test.txt', format: 'text' },
        },
      });

      const actor = createActor(machine);
      actor.start();

      const ctx = actor.getSnapshot().context;
      expect(ctx.forStack.length).toBe(1);
      expect(ctx.forStack[0].end).toBeUndefined();
      expect(ctx.forStack[0].currentValue).toBeUndefined();

      // Without execution layer setting currentValue, loop exits on first PASS
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
      expect(snapshot.context.forStack).toEqual([]);

      actor.stop();
    });

    it('file loop continues when currentValue IS set', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'File loop',
          forClause: {
            variable: 'line',
            start: 1,
            source: 'lines',
          },
          substeps: [
            {
              id: '1',
              description: 'Process {{line}}',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
      ]);

      const machine = compileRunbookToMachine(steps, {
        sources: {
          lines: { kind: 'file', path: '/tmp/test.txt', format: 'text' },
        },
      });

      // Start actor and inject currentValue via snapshot rehydration
      const actor = createActor(machine);
      actor.start();
      const snap = actor.getSnapshot();
      const ctx = snap.context;
      actor.stop();

      const persisted = {
        ...snap,
        context: { ...ctx, forStack: [{ ...ctx.forStack[0], currentValue: 'line-1' }] },
      };

      const actor2 = createActor(machine, { snapshot: persisted });
      actor2.start();

      // With currentValue set, loop-back guard passes and iteration advances
      actor2.send({ type: 'PASS' });
      expect(actor2.getSnapshot().context.forStack[0].iteration).toBe(2);

      actor2.stop();
    });

    it('allows high-offset file loops to iterate (cap is on processed count)', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'File loop from offset',
          forClause: {
            variable: 'line',
            start: 20000,
            source: 'lines',
          },
          substeps: [
            {
              id: '1',
              description: 'Process {{line}}',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
      ]);

      const machine = compileRunbookToMachine(steps, {
        sources: {
          lines: { kind: 'file', path: '/tmp/test.txt', format: 'text' },
        },
      });

      const actor = createActor(machine);
      actor.start();

      const snap = actor.getSnapshot();
      expect(snap.context.forStack[0].start).toBe(20000);
      expect(snap.context.forStack[0].iteration).toBe(20000);
      actor.stop();

      // Inject currentValue to simulate execution layer — verifies cap is on processed count
      const persisted = {
        ...snap,
        context: {
          ...snap.context,
          forStack: [{ ...snap.context.forStack[0], currentValue: 'line-data' }],
        },
      };
      const actor2 = createActor(machine, { snapshot: persisted });
      actor2.start();

      // Should still allow iteration since processed count is 0 (not capped by absolute iteration)
      actor2.send({ type: 'PASS' });
      expect(actor2.getSnapshot().context.forStack[0].iteration).toBe(20001);

      actor2.stop();
    });
  });

  describe('file source snapshot initialisation', () => {
    it('initialises file source snapshot as null instead of a sentinel object', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'File loop',
          forClause: {
            variable: 'line',
            start: 1,
            source: 'data',
          },
          substeps: [
            {
              id: '1',
              description: 'Process {{line}}',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
      ]);

      const machine = compileRunbookToMachine(steps, {
        sources: {
          data: { kind: 'file', path: '/tmp/data.txt', format: 'text' },
        },
      });

      const actor = createActor(machine);
      actor.start();

      const ctx = actor.getSnapshot().context;
      expect(ctx.forStack.length).toBe(1);
      const source = ctx.forStack[0].source;
      expect(source.kind).toBe('file');
      if (source.kind === 'file') {
        expect(source.snapshot).toBeNull();
      }

      actor.stop();
    });
  });

  describe('FOR shorthand canonicalization', () => {
    it('iterates a FOR step defined via step-level runbook-list shorthand', () => {
      const steps = createRunbook(`
## 1. Review the plan
- FOR pass IN 1 TO 2
- PASS ALL: CONTINUE
- FAIL ANY: STOP

- review-technical-accuracy.runbook.md

## 2. Done
- PASS: COMPLETE
`);

      expect((steps[0] as any).substeps?.[0]).toMatchObject({
        id: '1',
        runbooks: ['review-technical-accuracy.runbook.md'],
      });

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().value).toBe('step::1::1');

      actor.send({ type: 'PASS' }); // iteration 1 complete -> loop back to iteration 2
      expect(actor.getSnapshot().value).toBe('step::1::1');
      expect(actor.getSnapshot().context.forStack[0]?.iteration).toBe(2);

      actor.send({ type: 'PASS' }); // iteration 2 complete (final) -> PASS ALL -> step 2
      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);
      expect(actor.getSnapshot().context.substepResults).toEqual(['pass']);
    });

    it('evaluates FAIL ANY across shorthand iterations and routes to GOTO target', () => {
      const steps = createRunbook(`
## 1. Review the plan
- FOR pass IN 1 TO 2
- PASS ALL: CONTINUE
- FAIL ANY: GOTO Synthesize

- review-technical-accuracy.runbook.md

## 2. Skipped
- PASS: COMPLETE

## Synthesize
- PASS: COMPLETE
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // iteration 1
      actor.send({ type: 'FAIL' }); // iteration 2 (final) -> FAIL ANY -> GOTO Synthesize

      expect(actor.getSnapshot().value).toBe('step::Synthesize');
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);
      expect(actor.getSnapshot().context.substepResults).toEqual(['fail']);
    });

    it('GOTO to shorthand-canonicalized FOR step enters substep .1', () => {
      const steps = createRunbook(`
## 1. Start
- PASS: GOTO 2
- FAIL: STOP

## 2. Review the plan
- FOR pass IN 1 TO 2
- PASS ALL: CONTINUE
- FAIL ANY: STOP

- review-technical-accuracy.runbook.md

## 3. Done
- PASS: COMPLETE
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().value).toBe('step::1');

      actor.send({ type: 'PASS' }); // GOTO 2 -> first substep
      expect(actor.getSnapshot().value).toBe('step::2::1');
      expect(actor.getSnapshot().context.forStack[0]?.stepId).toBe('2');
    });

    it('iterates a FOR step with multiple shorthand runbooks', () => {
      const steps = createRunbook(`
## 1. Review the plan
- FOR pass IN 1 TO 2
- PASS ALL: CONTINUE
- FAIL ANY: STOP

- review-technical-accuracy.runbook.md
- review-structural-integrity.runbook.md
- review-build-runtime.runbook.md
- review-risk-safety.runbook.md

## 2. Done
- PASS: COMPLETE
`);

      // All four runbooks canonicalized into four implicit substeps (one runbook each)
      expect((steps[0] as any).substeps).toHaveLength(4);
      expect((steps[0] as any).substeps?.map((substep: any) => substep.runbooks)).toEqual([
        ['review-technical-accuracy.runbook.md'],
        ['review-structural-integrity.runbook.md'],
        ['review-build-runtime.runbook.md'],
        ['review-risk-safety.runbook.md'],
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().value).toBe('step::1::1');

      actor.send({ type: 'PASS' }); // iteration 1, substep 1 -> substep 2
      expect(actor.getSnapshot().value).toBe('step::1::2');
      expect(actor.getSnapshot().context.forStack[0]?.iteration).toBe(1);

      actor.send({ type: 'PASS' }); // substep 2 -> substep 3
      expect(actor.getSnapshot().value).toBe('step::1::3');

      actor.send({ type: 'PASS' }); // substep 3 -> substep 4
      expect(actor.getSnapshot().value).toBe('step::1::4');

      actor.send({ type: 'PASS' }); // end iteration 1 -> iteration 2 substep 1
      expect(actor.getSnapshot().value).toBe('step::1::1');
      expect(actor.getSnapshot().context.forStack[0]?.iteration).toBe(2);

      actor.send({ type: 'PASS' }); // iteration 2, substep 1
      actor.send({ type: 'PASS' }); // iteration 2, substep 2
      actor.send({ type: 'PASS' }); // iteration 2, substep 3
      actor.send({ type: 'PASS' }); // iteration 2, substep 4 -> PASS ALL -> step 2
      expect(actor.getSnapshot().value).toBe('step::2');
    });
  });

  describe('non-FOR substep aggregation', () => {
    it('PASS ALL: CONTINUE advances when all pass', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Review step',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
            {
              id: '2',
              description: 'Check 2',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // 1.1 passes
      actor.send({ type: 'PASS' }); // 1.2 passes -> parent -> PASS ALL -> step::2

      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);
    });

    it('FAIL ANY: GOTO routes to target step on failure', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Review step',
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: {
              kind: 'fail' as const,
              retry: 0,
              action: { type: 'GOTO' as const, target: { step: '3' } },
            },
          },
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
            {
              id: '2',
              description: 'Check 2',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        { name: '2', description: 'Skipped', transitions: DEFAULT_TRANSITIONS },
        { name: '3', description: 'Error handler', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // 1.1 passes
      actor.send({ type: 'FAIL' }); // 1.2 fails -> parent -> FAIL ANY -> GOTO 3

      expect(actor.getSnapshot().value).toBe('step::3');
    });

    it('parent GOTO to non-first implicit substep does not reuse prior aggregation results', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Source with mixed outcomes',
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: {
              kind: 'fail' as const,
              retry: 0,
              action: { type: 'GOTO' as const, target: { step: '2', substep: '2' } },
            },
          },
          substeps: [
            {
              id: '1',
              description: 'Source check 1',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
            {
              id: '2',
              description: 'Source check 2',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Target implicit step',
          transitions: {
            all: true,
            pass: {
              kind: 'pass' as const,
              retry: 0,
              action: { type: 'GOTO' as const, target: { step: '3' } },
            },
            fail: {
              kind: 'fail' as const,
              retry: 0,
              action: { type: 'GOTO' as const, target: { step: '4' } },
            },
          },
          substeps: [
            { id: '1', description: 'Target check 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Target check 2', transitions: DEFAULT_TRANSITIONS },
          ],
        },
        { name: '3', description: 'Pass handler', transitions: DEFAULT_TRANSITIONS },
        { name: '4', description: 'Fail handler', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // 1.1
      actor.send({ type: 'FAIL' }); // 1.2 -> parent FAIL -> GOTO 2.2
      expect(actor.getSnapshot().value).toBe('step::2::2');

      actor.send({ type: 'PASS' }); // 2.2 -> parent PASS ALL -> should route to 3
      expect(actor.getSnapshot().value).toBe('step::3');
    });

    it('PASS ANY: CONTINUE advances when any passes', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Review step',
          transitions: {
            all: false,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
            {
              id: '2',
              description: 'Check 2',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'FAIL' }); // 1.1 fails
      actor.send({ type: 'PASS' }); // 1.2 passes -> parent -> PASS ANY -> step::2

      expect(actor.getSnapshot().value).toBe('step::2');
    });

    it('single substep aggregation works correctly', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Review step',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Only check',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      // Test FAIL path
      const machine1 = compileRunbookToMachine(steps);
      const actor1 = createActor(machine1);
      actor1.start();
      actor1.send({ type: 'FAIL' });
      expect(actor1.getSnapshot().value).toBe('STOPPED');

      // Test PASS path
      const machine2 = compileRunbookToMachine(steps);
      const actor2 = createActor(machine2);
      actor2.start();
      actor2.send({ type: 'PASS' });
      expect(actor2.getSnapshot().value).toBe('step::2');
    });

    it('three substeps with mixed results and PASS ALL short-circuits on failure', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Review step',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
            {
              id: '2',
              description: 'Check 2',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
            {
              id: '3',
              description: 'Check 3',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // 1.1 passes → advance to 1.2
      // 1.2 fails → fail-fast: FAIL ANY (all=true) short-circuits to STOPPED
      actor.send({ type: 'FAIL' });

      expect(actor.getSnapshot().value).toBe('STOPPED');
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'fail']);
    });

    it('FOR loop iterates through parent state', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'FOR loop',
          forClause: { start: 1, end: 3 },
          transitions: DEFAULT_TRANSITIONS,
          substeps: [{ id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS }],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // iteration 1 -> parent -> loop-back
      actor.send({ type: 'PASS' }); // iteration 2 -> parent -> loop-back
      actor.send({ type: 'PASS' }); // iteration 3 (final) -> parent -> PASS ALL -> step::2

      expect(actor.getSnapshot().value).toBe('step::2');
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);
      expect(actor.getSnapshot().context.substepResults).toEqual(['pass']);
    });

    it('BREAK exits FOR loop via parent state', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'FOR loop',
          forClause: { start: 1, end: 3 },
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
          },
          substeps: [
            {
              id: '1',
              description: 'Sub 1',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'BREAK' as const } },
              },
            },
          ],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // iteration 1 pass -> parent -> loop-back
      actor.send({ type: 'FAIL' }); // iteration 2 fail -> BREAK -> parent -> skip loop-back -> step::2

      expect(actor.getSnapshot().value).toBe('step::2');
    });

    it('NEXT skips to next iteration via parent state', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'FOR loop',
          forClause: { start: 1, end: 3 },
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Sub 1',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'NEXT' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
            {
              id: '2',
              description: 'Sub 2',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: substep 1 passes -> NEXT -> parent -> loop-back (skips substep 2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::1'); // back at first substep, iteration 2

      // Iteration 2: substep 1 passes -> NEXT -> parent -> loop-back
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::1::1'); // iteration 3

      // Iteration 3: substep 1 passes -> NEXT -> parent -> aggregation -> step::2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2');
    });

    it('FAIL ALL: STOP stops when all substeps fail under PASS ANY mode', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Review step',
          transitions: {
            all: false,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
            {
              id: '2',
              description: 'Check 2',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'FAIL' }); // 1.1 fails
      actor.send({ type: 'FAIL' }); // 1.2 fails -> parent -> FAIL ALL -> STOPPED

      expect(actor.getSnapshot().value).toBe('STOPPED');
      expect(actor.getSnapshot().context.iterationResults).toEqual(['fail', 'fail']);
    });

    it('parent transitions with retry re-runs substeps before terminal action', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Retry step',
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
          },
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // First attempt: fail -> parent -> retry (retryCount < 1) -> back to 1.1
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('step::1::1');
      expect(actor.getSnapshot().context.retryCount).toBe(1);

      // Second attempt: fail -> parent -> exhausted (retryCount >= 1) -> STOPPED
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
    });

    it('parent retry exhausts after configured attempts across multiple substeps', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Multi-substep retry',
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
          },
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
            {
              id: '2',
              description: 'Check 2',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // With fail-fast (FAIL ANY, no AWAIT), first FAIL short-circuits to parent
      actor.send({ type: 'FAIL' }); // 1.1 -> parent (fail-fast) -> retry #1 -> 1.1
      expect(actor.getSnapshot().value).toBe('step::1::1');

      actor.send({ type: 'FAIL' }); // 1.1 -> parent (fail-fast) -> retries exhausted -> STOPPED
      expect(actor.getSnapshot().value).toBe('STOPPED');
    });

    it('cross-step substep GOTO resets parentRetryCount before target parent retries', () => {
      const substepContinueTransitions = {
        all: true,
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      };

      const steps = inferSteps([
        {
          name: '1',
          description: 'Source with parent retry',
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
          },
          substeps: [
            {
              id: '1',
              description: 'Jump to target',
              transitions: {
                all: true,
                pass: {
                  kind: 'pass' as const,
                  retry: 0,
                  action: { type: 'GOTO' as const, target: { step: '2', substep: '2' } },
                },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
            {
              id: '2',
              description: 'Fail to trigger parent retry',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Target with parent retry',
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
          },
          substeps: [
            { id: '1', description: 'Target 1', transitions: substepContinueTransitions },
            { id: '2', description: 'Target 2', transitions: substepContinueTransitions },
          ],
        },
        { name: '3', description: 'Done', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // With fail-fast (FAIL ANY, no AWAIT), first FAIL short-circuits to parent
      actor.send({ type: 'FAIL' }); // 1.1 -> parent (fail-fast) -> retry #1 -> 1.1
      expect(actor.getSnapshot().context.parentRetryCount).toBe(1);

      actor.send({ type: 'PASS' }); // 1.1 -> GOTO 2.2 (bypass parent)
      expect(actor.getSnapshot().value).toBe('step::2::2');
      expect(actor.getSnapshot().context.parentRetryCount).toBe(0);

      // 2.2 fail-fast to parent -> parent should retry, not exhaust
      actor.send({ type: 'FAIL' }); // 2.2 -> parent (fail-fast) -> retry -> 2.1
      expect(actor.getSnapshot().value).toBe('step::2::1');
    });

    it('cross-step GOTO event resets parentRetryCount before target parent retries', () => {
      const substepContinueTransitions = {
        all: true,
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      };

      const steps = inferSteps([
        {
          name: '1',
          description: 'Source with parent retry',
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
          },
          substeps: [
            { id: '1', description: 'Source 1', transitions: substepContinueTransitions },
            { id: '2', description: 'Source 2', transitions: substepContinueTransitions },
          ],
        },
        {
          name: '2',
          description: 'Target with parent retry',
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
          },
          substeps: [
            { id: '1', description: 'Target 1', transitions: substepContinueTransitions },
            { id: '2', description: 'Target 2', transitions: substepContinueTransitions },
          ],
        },
        { name: '3', description: 'Done', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // With fail-fast (FAIL ANY, no AWAIT), first FAIL short-circuits to parent
      actor.send({ type: 'FAIL' }); // 1.1 -> parent (fail-fast) -> retry #1 -> 1.1
      expect(actor.getSnapshot().context.parentRetryCount).toBe(1);

      actor.send({ type: 'GOTO', target: { step: '2', substep: '2' } });
      expect(actor.getSnapshot().value).toBe('step::2::2');
      expect(actor.getSnapshot().context.parentRetryCount).toBe(0);

      // 2.2 fail-fast to parent -> parent should retry, not exhaust
      actor.send({ type: 'FAIL' }); // 2.2 -> parent (fail-fast) -> retry -> 2.1
      expect(actor.getSnapshot().value).toBe('step::2::1');
    });

    it('parent COMPLETE action forces early completion', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Complete step',
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        { name: '2', description: 'Should be skipped', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // 1.1 passes -> parent -> PASS ALL -> COMPLETE

      expect(actor.getSnapshot().value).toBe('COMPLETE');
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'COMPLETE' });
    });

    describe('2-substep delegation bug scenarios', () => {
      it('Test A: explicit CONTINUE substeps with PASS ALL: COMPLETE parent — PASS 1.1 advances to 1.2', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              all: true,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            substeps: [
              {
                id: '1',
                description: 'Substep 1',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                },
              },
              {
                id: '2',
                description: 'Substep 2',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                },
              },
            ],
          },
        ]);

        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        actor.send({ type: 'PASS' }); // 1.1 passes -> should advance to 1.2, NOT COMPLETE

        expect(actor.getSnapshot().value).toBe('step::1::2');
        expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'CONTINUE' });
      });

      it('Test B: explicit CONTINUE substeps with PASS ALL: COMPLETE parent — PASS both completes', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              all: true,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            substeps: [
              {
                id: '1',
                description: 'Substep 1',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                },
              },
              {
                id: '2',
                description: 'Substep 2',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                },
              },
            ],
          },
        ]);

        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        actor.send({ type: 'PASS' }); // 1.1 passes -> 1.2
        actor.send({ type: 'PASS' }); // 1.2 passes -> parent -> PASS ALL -> COMPLETE

        expect(actor.getSnapshot().value).toBe('COMPLETE');
        expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'COMPLETE' });
      });

      it('Test C: explicit CONTINUE substeps with PASS ALL: COMPLETE parent — PASS then FAIL stops', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              all: true,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            substeps: [
              {
                id: '1',
                description: 'Substep 1',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                },
              },
              {
                id: '2',
                description: 'Substep 2',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                },
              },
            ],
          },
        ]);

        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        actor.send({ type: 'PASS' }); // 1.1 passes -> 1.2
        actor.send({ type: 'FAIL' }); // 1.2 fails -> parent -> ALL failed -> STOP

        expect(actor.getSnapshot().value).toBe('STOPPED');
      });

      it('Test D: no explicit substep transitions (inferred defaults) with PASS ALL: COMPLETE parent — PASS 1.1 advances to 1.2', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              all: true,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            substeps: [
              {
                id: '1',
                description: 'Substep 1',
                // No transitions — rely on compiler inferring DEFAULT_AGGREGATION_SUBSTEP_TRANSITIONS
              },
              {
                id: '2',
                description: 'Substep 2',
                // No transitions — rely on compiler inferring DEFAULT_AGGREGATION_SUBSTEP_TRANSITIONS
              },
            ],
          },
        ]);

        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        actor.send({ type: 'PASS' }); // 1.1 passes -> should advance to 1.2, NOT COMPLETE

        expect(actor.getSnapshot().value).toBe('step::1::2');
        expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'CONTINUE' });
      });

      it('Test E: substep with explicit COMPLETE transition defers to parent aggregation on non-last substep', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              all: true,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            substeps: [
              {
                id: '1',
                description: 'Substep 1',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
                },
              },
              {
                id: '2',
                description: 'Substep 2',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
                },
              },
            ],
          },
        ]);

        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Substep 1.1 has explicit COMPLETE, but defense-in-depth defers to parent aggregation
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().value).toBe('step::1::2');

        // Substep 1.2 is last substep — COMPLETE goes through parent aggregation → COMPLETE
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().value).toBe('COMPLETE');
      });

      it('Test F: substep FAIL with FAIL ANY (all=true) short-circuits to STOPPED on first fail', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              all: true,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            substeps: [
              {
                id: '1',
                description: 'Substep 1',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
                },
              },
              {
                id: '2',
                description: 'Substep 2',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
                },
              },
            ],
          },
        ]);

        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Substep 1.1 fails — with FAIL ANY (all=true, no AWAIT), first fail short-circuits to STOPPED
        actor.send({ type: 'FAIL' });
        expect(actor.getSnapshot().value).toBe('STOPPED');
      });

      it('Test F-AWAIT: substep FAIL with AWAIT defers to parent aggregation', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              all: true,
              await: true,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            substeps: [
              {
                id: '1',
                description: 'Substep 1',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
                },
              },
              {
                id: '2',
                description: 'Substep 2',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
                },
              },
            ],
          },
        ]);

        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Substep 1.1 fails — AWAIT defers, advances to substep 1.2
        actor.send({ type: 'FAIL' });
        expect(actor.getSnapshot().value).toBe('step::1::2');

        // Substep 1.2 fails — all results in, aggregation → STOPPED
        actor.send({ type: 'FAIL' });
        expect(actor.getSnapshot().value).toBe('STOPPED');
      });

      it('PASS ANY AWAIT — first pass defers, all complete → COMPLETE', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              all: false,
              await: true,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            substeps: [
              {
                id: '1',
                description: 'Substep 1',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
                },
              },
              {
                id: '2',
                description: 'Substep 2',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
                },
              },
            ],
          },
        ]);

        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Substep 1.1 passes — AWAIT defers, advances to substep 1.2
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().value).toBe('step::1::2');

        // Substep 1.2 passes — all results in, aggregation → COMPLETE
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().value).toBe('COMPLETE');
      });

      it('PASS ANY AWAIT — first pass defers, second fails, still COMPLETE', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              all: false,
              await: true,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            substeps: [
              {
                id: '1',
                description: 'Substep 1',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
                },
              },
              {
                id: '2',
                description: 'Substep 2',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
                },
              },
            ],
          },
        ]);

        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Substep 1.1 passes — AWAIT defers, advances to substep 1.2
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().value).toBe('step::1::2');

        // Substep 1.2 fails — all results in, at least one passed → COMPLETE
        actor.send({ type: 'FAIL' });
        expect(actor.getSnapshot().value).toBe('COMPLETE');
      });

      it('FAIL ANY AWAIT — first fails, second passes → STOPPED (any fail triggers STOP)', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              all: true,
              await: true,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            substeps: [
              {
                id: '1',
                description: 'Substep 1',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
                },
              },
              {
                id: '2',
                description: 'Substep 2',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
                },
              },
            ],
          },
        ]);

        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Substep 1.1 fails — AWAIT defers, advances to substep 1.2
        actor.send({ type: 'FAIL' });
        expect(actor.getSnapshot().value).toBe('step::1::2');

        // Substep 1.2 passes — all results in, but hasFailed=true → FAIL ANY fires → STOPPED
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().value).toBe('STOPPED');
      });

      it('FAIL ANY AWAIT with 3 substeps — no short-circuit, all complete before aggregation', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              all: true,
              await: true,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            substeps: [
              {
                id: '1',
                description: 'Substep 1',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
                },
              },
              {
                id: '2',
                description: 'Substep 2',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
                },
              },
              {
                id: '3',
                description: 'Substep 3',
                transitions: {
                  all: true,
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
                },
              },
            ],
          },
        ]);

        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Substep 1.1 fails — AWAIT defers, advances to substep 1.2
        actor.send({ type: 'FAIL' });
        expect(actor.getSnapshot().value).toBe('step::1::2');

        // Substep 1.2 passes — AWAIT defers, advances to substep 1.3
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().value).toBe('step::1::3');

        // Substep 1.3 passes — all results in, but hasFailed=true → FAIL ANY fires → STOPPED
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().value).toBe('STOPPED');
      });

      it('PASS ANY (all=false) short-circuits to COMPLETE on first pass', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              all: false,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            substeps: [
              { id: '1', description: 'Substep 1' },
              { id: '2', description: 'Substep 2' },
            ],
          },
        ]);

        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Substep 1.1 passes — with PASS ANY (all=false), first pass short-circuits to COMPLETE
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().value).toBe('COMPLETE');
      });
    });
  });

  describe('retry state architecture', () => {
    it('creates fail-retry state when FAIL has retry > 0', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: {
              kind: 'fail' as const,
              retry: 2,
              action: { type: 'GOTO' as const, target: { step: '2' } },
            },
          },
        },
        { name: '2', description: 'Step 2', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const config = machine.config;
      expect(config.states).toHaveProperty('step::1::fail-retry');
      expect(config.states).not.toHaveProperty('step::1::pass-retry');
    });

    it('creates pass-retry state when PASS has retry > 0', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 2, action: { type: 'COMPLETE' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      expect(machine.config.states).toHaveProperty('step::1::pass-retry');
      expect(machine.config.states).not.toHaveProperty('step::1::fail-retry');
    });

    it('creates retry state for substep with retry > 0', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          substeps: [
            {
              id: '1',
              description: 'Sub 1',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 3, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      expect(machine.config.states).toHaveProperty('step::1::1::fail-retry');

      // Behavioral: retry 3 times then CONTINUE to parent aggregation
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'FAIL' }); // retry 1/3
      expect(actor.getSnapshot().value).toBe('step::1::1');
      expect(actor.getSnapshot().context.retryCount).toBe(1);

      actor.send({ type: 'FAIL' }); // retry 2/3
      expect(actor.getSnapshot().context.retryCount).toBe(2);

      actor.send({ type: 'FAIL' }); // retry 3/3
      expect(actor.getSnapshot().context.retryCount).toBe(3);

      // Exhausted → CONTINUE to parent aggregation → parent FAIL (all: true) → STOPPED
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
      expect(actor.getSnapshot().context.retryCount).toBe(0);
    });

    it('retry state is transient and never observable in snapshots', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 2, action: { type: 'STOP' as const } },
          },
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      const snapshots: string[] = [];
      actor.subscribe((snapshot) => {
        const value = snapshot.value;
        snapshots.push(typeof value === 'string' ? value : JSON.stringify(value));
      });

      actor.send({ type: 'FAIL' }); // retry 1/2
      actor.send({ type: 'FAIL' }); // retry 2/2
      actor.send({ type: 'FAIL' }); // exhausted → STOP

      expect(snapshots.every((v) => !v.includes('retry'))).toBe(true);
    });

    it('does not create retry states when retry = 0', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          transitions: DEFAULT_TRANSITIONS,
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const stateKeys = Object.keys(machine.config.states ?? {});
      expect(stateKeys.some((k) => k.includes('retry'))).toBe(false);
    });

    it('dual retry: PASS and FAIL retry states share retryCount budget', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 1, action: { type: 'COMPLETE' as const } },
            fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);

      // Verify both retry states exist
      expect(machine.config.states).toHaveProperty('step::1::pass-retry');
      expect(machine.config.states).toHaveProperty('step::1::fail-retry');

      // Behavioral: FAIL retry then PASS exhausts (shared retryCount)
      const actor = createActor(machine);
      actor.start();

      // FAIL retry 1/1: retryCount 0 < 1 → retry
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('step::1');
      expect(actor.getSnapshot().context.retryCount).toBe(1);

      // PASS exhausted: retryCount 1 < 1 is false → execute exhausted (COMPLETE)
      // (retryCount is shared, so FAIL's increment carries over to PASS)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('COMPLETE');
    });
  });

  describe('two-level FOR aggregation', () => {
    it('FOR with 2 substeps, mixed results, explicit CONTINUE iteration-level transitions', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 2,
            transitions: {
              all: true,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            },
          },
          description: 'Loop with substeps',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Substep 1',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
            {
              id: '2',
              description: 'Substep 2',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: substep 1 PASS, substep 2 FAIL
      actor.send({ type: 'PASS' }); // 1.1 pass
      actor.send({ type: 'FAIL' }); // 1.2 fail → iteration result = fail

      // Iteration 2: substep 1 PASS, substep 2 PASS
      actor.send({ type: 'PASS' }); // 2.1 pass
      actor.send({ type: 'PASS' }); // 2.2 pass → iteration result = pass

      // Iteration-level transitions are PASS ALL (all: true) with CONTINUE on both pass/fail
      // Iteration 1 failed, but action is CONTINUE, so loop continues
      // iterationResults has iteration 1 only (loop-backed); iteration 2 is computed inline
      // Step-level PASS ALL: [fail, pass] aggregates to fail (not all passed) → STOP
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      expect(snapshot.context.iterationResults).toEqual(['fail']);
      expect(snapshot.context.substepResults).toEqual(['pass', 'pass']);
    });

    it('FOR with FAIL ANY: BREAK iteration-level transition', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 3,
            transitions: {
              all: true,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'BREAK' as const } },
            },
          },
          description: 'Loop with BREAK on fail',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: PASS
      actor.send({ type: 'PASS' });

      // Iteration 2: FAIL → BREAK triggered at iteration level
      actor.send({ type: 'FAIL' });

      // After BREAK: loop exits, aggregates only 2 iterations with iteration 2 failing
      // Iteration-level FAIL ANY (fail action is BREAK): iteration 2 failed → BREAK
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      expect(snapshot.context.iterationResults).toEqual(['pass']);
      expect(snapshot.context.substepResults).toEqual(['fail']);
    });

    it('default FOR transitions (no explicit nested transitions) — behaves as PASS ALL with CONTINUE', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          description: 'Loop without explicit forClause transitions',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check A',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
            {
              id: '2',
              description: 'Check B',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: 1.1 PASS, 1.2 FAIL
      actor.send({ type: 'PASS' });
      actor.send({ type: 'FAIL' });

      // Iteration 2: 1.1 PASS, 1.2 PASS
      actor.send({ type: 'PASS' });
      actor.send({ type: 'PASS' });

      // Default FOR transitions = DEFAULT_FOR_TRANSITIONS: PASS ALL with CONTINUE on fail
      // Iteration 1 failed (one substep failed), result = fail, action = CONTINUE → continues loop
      // Iteration 2 passed, result = pass, action = CONTINUE → normal loop completion
      // iterationResults has iteration 1 only (loop-backed); iteration 2 computed inline
      // Step-level PASS ALL: [fail, pass] includes a failure → STOP
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      expect(snapshot.context.iterationResults).toEqual(['fail']);
      expect(snapshot.context.substepResults).toEqual(['pass', 'pass']);
    });

    it('non-FOR steps are unaffected', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Non-FOR step with 2 substeps',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Substep 1',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
            {
              id: '2',
              description: 'Substep 2',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Next step',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Substep 1.1 PASS
      actor.send({ type: 'PASS' });
      // Substep 1.2 PASS → parent step passes
      actor.send({ type: 'PASS' });

      const snapshot = actor.getSnapshot();
      // Should reach step 2
      expect(snapshot.value).toBe('step::2');
      // Non-FOR steps use iterationResults directly (one per substep)
      expect(snapshot.context.iterationResults).toEqual(['pass', 'pass']);
      // substepResults is not used for non-FOR steps
      expect(snapshot.context.substepResults).toBeUndefined();
    });

    it('FOR with PASS ANY iteration-level transitions', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 2,
            transitions: {
              all: false,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            },
          },
          description: 'Loop with PASS ANY (all: false)',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check X',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
            {
              id: '2',
              description: 'Check Y',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: 1.1 FAIL, 1.2 FAIL
      actor.send({ type: 'FAIL' });
      actor.send({ type: 'FAIL' });

      // Iteration 2: 1.1 PASS, 1.2 FAIL
      actor.send({ type: 'PASS' });
      actor.send({ type: 'FAIL' });

      // Iteration-level PASS ANY (all: false):
      //   Iteration 1 result = fail (0 passes), action = CONTINUE
      //   Iteration 2 result = pass (1 pass), action = CONTINUE
      // iterationResults has iteration 1 only (loop-backed); iteration 2 computed inline
      // Step-level PASS ALL (all: true): [fail, pass] includes a failure → STOP
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      expect(snapshot.context.iterationResults).toEqual(['fail']);
      expect(snapshot.context.substepResults).toEqual(['pass', 'fail']);
    });

    it('FOR with FAIL ANY: RETRY 2 BREAK retries twice then breaks', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 3,
            transitions: {
              all: true,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              fail: { kind: 'fail' as const, retry: 2, action: { type: 'BREAK' as const } },
            },
          },
          description: 'Loop with RETRY on fail',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: FAIL → iteration retry 1
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().context.iterationRetryCount).toBe(1);

      // Retry 1: FAIL → iteration retry 2
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().context.iterationRetryCount).toBe(2);

      // Retry 2 exhausted: FAIL → BREAK (terminal action)
      actor.send({ type: 'FAIL' });

      // After BREAK: only 1 iteration (the failed one), step-level PASS ALL fails → STOP
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
    });

    it('FOR with FAIL ANY: RETRY 1 CONTINUE retries once then continues', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 2,
            transitions: {
              all: true,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              fail: { kind: 'fail' as const, retry: 1, action: { type: 'CONTINUE' as const } },
            },
          },
          description: 'Loop with RETRY 1 CONTINUE on fail',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: FAIL → retry
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().context.iterationRetryCount).toBe(1);

      // Retry exhausted: FAIL → CONTINUE (terminal action), advance to iteration 2
      actor.send({ type: 'FAIL' });

      // iterationRetryCount resets on iteration advance
      expect(actor.getSnapshot().context.iterationRetryCount).toBe(0);

      // Iteration 2: PASS → CONTINUE, loop ends
      actor.send({ type: 'PASS' });

      // iterationResults: [fail] (iteration 1 from loop-back); iteration 2 computed inline as pass
      // Step-level PASS ALL: [fail, pass] → fail → STOP
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
    });

    it('FOR iteration-level retry succeeds on second attempt', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 2,
            transitions: {
              all: true,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              fail: { kind: 'fail' as const, retry: 2, action: { type: 'BREAK' as const } },
            },
          },
          description: 'Loop with RETRY on fail',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: FAIL → retry
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().context.iterationRetryCount).toBe(1);

      // Retry 1: PASS → iteration passes, advance to iteration 2
      actor.send({ type: 'PASS' });

      // iterationRetryCount resets on iteration advance
      expect(actor.getSnapshot().context.iterationRetryCount).toBe(0);

      // Iteration 2: PASS → loop ends
      actor.send({ type: 'PASS' });

      // All iterations passed → step-level PASS ALL: [pass, pass] → CONTINUE → step 2
      expect(actor.getSnapshot().value).toBe('step::2');
      actor.send({ type: 'PASS' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
    });

    it('FOR iterationRetryCount resets between iterations', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 3,
            transitions: {
              all: true,
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              fail: { kind: 'fail' as const, retry: 1, action: { type: 'CONTINUE' as const } },
            },
          },
          description: 'Loop with RETRY 1 CONTINUE',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                all: true,
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: FAIL → retry
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().context.iterationRetryCount).toBe(1);

      // Retry: PASS → iteration passes, advance to iteration 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().context.iterationRetryCount).toBe(0);

      // Iteration 2: FAIL → retry (counter starts from 0 again)
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().context.iterationRetryCount).toBe(1);

      // Retry: PASS → iteration passes, advance to iteration 3
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().context.iterationRetryCount).toBe(0);

      // Iteration 3: PASS → loop ends
      actor.send({ type: 'PASS' });

      // iterationResults: [pass, pass] (loop-backed); iteration 3 computed inline as pass
      // Step-level PASS ALL: all pass → CONTINUE → step 2
      expect(actor.getSnapshot().value).toBe('step::2');
      actor.send({ type: 'PASS' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
    });
  });

  describe('aggregation substep default transitions', () => {
    it('substeps under ALL/ANY aggregation default to CONTINUE on fail', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Aggregated check',
          transitions: {
            all: false,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          substeps: [
            { id: '1', description: 'First check' },
            { id: '2', description: 'Second check' },
          ],
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().value).toBe('step::1::1');

      // Substep 1 fails — should CONTINUE to substep 2 (not STOP)
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('step::1::2');

      // Substep 2 passes — aggregation evaluates: PASS ANY → COMPLETE
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('COMPLETE');
    });

    it('substeps under ANY aggregation: all fail triggers STOP', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Aggregated check',
          transitions: {
            all: false,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          substeps: [
            { id: '1', description: 'First check' },
            { id: '2', description: 'Second check' },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().value).toBe('step::1::1');

      // Both substeps fail — FAIL ALL → STOP
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('step::1::2');
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
    });

    it('substeps under FOR loop default to CONTINUE on fail', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'FOR step',
          forClause: { start: 1, end: 2 },
          substeps: [{ id: '1', description: 'Check item' }],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            all: true,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().value).toBe('step::1::1');

      // Iteration 1: substep fails → CONTINUE to parent → FOR logic evaluates
      actor.send({ type: 'FAIL' });
      // Should proceed to next iteration, not STOP
      expect(actor.getSnapshot().value).toBe('step::1::1');

      // Iteration 2: substep passes → loop completes → step 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('step::2');
    });
  });
});
