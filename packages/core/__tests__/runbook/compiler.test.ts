import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createActor, fromPromise, waitFor } from 'xstate';
import {
  compileRunbookToMachine,
  MAX_FILE_ITERATIONS,
  PENDING_MACHINE_EFFECT_TAG,
  validateGraphForTest,
} from '../../src/runbook/compiler.js';
import type {
  ForIterateInput,
  ForIterateOutput,
} from '../../src/runbook/actors/for-iterate-actor.js';
import type {
  CommandExecutionInput,
  CommandExecutionOutput,
  CommandExecutionServices,
} from '../../src/runbook/actors/command-exec-actor.js';
import type {
  OutputCaptureInput,
  OutputCaptureOutput,
} from '../../src/runbook/actors/output-capture-actor.js';
import type { RunbookContext } from '../../src/runbook/compiler.js';
import {
  appendArtifactManifestRecord,
  readArtifactManifest,
} from '../../src/runbook/artifact-manifest.js';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';
import { parseExactArtifactUriParts } from '../../src/runbook/artifact-uri.js';
import type {
  ResolvedStep,
  BaseStep,
  StepWithCommand,
  StepWithSubsteps,
  ResolvedStepWithFor,
  SubstepState,
  RunbookState,
} from '../../src/runbook/types.js';
import { createDelegation } from '../../src/runbook/delegation-service.js';
import type { RunbookRef } from '../../src/runbook/runbook-ref.js';
import { buildCompletionKey, buildFrameKey } from '../../src/runbook/targeting.js';
import { brandCurrentCursorResolvedCompletionForTest } from '../../src/runbook/completion-service.js';
import { createRunbook } from './fixtures.js';
import {
  brandFlattenedTemplateVarsForTest,
  brandInitialTemplateVarsForTest,
  brandRunIdForTest,
  brandStoredOutputsForTest,
} from '../helpers/effective-vars.js';

describe('runbook compiler', () => {
  /** Input type: Resolved step variants without the `kind` discriminant. */
  type StepInput =
    | Omit<BaseStep, 'kind'>
    | Omit<StepWithCommand, 'kind'>
    | Omit<StepWithSubsteps, 'kind'>
    | Omit<ResolvedStepWithFor, 'kind'>;

  const DEFAULT_TRANSITIONS = {
    pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
    fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
  };

  const DEFAULT_FOR_ITERATION = {
    transitions: {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
    },
    aggregation: { strategy: 'ALL' as const },
  };

  const COMMAND_SERVICES: CommandExecutionServices = {
    runExternalCommand: async () => ({ success: true, exitCode: 0 }),
  };

  /** Infer and inject `kind` on each step object so raw literals satisfy the ResolvedStep union. */
  function inferSteps(raw: StepInput[]): ResolvedStep[] {
    return raw.map((s) => {
      const kind =
        'forClause' in s
          ? 'for'
          : 'substeps' in s
            ? 'substeps'
            : 'command' in s
              ? 'command'
              : 'base';
      return { ...s, kind } as ResolvedStep;
    });
  }

  describe('static step compilation', () => {
    it('generates discrete states for substeps', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Parent',
          aggregation: { strategy: 'ALL' },
          substeps: [
            { id: '1', description: 'Child 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Child 2', transitions: DEFAULT_TRANSITIONS },
          ],
          transitions: DEFAULT_TRANSITIONS,
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
          transitions: DEFAULT_TRANSITIONS,
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
          transitions: DEFAULT_TRANSITIONS,
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

      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      // Case D: non-FOR pass-through clears iterationResults
      expect(actor.getSnapshot().context.iterationResults).toBeUndefined();
    });

    it('explicit H3 runbook substeps with runbooks DEFER and parent FAIL-routes on deferred fail', () => {
      const steps = createRunbook(`## 1. Review package
### 1.1 Review pass
- review-pass.runbook.md
### 1.2 Review fail
- review-fail.runbook.md

## 2. Done
- PASS COMPLETE
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // 1.1 DEFER -> advance to 1.2
      actor.send({ type: 'FAIL' }); // 1.2 DEFER -> parent -> Case D FAIL routing -> STOPPED

      // Runbook substeps use DEFER defaults (parser DEFER_TRANSITIONS).
      // The parent declares no explicit transitions, so the default FAIL STOP
      // applies. Under Case D FAIL routing, any deferred 'fail' result routes
      // to the parent's configured FAIL target (STOPPED).
      expect(actor.getSnapshot().value).toBe('STOPPED');
    });

    it('Case D non-FOR parent with PASS STOP sets lastAction to STOP and preserves lastMessage', () => {
      const steps = createRunbook(`## 1. Review
- PASS STOP "all done"
- FAIL STOP

### 1.1 First
- PASS CONTINUE
- FAIL CONTINUE

### 1.2 Last
- PASS CONTINUE
- FAIL CONTINUE

## 2. Next
- PASS COMPLETE
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // 1.1 CONTINUE -> advance to 1.2
      actor.send({ type: 'PASS' }); // 1.2 CONTINUE -> parent -> Case D PASS STOP -> STOPPED

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      expect(snapshot.context.lastAction).toEqual(expect.objectContaining({ type: 'STOP' }));
      expect(snapshot.context.lastMessage).toBe('all done');
    });

    it('Case D non-FOR parent with PASS COMPLETE sets lastAction to COMPLETE', () => {
      const steps = createRunbook(`## 1. Review
- PASS COMPLETE
- FAIL STOP

### 1.1 First
- PASS CONTINUE
- FAIL CONTINUE

### 1.2 Last
- PASS CONTINUE
- FAIL CONTINUE
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // 1.1 CONTINUE -> advance to 1.2
      actor.send({ type: 'PASS' }); // 1.2 CONTINUE -> parent -> Case D PASS COMPLETE -> COMPLETE

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
      expect(snapshot.context.lastAction).toEqual(expect.objectContaining({ type: 'COMPLETE' }));
    });

    it('Case D non-FOR parent with PASS GOTO sets lastAction to GOTO', () => {
      const steps = createRunbook(`## 1. Review
- PASS GOTO 3
- FAIL STOP

### 1.1 First
- PASS CONTINUE
- FAIL CONTINUE

### 1.2 Last
- PASS CONTINUE
- FAIL CONTINUE

## 2. Skipped
- PASS COMPLETE

## 3. Target
- PASS COMPLETE
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // 1.1 CONTINUE -> advance to 1.2
      actor.send({ type: 'PASS' }); // 1.2 CONTINUE -> parent -> Case D PASS GOTO 3 -> step::3

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toEqual({ 'step::3': 'idle' });
      expect(snapshot.context.lastAction).toEqual(
        expect.objectContaining({ type: 'GOTO', target: '3' }),
      );
    });

    it('H3 runbook substeps under aggregating parent DEFER and aggregate on PASS ALL', () => {
      const steps = createRunbook(`## 1. Review
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Code review
- code-review.runbook.md

### 1.2 Security review
- security-review.runbook.md
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // 1.1 passes — DEFER advances to 1.2, aggregation waits
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });

      // 1.2 passes — all results in, PASS ALL: COMPLETE
      actor.send({ type: 'PASS' });
      const passAllSnapshot = actor.getSnapshot();
      expect(passAllSnapshot.value).toBe('COMPLETE');
      expect(passAllSnapshot.context.deferredResults).toEqual(['pass', 'pass']);
      expect(passAllSnapshot.context.lastAction).toEqual(
        expect.objectContaining({ type: 'COMPLETE' }),
      );
    });

    it('H3 runbook substeps under aggregating parent FAIL ANY triggers STOP', () => {
      const steps = createRunbook(`## 1. Review
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Code review
- code-review.runbook.md

### 1.2 Security review
- security-review.runbook.md
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // 1.1 fails — DEFER collects result, advances to 1.2
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });

      // 1.2 passes — all results in, FAIL ANY has a fail → STOPPED
      actor.send({ type: 'PASS' });
      const failAnySnapshot = actor.getSnapshot();
      expect(failAnySnapshot.value).toBe('STOPPED');
      expect(failAnySnapshot.context.deferredResults).toEqual(['fail', 'pass']);
      expect(failAnySnapshot.context.lastAction).toEqual(expect.objectContaining({ type: 'STOP' }));
    });

    it('mixed H3 substeps: prose and runbook-list both DEFER under aggregating parent', () => {
      const steps = createRunbook(`## 1. Plan and review
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Write plan
Write the plan manually.

### 1.2 Review plan
- review-plan.runbook.md
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Both substeps get DEFER under aggregating parent
      // 1.1 (prose) passes → DEFER → advances to 1.2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });

      // 1.2 (runbook list) passes → DEFER → PASS ALL: COMPLETE
      actor.send({ type: 'PASS' });
      const mixedSnapshot = actor.getSnapshot();
      expect(mixedSnapshot.value).toBe('COMPLETE');
      expect(mixedSnapshot.context.deferredResults).toEqual(['pass', 'pass']);
    });

    it('non-aggregating substeps with sequential flow (Case D)', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step with substeps, no aggregation',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
            { id: '3', description: 'Sub 3', transitions: DEFAULT_TRANSITIONS },
          ],
        },
        {
          name: '2',
          description: 'Next',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // 1.1 CONTINUE → 1.2
      actor.send({ type: 'PASS' }); // 1.2 CONTINUE → 1.3
      actor.send({ type: 'PASS' }); // 1.3 CONTINUE → parent → Case D → step::2

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
      // Case D: non-FOR pass-through clears deferredResults
      expect(snapshot.context.deferredResults).toBeUndefined();
      expect(snapshot.context.iterationResults).toBeUndefined();
    });

    it('non-aggregating substep FAIL propagates STOP directly', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step with substeps, no aggregation',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ],
        },
        {
          name: '2',
          description: 'Next',
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // 1.1 CONTINUE → 1.2
      actor.send({ type: 'FAIL' }); // 1.2 STOP → STOPPED

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      expect(snapshot.context.lastAction).toEqual({ type: 'STOP' });
    });

    it('last substep transitions to parent state', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step with substeps',
          forClause: { start: 1, end: 3, ...DEFAULT_FOR_ITERATION },
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
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
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);
    });

    it('non-FOR substeps with FAIL ANY: STOP waits for all DEFER results before aggregation', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Review step',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
            {
              id: '2',
              description: 'Check 2',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
          ],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // 1.1 fails — DEFER advances to 1.2, aggregation waits for all results
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });

      // 1.2 passes — all results in, FAIL ANY (all=true) has a fail → STOPPED
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
      expect(actor.getSnapshot().context.deferredResults).toEqual(['fail', 'pass']);
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
          transitions: DEFAULT_TRANSITIONS,
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
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          description: 'Second',
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
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
          transitions: DEFAULT_TRANSITIONS,
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
            { id: '1', description: 'Substep 1.1', transitions: DEFAULT_TRANSITIONS },
            {
              id: '2',
              description: 'Substep 1.2',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          description: 'Step 2 (no substeps)',
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '3',
          description: 'Step 3',
          substeps: [
            { id: '1', description: 'Substep 3.1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Substep 3.2', transitions: DEFAULT_TRANSITIONS },
          ],
          transitions: DEFAULT_TRANSITIONS,
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
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });

      // Pass step 2, should CONTINUE to step 3.1
      // This was the bug: showed "GOTO 3.1" but should be "CONTINUE"
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'CONTINUE' });
      expect(actor.getSnapshot().value).toEqual({ 'step::3::1': 'idle' });
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
          transitions: DEFAULT_TRANSITIONS,
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
          aggregation: { strategy: 'ALL' },
          substeps: [
            { id: '1', description: 'Substep 2.1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Substep 2.2', transitions: DEFAULT_TRANSITIONS },
            { id: '3', description: 'Substep 2.3', transitions: DEFAULT_TRANSITIONS },
          ],
          transitions: DEFAULT_TRANSITIONS,
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
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          description: 'Step 2',
          transitions: DEFAULT_TRANSITIONS,
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
          transitions: DEFAULT_TRANSITIONS,
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
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          name: '2',
          description: 'Step 2',
          transitions: {
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

      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
    });
  });

  describe('RETRY as transition property', () => {
    it('stays at current step during retry, then executes action', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 2, action: { type: 'GOTO', target: { step: '2' } } },
          },
        },
        {
          name: '2',
          description: 'Step 2',
          transitions: {
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
      expect(actor.getSnapshot().value).toEqual({ 'step::1': 'idle' });
      expect(actor.getSnapshot().context.retryCount).toBe(1);

      // Second FAIL: stay at step 1 (retry 2/2)
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1': 'idle' });
      expect(actor.getSnapshot().context.retryCount).toBe(2);

      // Third FAIL: exhausted, GOTO step 2
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      expect(actor.getSnapshot().context.retryCount).toBe(0);
    });

    it('works the same for PASS with retry', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step 1',
          transitions: {
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
      expect(actor.getSnapshot().value).toEqual({ 'step::1': 'idle' });

      // Second PASS: stay (retry 2/2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1': 'idle' });

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
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
          },
        },
        {
          name: '2',
          description: 'Recovery and Fix',
          transitions: {
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
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });

      // Step 2 PASS -> RETRY GOTO 1 (should stay at step 2 for retry 1/2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      expect(actor.getSnapshot().context.retryCount).toBe(1);
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'RETRY' });

      // Step 2 PASS again -> RETRY GOTO 1 (should stay at step 2 for retry 2/2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      expect(actor.getSnapshot().context.retryCount).toBe(2);

      // Step 2 PASS again -> exhausted, execute GOTO to step 1
      actor.send({ type: 'PASS' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toEqual({ 'step::1': 'idle' });
      expect(snapshot.context.retryCount).toBe(0);
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: '1' });
    });

    it('STOPs when RETRY+GOTO exhausts retries', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Run Tests',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
          },
        },
        {
          name: '2',
          description: 'Recovery and Fix',
          transitions: {
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
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      expect(actor.getSnapshot().context.retryCount).toBe(1);

      // Step 2 PASS -> RETRY (2/2), stay at step 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      expect(actor.getSnapshot().context.retryCount).toBe(2);

      // Step 2 PASS -> retries exhausted, execute GOTO to step 1
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1': 'idle' });

      // Step 1 FAIL -> step 2
      actor.send({ type: 'FAIL' });
      // Step 2 PASS -> fresh RETRY cycle, RETRY (1/2), stay at step 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
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
          forClause: { start: 1, end: 3, ...DEFAULT_FOR_ITERATION },
          description: 'Process batches',
          aggregation: { strategy: 'ALL' },
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
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '4',
          description: 'Commit',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Start at step::2, PASS to enter FOR step
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      actor.send({ type: 'PASS' }); // step::2 → step::3::1 (FOR initialized)

      expect(actor.getSnapshot().value).toEqual({ 'step::3::1': 'idle' });
      const top1 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(top1.iteration).toBe(1);
      expect(top1.end).toBe(3);

      // Iteration 1: step::3::1 → step::3::2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::3::2': 'idle' });

      // Iteration 1: step::3::2 → loop back to step::3::1 (iteration 2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::3::1': 'idle' });
      const top2 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(top2.iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

      // Iteration 2: step::3::1 → step::3::2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::3::2': 'idle' });

      // Iteration 2: step::3::2 → loop back to step::3::1 (iteration 3)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::3::1': 'idle' });
      const top3 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(top3.iteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);

      // Iteration 3: step::3::1 → step::3::2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::3::2': 'idle' });

      // Iteration 3: step::3::2 → exit loop → step::4
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::4': 'idle' });
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('initializes FOR context when FOR step is the first state', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2, ...DEFAULT_FOR_ITERATION },
          description: 'First step is FOR',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Machine starts at step::1::1 (first substep of FOR step)
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      const top =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(top.iteration).toBe(1);
      expect(top.start).toBe(1);
      expect(top.end).toBe(2);

      // Iteration 1: PASS → loop back (iteration 2)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      const top2a =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(top2a.iteration).toBe(2);

      // Iteration 2: PASS → exit loop
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('exits loop immediately when start equals end (single iteration)', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 5, end: 5, ...DEFAULT_FOR_ITERATION },
          description: 'Single iteration',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      const topSingle =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topSingle.iteration).toBe(5);

      // Single pass should exit loop (5 is not < 5)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('stores named variable in FOR context', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { variable: 'batch', start: 1, end: 2, ...DEFAULT_FOR_ITERATION },
          description: 'Named loop variable',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
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
      const DEFER_ON_FAIL = {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
      };
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 4,
            transitions: DEFER_ON_FAIL,
            aggregation: { strategy: 'ALL' },
          },
          description: 'Test with failures',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Single substep',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
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
      expect(actor.getSnapshot().context.iterationResults).toEqual([
        'pass',
        'fail',
        'pass',
        'pass',
      ]);
      expect(actor.getSnapshot().context.deferredResults).toEqual(['pass']);
    });

    it('handles FOR step without substeps gracefully', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          aggregation: { strategy: 'ALL' },
          substeps: [],
          description: 'For without substeps',
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          description: 'Next',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // FOR with empty substeps is auto-skipped, machine starts at step 2
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
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
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          name: '2',
          description: 'Skipped',
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '3',
          forClause: { start: 1, end: 2, ...DEFAULT_FOR_ITERATION },
          description: 'FOR entered via GOTO',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '4',
          description: 'Done',
          transitions: {
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
      expect(actor.getSnapshot().value).toEqual({ 'step::3::1': 'idle' });
      const topGoto1 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topGoto1.iteration).toBe(1);
      expect(topGoto1.end).toBe(2);

      // Iteration 1: PASS → loop back
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::3::1': 'idle' });
      const topGoto2 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topGoto2.iteration).toBe(2);

      // Iteration 2: PASS → exit loop
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::4': 'idle' });
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
          forClause: { start: 1, end: 3, ...DEFAULT_FOR_ITERATION },
          description: 'Process batches',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Fetch',
              transitions: {
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
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '4',
          description: 'Commit',
          transitions: {
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
      expect(actor.getSnapshot().value).toEqual({ 'step::3::1': 'idle' });
      const topNext1 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topNext1.iteration).toBe(1);

      // Iteration 1: PASS on substep 1 → NEXT → skip substep 2, go to iteration 2's substep 1
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::3::1': 'idle' }); // Loop back to first substep
      const topNext2 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topNext2.iteration).toBe(2);
      // NEXT skips accumulation — iteration result not recorded
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);

      // Iteration 2: PASS → NEXT → iteration 3
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::3::1': 'idle' });
      const topNext3 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topNext3.iteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);

      // Iteration 3 (last): PASS → NEXT → exit loop
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::4': 'idle' }); // Exit to next step
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
          forClause: { start: 1, end: 5, ...DEFAULT_FOR_ITERATION },
          description: 'Process batches',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'BREAK' } },
              },
            },
            {
              id: '2',
              description: 'Process',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
          ],
        },
        {
          name: '4',
          description: 'Commit',
          transitions: {
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
      expect(actor.getSnapshot().value).toEqual({ 'step::3::1': 'idle' });
      const topBreak1 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topBreak1.iteration).toBe(1);

      // Iteration 1: FAIL on substep 1 → BREAK → exit loop
      // BREAK is non-accumulating — current iteration result NOT added to iterationResults
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::4': 'idle' });
      expect(actor.getSnapshot().context.forStack).toEqual([]);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);
      expect(actor.getSnapshot().context.deferredResults).toEqual([]);
    });

    it('NEXT skips accumulation — iteration results stay empty for NEXT-only iterations', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 3, ...DEFAULT_FOR_ITERATION },
          description: 'Loop with NEXT on fail',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Step',
              transitions: {
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
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: FAIL → NEXT (skips accumulation)
      actor.send({ type: 'FAIL' });
      const topNextRes1 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topNextRes1.iteration).toBe(2);
      // NEXT skips accumulation — iterationResults stays empty
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);

      // Iteration 2: PASS → NEXT (skips accumulation)
      actor.send({ type: 'PASS' });
      const topNextRes2 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topNextRes2.iteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);

      // Iteration 3 (last): PASS → NEXT → exit → PASS ALL: empty results → vacuous pass → CONTINUE
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);
      expect(actor.getSnapshot().context.deferredResults).toEqual([]);
    });

    it('BREAK exits loop without accumulating current iteration', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 5, ...DEFAULT_FOR_ITERATION },
          description: 'Loop with early break',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Increment',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
            {
              id: '2',
              description: 'Check and break',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'BREAK' } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
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
      expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      const topBreakRes1 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topBreakRes1.iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

      // Iteration 2: PASS → PASS → loop back
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      const topBreakRes2 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topBreakRes2.iteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);

      // Iteration 3: PASS (DEFER) → FAIL (BREAK) → exit loop
      // BREAK is non-accumulating — iteration 3's result is NOT added to iterationResults
      // Parent aggregation sees ['pass', 'pass'] from iterations 1-2 (DEFER'd) → all pass → CONTINUE
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      expect(actor.getSnapshot().context.forStack).toEqual([]);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);
      expect(actor.getSnapshot().context.deferredResults).toEqual([]);
    });

    it('NEXT outside FOR loop goes to STOPPED', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'No FOR clause',
          transitions: {
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
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '3',
          description: 'Done',
          transitions: {
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
      expect(actor.getSnapshot().value).toEqual({ 'step::2::1': 'idle' });
      const topAt1 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topAt1.iteration).toBe(2);
      expect(topAt1.start).toBe(1);
      expect(topAt1.end).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);

      // Iteration 2: PASS → loop back to iteration 3
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2::1': 'idle' });
      const topAt2 =
        actor.getSnapshot().context.forStack[actor.getSnapshot().context.forStack.length - 1];
      expect(topAt2.iteration).toBe(3);

      // Iteration 3: PASS → exit
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::3': 'idle' });
    });

    it('GOTO without AT targeting FOR step resets to first iteration', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Start',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          name: '2',
          forClause: { start: 1, end: 2 },
          description: 'FOR loop',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '3',
          description: 'Done',
          transitions: {
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
      expect(actor.getSnapshot().value).toEqual({ 'step::2::1': 'idle' });
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
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          forClause: { variable: 'batch', start: 1, end: 5, ...DEFAULT_FOR_ITERATION },
          description: 'FOR loop',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '3',
          description: 'Done',
          transitions: {
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
      expect(actor.getSnapshot().value).toEqual({ 'step::2::1': 'idle' });
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
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          forClause: { start: 1, end: 3, ...DEFAULT_FOR_ITERATION },
          description: 'FOR loop',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // External GOTO without AT to FOR step → reset
      actor.send({ type: 'GOTO', target: { step: '2' } });
      expect(actor.getSnapshot().value).toEqual({ 'step::2::1': 'idle' });
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
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          name: '2',
          forClause: { start: 1, end: 3 },
          description: 'FOR step',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Substep with GOTO out',
              transitions: {
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
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '3',
          description: 'After loop',
          transitions: {
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
      expect(actor.getSnapshot().value).toEqual({ 'step::2::1': 'idle' });
      const ctx1 = actor.getSnapshot().context;
      expect(ctx1.forStack.length).toBe(1);
      expect(ctx1.forStack[0].iteration).toBe(1);

      // PASS substep 1 → GOTO step 1 (non-FOR) — forStack should be cleared
      actor.send({ type: 'PASS' }); // step::2::1 → step::1
      expect(actor.getSnapshot().value).toEqual({ 'step::1': 'idle' });
      expect(actor.getSnapshot().context.forStack).toEqual([]);
      expect(actor.getSnapshot().context.iterationResults).toBeUndefined();

      // Re-enter FOR step → fresh loop context
      actor.send({ type: 'PASS' }); // step::1 → step::2::1 (fresh FOR)
      expect(actor.getSnapshot().value).toEqual({ 'step::2::1': 'idle' });
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
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '3',
          description: 'Done',
          transitions: {
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
      expect(actor.getSnapshot().value).toEqual({ 'step::2::1': 'idle' });
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
          forClause: { start: 1, end: 5, variable: 'item', ...DEFAULT_FOR_ITERATION },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Sub',
              transitions: {
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
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          description: 'Loop B',
          forClause: { start: 1, end: 5, ...DEFAULT_FOR_ITERATION },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Sub',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
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
      expect(snap.value).toEqual({ 'step::2::1': 'idle' });
      expect(snap.context.forStack[0].iteration).toBe(3);
    });

    it('GOTO AT with named loop variable resolves at runtime', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Loop A',
          forClause: { start: 1, end: 5, variable: 'item', ...DEFAULT_FOR_ITERATION },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Sub',
              transitions: {
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
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          description: 'Loop B',
          forClause: { start: 1, end: 5, ...DEFAULT_FOR_ITERATION },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Sub',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
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
      expect(snap.value).toEqual({ 'step::2::1': 'idle' });
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
          forClause: { start: 1, end: 3, ...DEFAULT_FOR_ITERATION },
          description: 'FOR with 2 substeps',
          aggregation: { strategy: 'ALL' },
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
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '3',
          description: 'Done',
          transitions: {
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
      expect(actor.getSnapshot().value).toEqual({ 'step::2::2': 'idle' });

      // Should have FOR context initialized (not cleared by buildSimpleGotoAssign)
      const ctx = actor.getSnapshot().context;
      expect(ctx.forStack.length).toBe(1);
      expect(ctx.forStack[0].iteration).toBe(1);
      expect(ctx.forStack[0].start).toBe(1);
      expect(ctx.forStack[0].end).toBe(3);
      expect(ctx.iterationResults).toEqual([]);
    });

    // Unresolved FOR bounds are now rejected at compile time via the type system:
    // compileRunbookToMachine accepts ResolvedStep[] (not Step[]), so steps with
    // UnresolvedForClause cannot be passed. The three runtime error tests
    // (first FOR step, transition into FOR, GOTO into FOR) were replaced by this
    // compile-time guarantee. See ResolvedStep / ResolvedStepWithFor in parser/ast.ts.
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
          transitions: DEFAULT_TRANSITIONS,
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
          transitions: DEFAULT_TRANSITIONS,
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

      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('iterationResults is undefined after implicit loop exit', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Single substep, no FOR',
          substeps: [{ id: '1', description: 'Only sub', transitions: DEFAULT_TRANSITIONS }],
          transitions: DEFAULT_TRANSITIONS,
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

      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      // Case D: non-FOR pass-through clears iterationResults
      expect(actor.getSnapshot().context.iterationResults).toBeUndefined();
    });

    it('GOTO to non-FOR step with substeps initializes implicit ForContext', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Source',
          transitions: {
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
          transitions: DEFAULT_TRANSITIONS,
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

      expect(actor.getSnapshot().value).toEqual({ 'step::2::1': 'idle' });
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
                pass: { kind: 'pass', retry: 0, action: { type: 'NEXT' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
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
                pass: { kind: 'pass', retry: 0, action: { type: 'BREAK' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
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
          forClause: { start: 1, end: 3, ...DEFAULT_FOR_ITERATION },
          description: 'FOR step',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Sub',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
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
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' }); // loops back
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(2);

      // Iteration 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(3);

      // Iteration 3 (last)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' }); // exits
      expect(actor.getSnapshot().context.forStack).toEqual([]);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass', 'pass']);
      expect(actor.getSnapshot().context.deferredResults).toEqual(['pass']);
    });

    it('intra-loop GOTO preserves forStack', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Loop step',
          forClause: { start: 1, end: 3 },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'First sub',
              transitions: {
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
          transitions: DEFAULT_TRANSITIONS,
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
      expect(snap.value).toEqual({ 'step::1::2': 'idle' });
      // forStack should be preserved with iteration 1
      expect(snap.context.forStack).toHaveLength(1);
      expect(snap.context.forStack[0].iteration).toBe(1);

      // PASS substep 2 → should loop back to substep 1 at iteration 2
      actor.send({ type: 'PASS' });
      snap = actor.getSnapshot();
      expect(snap.value).toEqual({ 'step::1::1': 'idle' });
      expect(snap.context.forStack[0].iteration).toBe(2);

      // Second iteration: PASS both → loop back at iteration 3
      actor.send({ type: 'PASS' }); // 1.1 → 1.2
      actor.send({ type: 'PASS' }); // 1.2 → loop back
      snap = actor.getSnapshot();
      expect(snap.value).toEqual({ 'step::1::1': 'idle' });
      expect(snap.context.forStack[0].iteration).toBe(3);

      // Third iteration (last): PASS both → exit loop
      actor.send({ type: 'PASS' }); // 1.1 → 1.2
      actor.send({ type: 'PASS' }); // 1.2 → exit
      snap = actor.getSnapshot();
      expect(snap.value).toEqual({ 'step::2': 'idle' });
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
          forClause: { start: 1, end: 3, variable: 'i', ...DEFAULT_FOR_ITERATION },
          aggregation: { strategy: 'ALL' },
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ],
          transitions: DEFAULT_TRANSITIONS,
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
      expect(actor.getSnapshot().value).toEqual({ 'step::2::1': 'idle' });
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
          aggregation: { strategy: 'ALL' },
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ],
          transitions: DEFAULT_TRANSITIONS,
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
      expect(actor.getSnapshot().value).toEqual({ 'step::2::1': 'idle' });
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
          transitions: DEFAULT_TRANSITIONS,
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
      expect(actor.getSnapshot().value).toEqual({ 'step::2::2': 'idle' });
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
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'Sub', transitions: DEFAULT_TRANSITIONS }],
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          description: 'Target with substeps, no FOR',
          aggregation: { strategy: 'ALL' },
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ],
          transitions: DEFAULT_TRANSITIONS,
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

      expect(actor.getSnapshot().value).toEqual({ 'step::2::2': 'idle' });
      const ctx = actor.getSnapshot().context;
      expect(ctx.forStack).toHaveLength(1);
      expect(ctx.forStack[0]).toEqual(expect.objectContaining({ stepId: '2', implicit: true }));
    });
  });

  describe('post-loop aggregation', () => {
    // Iteration-level DEFER on fail: loop continues past failed iterations with accumulation
    const FOR_DEFER_ON_FAIL = {
      aggregation: { strategy: 'ALL' },
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
    };

    it('PASS ALL fails when any iteration failed', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 3,
            transitions: FOR_DEFER_ON_FAIL,
            aggregation: { strategy: 'ALL' },
          },
          description: 'Loop with PASS ALL',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
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
      expect(snapshot.context.iterationResults).toEqual(['pass', 'fail', 'pass']);
      expect(snapshot.context.deferredResults).toEqual(['pass']);
    });

    it('PASS ALL fails when first iteration failed', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 3,
            transitions: FOR_DEFER_ON_FAIL,
            aggregation: { strategy: 'ALL' },
          },
          description: 'Loop with PASS ALL',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
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
      expect(snapshot.context.iterationResults).toEqual(['fail', 'pass', 'pass']);
      expect(snapshot.context.deferredResults).toEqual(['pass']);
    });

    it('PASS ALL succeeds when all iterations pass', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 3, ...DEFAULT_FOR_ITERATION },
          description: 'Loop with all passes',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Always pass',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
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
      actor.send({ type: 'PASS' }); // iter 3

      // Should reach step 2 (PASS ALL with all passes → CONTINUE)
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
      expect(snapshot.context.iterationResults).toEqual(['pass', 'pass', 'pass']);
      expect(snapshot.context.deferredResults).toEqual(['pass']);
    });

    it('PASS ANY succeeds when one iteration passes', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 3,
            transitions: FOR_DEFER_ON_FAIL,
            aggregation: { strategy: 'ANY' },
          },
          description: 'Loop with PASS ANY',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          aggregation: { strategy: 'ANY' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
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
      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
      expect(snapshot.context.iterationResults).toEqual(['fail', 'pass', 'fail']);
      expect(snapshot.context.deferredResults).toEqual(['fail']);
    });

    it('BREAK triggers aggregation on accumulated results', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 5, ...DEFAULT_FOR_ITERATION },
          description: 'Loop with BREAK',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
              },
            },
            {
              id: '2',
              description: 'Maybe break',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
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

      // BREAK at iter 3: non-accumulating — current iteration result NOT added
      // iterationResults = ['pass', 'pass'] (from iterations 1-2 via DEFER loop-back)
      // PASS ALL: all pass → CONTINUE to step 2
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
      expect(snapshot.context.iterationResults).toEqual(['pass', 'pass']);
      expect(snapshot.context.deferredResults).toEqual([]);
    });

    it('NEXT at last iteration triggers aggregation', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2, ...DEFAULT_FOR_ITERATION },
          description: 'Loop with NEXT',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'NEXT' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'NEXT' } },
              },
            },
            {
              id: '2',
              description: 'Skipped by NEXT',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
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

      // NEXT skips accumulation — no iteration results accumulated
      // PASS ALL with empty results → vacuous pass → CONTINUE to step 2
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
      expect(snapshot.context.iterationResults).toEqual([]);
      expect(snapshot.context.deferredResults).toEqual([]);
    });

    it('FAIL ALL triggers when all iterations fail under PASS ANY mode', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 3,
            transitions: FOR_DEFER_ON_FAIL,
            aggregation: { strategy: 'ANY' },
          },
          description: 'Loop with PASS ANY',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          aggregation: { strategy: 'ANY' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
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
      expect(snapshot.context.iterationResults).toEqual(['fail', 'fail', 'fail']);
      expect(snapshot.context.deferredResults).toEqual(['fail']);
    });

    it('PASS ALL with GOTO target records GOTO lastAction and initializes forStack for target FOR step', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2, ...DEFAULT_FOR_ITERATION },
          description: 'Loop that GOTOs on pass',
          transitions: {
            pass: {
              kind: 'pass',
              retry: 0,
              action: { type: 'GOTO', target: { step: '3', at: 1 } },
            },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
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
          forClause: { start: 1, end: 3, ...DEFAULT_FOR_ITERATION },
          description: 'Target FOR step',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Target substep',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
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
      expect(snapshot.value).toEqual({ 'step::3::1': 'idle' });
      expect(snapshot.context.lastAction).toEqual({
        type: 'GOTO',
        target: '3',
        at: 1,
        aggregated: true,
      });
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
          forClause: { start: 1, end: 2, ...DEFAULT_FOR_ITERATION },
          description: 'Loop that COMPLETEs on fail',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'COMPLETE' } },
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
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
      expect(snapshot.context.lastAction).toEqual({ type: 'COMPLETE', aggregated: true });
    });

    it('PASS ALL with STOP action records STOP lastAction', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2, ...DEFAULT_FOR_ITERATION },
          description: 'Loop that STOPs on pass',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'STOP' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
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
      expect(snapshot.context.lastAction).toEqual({ type: 'STOP', aggregated: true });
    });

    it('PASS ALL failure triggers fail-path GOTO to non-FOR step', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2, ...DEFAULT_FOR_ITERATION },
          description: 'Loop that GOTOs on fail',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
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
      expect(snapshot.value).toEqual({ 'step::3': 'idle' });
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: '3', aggregated: true });
      expect(snapshot.context.iterationResults).toEqual(['pass', 'fail']);
      expect(snapshot.context.deferredResults).toEqual(['fail']);
      expect(snapshot.context.forStack).toEqual([]);
    });

    it('PASS ALL failure triggers fail-path GOTO AT to target FOR step', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2, ...DEFAULT_FOR_ITERATION },
          description: 'Loop that GOTOs AT on fail',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: {
              kind: 'fail',
              retry: 0,
              action: { type: 'GOTO', target: { step: '3', at: 2 } },
            },
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
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
          forClause: { start: 1, end: 4, ...DEFAULT_FOR_ITERATION },
          description: 'Recovery loop',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Recover',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // iter 1 passes
      actor.send({ type: 'FAIL' }); // iter 2 fails

      // PASS ALL with one failure → aggregation fails → GOTO 3 AT 2
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toEqual({ 'step::3::1': 'idle' });
      expect(snapshot.context.lastAction).toEqual({
        type: 'GOTO',
        target: '3',
        at: 2,
        aggregated: true,
      });
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
          forClause: {
            start: 1,
            end: 3,
            transitions: FOR_DEFER_ON_FAIL,
            aggregation: { strategy: 'ANY' },
          },
          description: 'Loop with PASS ANY and GOTO',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          aggregation: { strategy: 'ANY' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
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
      expect(snapshot.value).toEqual({ 'step::3': 'idle' });
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: '3', aggregated: true });
      expect(snapshot.context.iterationResults).toEqual(['fail', 'pass', 'fail']);
      expect(snapshot.context.deferredResults).toEqual(['fail']);
      expect(snapshot.context.forStack).toEqual([]);
    });

    it('BREAK triggers aggregation and exits via pass-path GOTO', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 5, ...DEFAULT_FOR_ITERATION },
          description: 'Loop with BREAK and GOTO',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
              },
            },
            {
              id: '2',
              description: 'Maybe break',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'BREAK' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
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

      // BREAK on iteration 1: substep 2 BREAK is non-accumulating
      // iterationResults = [] (empty) → vacuous pass on PASS ALL → GOTO 3
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toEqual({ 'step::3': 'idle' });
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: '3', aggregated: true });
      expect(snapshot.context.iterationResults).toEqual([]);
      expect(snapshot.context.deferredResults).toEqual([]);
      expect(snapshot.context.forStack).toEqual([]);
    });
  });

  describe('descending FOR loop ranges', () => {
    it('iterates descending range (3, 2, 1) via DEFER', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 3, end: 1, ...DEFAULT_FOR_ITERATION },
          description: 'Descending loop',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
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
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      const top1 = actor.getSnapshot().context.forStack[0];
      expect(top1.iteration).toBe(3);
      expect(top1.start).toBe(3);
      expect(top1.end).toBe(1);

      // Iteration 3 → 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

      // Iteration 2 → 1
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(1);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);

      // Iteration 1 (last) → exit loop
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      expect(actor.getSnapshot().context.forStack).toEqual([]);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass', 'pass']);
      expect(actor.getSnapshot().context.deferredResults).toEqual(['pass']);
    });

    it('BREAK exits descending loop immediately', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 5, end: 1, ...DEFAULT_FOR_ITERATION },
          description: 'Descending with break',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
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

      // FAIL → BREAK → exit loop
      // BREAK does not populate deferredResults → vacuous pass → PASS ALL → CONTINUE to step 2
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('NEXT skips to next descending iteration', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 3, end: 1, ...DEFAULT_FOR_ITERATION },
          description: 'Descending with NEXT',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'First',
              transitions: {
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
          transitions: DEFAULT_TRANSITIONS,
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
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(2);

      // NEXT at 2 → skip to 1
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(1);

      // NEXT at 1 (last) → exit loop
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('GOTO AT into descending range', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Start',
          transitions: {
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
          forClause: { start: 5, end: 1, ...DEFAULT_FOR_ITERATION },
          description: 'Descending FOR',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
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
      expect(actor.getSnapshot().value).toEqual({ 'step::2::1': 'idle' });
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
      expect(actor.getSnapshot().value).toEqual({ 'step::3': 'idle' });
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('single iteration when start equals end in descending context', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 5, end: 5, ...DEFAULT_FOR_ITERATION },
          description: 'Single iteration',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
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
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      expect(actor.getSnapshot().context.forStack).toEqual([]);
    });

    it('records iteration results correctly for descending loop', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 3,
            end: 1,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
            },
            aggregation: { strategy: 'ALL' },
          },
          description: 'Descending with mixed results',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
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
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'fail', 'pass']);
      expect(actor.getSnapshot().context.deferredResults).toEqual(['pass']);
    });

    it('iterates descending range with two substeps', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 3, end: 1, ...DEFAULT_FOR_ITERATION },
          description: 'Descending with two substeps',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'First check',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
            {
              id: '2',
              description: 'Second check',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
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
      // Should have exited to step 2
      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
      expect(snapshot.context.iterationResults).toEqual(['pass', 'pass', 'pass']);
      expect(snapshot.context.deferredResults).toEqual(['pass', 'pass']);
    });
  });

  describe('data source FOR loops', () => {
    it('creates ForContext with array source', () => {
      const steps = createRunbook(`
## 1. Process items
- FOR item IN {{ items }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE

\`\`\`bash
echo "processing"
\`\`\`
`);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      const ctx = actor.getSnapshot().context;
      const top = ctx.forStack[0];
      expect(top.source).toEqual({ kind: 'variable', name: 'items' });
      expect(top.start).toBe(1);
      expect(top.end).toBeUndefined(); // open-ended; resolved at execution time
      expect(top.variable).toBe('item');

      actor.stop();
    });

    it('variable source loop exits on first PASS without execution layer (currentValue undefined)', () => {
      const steps = createRunbook(`
## 1. Process items
- FOR item IN {{ items }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE

\`\`\`bash
echo "processing"
\`\`\`
`);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: currentValue is undefined (must be resolved by forIterateActor)
      const ctx = actor.getSnapshot().context;
      const top = ctx.forStack[0];
      expect(top.iteration).toBe(1);
      expect(top.currentValue).toBeUndefined();

      // Without execution layer resolving currentValue, PASS exits the loop
      // (hasMoreIterations returns false for variable sources without currentValue)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().context.forStack).toEqual([]);

      actor.stop();
    });

    it('preserves window end for execution-time resolution', () => {
      const steps = createRunbook(`
## 1. Process items
- FOR item IN 1 TO 100 OF {{ items }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE

\`\`\`bash
echo "processing"
\`\`\`
`);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      const ctx = actor.getSnapshot().context;
      const top = ctx.forStack[0];
      expect(top.end).toBe(100); // window end preserved; execution layer resolves bounds
      expect(top.source).toEqual({ kind: 'variable', name: 'items' });

      actor.stop();
    });

    it('compiles machine with undefined variable source (validation deferred to execution)', () => {
      const steps = createRunbook(`
## 1. Process items
- FOR item IN {{ missing }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE

\`\`\`bash
echo "processing"
\`\`\`
`);
      // Compiler no longer validates sources — variable sources are resolved at execution time
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);

      let capturedError: unknown;
      actor.subscribe({
        error: (err) => {
          capturedError = err;
        },
      });
      actor.start();
      // Machine starts successfully with a variable source reference
      expect(capturedError).toBeUndefined();
      expect(actor.getSnapshot().status).toBe('active');

      actor.stop();
    });

    it('exits a sourced FOR when parent aggregation retry re-entry finds the source exhausted', async () => {
      const steps = createRunbook(`
## 1. Process items
- FOR item IN {{ items }}
- PASS ALL COMPLETE
- FAIL ANY RETRY 1 STOP

### 1.1 Handle item
- PASS DEFER
- FAIL DEFER
`);
      let resolveCalls = 0;
      const machine = compileRunbookToMachine(steps).provide({
        actors: {
          forIterateActor: fromPromise<ForIterateOutput, ForIterateInput>(async () => {
            resolveCalls++;
            if (resolveCalls === 1) {
              return { kind: 'ready' as const, forIndex: 1, forValue: 'first', total: 1 };
            }
            if (resolveCalls === 2) {
              return { kind: 'exhausted' as const, forIndex: 1 };
            }
            throw new Error('stale retry router re-entered exhausted sourced FOR');
          }),
        },
      });
      const actor = createActor(machine);
      actor.start();

      await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG), {
        timeout: 1_000,
      });

      actor.send({ type: 'FAIL' });

      const snapshot = await waitFor(actor, (snap) => snap.status === 'done', {
        timeout: 1_000,
      });
      expect(snapshot.value).toBe('COMPLETE');
      expect(resolveCalls).toBe(2);
      expect(snapshot.context.forStack).toEqual([]);
      expect(snapshot.context.lastAction?.type).toBe('COMPLETE');

      actor.stop();
    });

    it('stores stream snapshots returned by forIterateActor on the active FOR frame', async () => {
      const steps = createRunbook(`
## 1. Process items
- FOR item IN {{ items }}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE
`);
      const machine = compileRunbookToMachine(steps).provide({
        actors: {
          forIterateActor: fromPromise<ForIterateOutput, ForIterateInput>(async ({ input }) => ({
            kind: 'ready',
            forIndex: input.forContext.iteration,
            forValue: 'first',
            snapshot: {
              lastLine: 1,
              size: 16,
              mtimeMs: 1700000000000,
              fingerprint: 'abc123',
            },
          })),
        },
      });
      const actor = createActor(machine);
      actor.start();

      const snapshot = await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG), {
        timeout: 1_000,
      });

      expect(snapshot.context.forStack.at(-1)?.snapshot).toEqual({
        lastLine: 1,
        size: 16,
        mtimeMs: 1700000000000,
        fingerprint: 'abc123',
      });

      actor.stop();
    });

    it('clears a stale stream snapshot when the next ready iteration has no snapshot', async () => {
      const steps = createRunbook(`
## 1. Process items
- FOR item IN {{ items }}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE
`);
      const staleSnapshot = {
        lastLine: 1,
        size: 16,
        mtimeMs: 1700000000000,
        fingerprint: 'abc123',
      };
      const machine = compileRunbookToMachine(steps).provide({
        actors: {
          forIterateActor: fromPromise<ForIterateOutput, ForIterateInput>(async ({ input }) => ({
            kind: 'ready',
            forIndex: input.forContext.iteration,
            forValue: `item-${String(input.forContext.iteration)}`,
            ...(input.forContext.iteration === 1 ? { snapshot: staleSnapshot } : {}),
          })),
        },
      });
      const actor = createActor(machine);
      actor.start();

      const first = await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG), {
        timeout: 1_000,
      });
      expect(first.context.forStack.at(-1)?.snapshot).toEqual(staleSnapshot);

      actor.send({ type: 'PASS' });
      const second = await waitFor(
        actor,
        (snap) =>
          !snap.hasTag(PENDING_MACHINE_EFFECT_TAG) && snap.context.forStack.at(-1)?.iteration === 2,
        { timeout: 1_000 },
      );

      expect(second.context.forStack.at(-1)?.snapshot).toBeUndefined();

      actor.stop();
    });

    it('threads runtime context.variables into the forIterateActor input view', async () => {
      // Step 1 advances to step 2 on PASS. Between START and the FOR firing
      // we inject `runtimeItems` via SET_VARIABLES, simulating an ARTIFACTS
      // wildcard capture (which yields `readonly ArtifactRecord[]`). Under
      // the old pre-merge contract the actor only saw `templateVars` and
      // would surface `undefined-variable`; with merging the value is
      // visible.
      const steps = createRunbook(`
## 1. Setup

\`\`\`bash
echo "setup"
\`\`\`

## 2. Process items
- FOR item IN {{ runtimeItems }}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 2.1 Handle item
- PASS CONTINUE
`);
      const runtimeRecords: readonly ArtifactRecord[] = [
        {
          kind: 'artifact-record' as const,
          runId: 'rd_00000000000000000000000000000001',
          contextId: 'ctx',
          runbook: { source: 'project' as const, path: 'r.runbook.md' },
          key: 'first',
          timestamp: '2026-05-14T00:00:00.000Z',
          uri: 'file:///tmp/first.json',
        },
      ];
      let observedTemplateVars: Record<string, unknown> | undefined;
      const machine = compileRunbookToMachine(steps).provide({
        actors: {
          forIterateActor: fromPromise<ForIterateOutput, ForIterateInput>(async ({ input }) => {
            observedTemplateVars = { ...input.templateVars };
            return { kind: 'exhausted' as const, forIndex: input.forContext.iteration };
          }),
        },
      });
      const actor = createActor(machine);
      actor.start();

      // Inject runtime variable before the FOR step fires.
      actor.send({ type: 'SET_VARIABLES', vars: { runtimeItems: runtimeRecords } });
      // Advance from step 1 to step 2 (which holds the FOR).
      actor.send({ type: 'PASS' });

      await waitFor(actor, (snap) => snap.status === 'done', { timeout: 1_000 });

      expect(observedTemplateVars).toBeDefined();
      expect(observedTemplateVars?.runtimeItems).toEqual(runtimeRecords);

      actor.stop();
    });

    it('initialises open-ended variable source with undefined end', () => {
      const steps = createRunbook(`
## 1. Process items
- FOR item IN {{ items }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE

\`\`\`bash
echo "processing"
\`\`\`
`);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      const ctx = actor.getSnapshot().context;
      const top = ctx.forStack[0];
      // Open-ended variable source — end is undefined, resolved at execution time
      expect(top.end).toBeUndefined();
      expect(top.source).toEqual({ kind: 'variable', name: 'items' });

      actor.stop();
    });

    it('initialises windowed variable source with deferred value resolution', () => {
      const steps = createRunbook(`
## 1. Process items
- FOR item IN 2 TO 4 OF {{ items }}
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE

\`\`\`bash
echo "processing"
\`\`\`
`);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 2: currentValue is undefined (resolved by forIterateActor)
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
        aggregation: { strategy: 'ALL' },
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
      };

      const steps = inferSteps([
        {
          name: '1',
          description: 'Loop step',
          forClause: {
            start: 1,
            end: 2,
            variable: 'item',
            source: 'items',
            ...DEFAULT_FOR_ITERATION,
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'First sub',
              transitions: {
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
          transitions: DEFAULT_TRANSITIONS,
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
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Initial state: iteration 1, currentValue undefined (resolved by forIterateActor)
      let ctx = actor.getSnapshot().context;
      let top = ctx.forStack[0];
      expect(top.iteration).toBe(1);
      expect(top.currentValue).toBeUndefined();
      expect(top.source).toEqual({ kind: 'variable', name: 'items' });

      // Send FAIL to trigger GOTO 1.2
      actor.send({ type: 'FAIL' });
      ctx = actor.getSnapshot().context;
      top = ctx.forStack[0];
      // forStack should still be preserved with same iteration
      expect(top.iteration).toBe(1);
      expect(top.currentValue).toBeUndefined();
      expect(top.source).toEqual({ kind: 'variable', name: 'items' });

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
        aggregation: { strategy: 'ALL' },
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
      };

      const steps = inferSteps([
        {
          name: '1',
          description: 'Source step',
          transitions: {
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
          forClause: {
            start: 1,
            end: 3,
            variable: 'item',
            source: 'items',
            ...DEFAULT_FOR_ITERATION,
          },
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS_LOCAL }],
          transitions: DEFAULT_TRANSITIONS,
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
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Send PASS to trigger GOTO 2.1
      actor.send({ type: 'PASS' });
      const ctx = actor.getSnapshot().context;
      const top = ctx.forStack[0];

      // Verify forStack initialized with array source at iteration 1
      // currentValue is undefined — resolved by forIterateActor before execution
      expect(top.source).toEqual({ kind: 'variable', name: 'items' });
      expect(top.start).toBe(1);
      expect(top.end).toBe(3);
      expect(top.iteration).toBe(1);
      expect(top.currentValue).toBeUndefined();

      actor.stop();
    });

    it('GOTO cross-loop with AT into array source resolves correct currentValue', () => {
      const DEFAULT_TRANSITIONS_LOCAL = {
        aggregation: { strategy: 'ALL' },
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
      };

      const steps = inferSteps([
        {
          name: '1',
          description: 'Source step',
          transitions: {
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
          forClause: {
            start: 1,
            end: 3,
            variable: 'item',
            source: 'items',
            ...DEFAULT_FOR_ITERATION,
          },
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS_LOCAL }],
          transitions: DEFAULT_TRANSITIONS,
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
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Send PASS to trigger GOTO 2.1 AT 2
      actor.send({ type: 'PASS' });
      const ctx = actor.getSnapshot().context;
      const top = ctx.forStack[0];

      // Verify forStack initialized with array source at iteration 2
      // currentValue is undefined — resolved by forIterateActor before execution
      expect(top.source).toEqual({ kind: 'variable', name: 'items' });
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
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Handle item
- PASS CONTINUE

\`\`\`bash
echo "processing"
\`\`\`
`);
      const machine = compileRunbookToMachine(steps);
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
        aggregation: { strategy: 'ALL' },
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
      };

      const steps = inferSteps([
        {
          name: '1',
          description: 'File loop',
          forClause: {
            start: 3,
            end: 1,
            variable: 'server',
            source: 'servers',
            ...DEFAULT_FOR_ITERATION,
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process {{server}}',
              transitions: DEFAULT_TRANSITIONS_LOCAL,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
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

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      const ctx = actor.getSnapshot().context;
      const top = ctx.forStack[0];

      expect(top.source).toEqual({ kind: 'variable', name: 'servers' });
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
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process {{line}}',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      const machine = compileRunbookToMachine(steps);

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
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process {{line}}',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      const machine = compileRunbookToMachine(steps);

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
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process {{line}}',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      const machine = compileRunbookToMachine(steps);

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
    it('normalizes file source to variable reference in unified model', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'File loop',
          forClause: {
            variable: 'line',
            start: 1,
            source: 'data',
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Process {{line}}',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      const machine = compileRunbookToMachine(steps);

      const actor = createActor(machine);
      actor.start();

      const ctx = actor.getSnapshot().context;
      expect(ctx.forStack.length).toBe(1);
      const source = ctx.forStack[0].source;
      expect(source.kind).toBe('variable');
      if (source.kind === 'variable') {
        expect(source.name).toBe('data');
      }

      actor.stop();
    });
  });

  describe('FOR shorthand canonicalization', () => {
    it('iterates a FOR step defined via step-level runbook-list shorthand', () => {
      const steps = createRunbook(`
## 1. Review the plan
- FOR pass IN 1 TO 2
- PASS ALL CONTINUE
- FAIL ANY STOP

- review-technical-accuracy.runbook.md

## 2. Done
- PASS COMPLETE
`);

      expect((steps[0] as any).substeps?.[0]).toMatchObject({
        id: '1',
        runbooks: ['review-technical-accuracy.runbook.md'],
      });

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });

      actor.send({ type: 'PASS' }); // iteration 1: DEFER → accumulates 'pass' → loop-back
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      expect(actor.getSnapshot().context.forStack[0]?.iteration).toBe(2);

      actor.send({ type: 'PASS' }); // iteration 2: DEFER → accumulates 'pass' → parent aggregation → PASS ALL → CONTINUE → step 2
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      // Aggregation mode: iteration results accumulated via default DEFER transitions
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);
    });

    it('FOR shorthand with FAIL — iteration failure routes through parent FAIL ANY', () => {
      const steps = createRunbook(`
## 1. Review the plan
- FOR pass IN 1 TO 2
- PASS ALL CONTINUE
- FAIL ANY GOTO Synthesize

- review-technical-accuracy.runbook.md

## 2. Skipped
- PASS COMPLETE

## Synthesize
- PASS COMPLETE
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: PASS → DEFER → accumulates 'pass' → loop-back
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });

      // Iteration 2: FAIL → DEFER → accumulates 'fail' → parent aggregation
      // FAIL ANY fires (fail in results) → GOTO Synthesize
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::Synthesize': 'idle' });
    });

    it('GOTO to shorthand-canonicalized FOR step enters substep .1', () => {
      const steps = createRunbook(`
## 1. Start
- PASS GOTO 2
- FAIL STOP

## 2. Review the plan
- FOR pass IN 1 TO 2
- PASS ALL CONTINUE
- FAIL ANY STOP

- review-technical-accuracy.runbook.md

## 3. Done
- PASS COMPLETE
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().value).toEqual({ 'step::1': 'idle' });

      actor.send({ type: 'PASS' }); // GOTO 2 -> first substep
      expect(actor.getSnapshot().value).toEqual({ 'step::2::1': 'idle' });
      expect(actor.getSnapshot().context.forStack[0]?.stepId).toBe('2');
    });

    it('iterates a FOR step with multiple shorthand runbooks', () => {
      const steps = createRunbook(`
## 1. Review the plan
- FOR pass IN 1 TO 2
- PASS ALL CONTINUE
- FAIL ANY STOP

- review-technical-accuracy.runbook.md
- review-structural-integrity.runbook.md
- review-build-runtime.runbook.md
- review-risk-safety.runbook.md

## 2. Done
- PASS COMPLETE
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

      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });

      actor.send({ type: 'PASS' }); // iteration 1, substep 1 -> substep 2
      expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });
      expect(actor.getSnapshot().context.forStack[0]?.iteration).toBe(1);

      actor.send({ type: 'PASS' }); // substep 2 -> substep 3
      expect(actor.getSnapshot().value).toEqual({ 'step::1::3': 'idle' });

      actor.send({ type: 'PASS' }); // substep 3 -> substep 4
      expect(actor.getSnapshot().value).toEqual({ 'step::1::4': 'idle' });

      actor.send({ type: 'PASS' }); // end iteration 1 -> iteration 2 substep 1
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      expect(actor.getSnapshot().context.forStack[0]?.iteration).toBe(2);

      actor.send({ type: 'PASS' }); // iteration 2, substep 1
      actor.send({ type: 'PASS' }); // iteration 2, substep 2
      actor.send({ type: 'PASS' }); // iteration 2, substep 3
      actor.send({ type: 'PASS' }); // iteration 2, substep 4 -> PASS ALL -> step 2
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
    });
  });

  describe('non-FOR substep aggregation', () => {
    it('PASS ALL: CONTINUE advances when all pass', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Review step',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
            {
              id: '2',
              description: 'Check 2',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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

      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      expect(actor.getSnapshot().context.deferredResults).toEqual(['pass', 'pass']);
    });

    it('FAIL ANY: GOTO routes to target step on failure', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Review step',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: {
              kind: 'fail' as const,
              retry: 0,
              action: { type: 'GOTO' as const, target: { step: '3' } },
            },
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
            {
              id: '2',
              description: 'Check 2',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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

      expect(actor.getSnapshot().value).toEqual({ 'step::3': 'idle' });
    });

    it('parent GOTO to non-first implicit substep does not reuse prior aggregation results', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Source with mixed outcomes',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: {
              kind: 'fail' as const,
              retry: 0,
              action: { type: 'GOTO' as const, target: { step: '2', substep: '2' } },
            },
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Source check 1',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
            {
              id: '2',
              description: 'Source check 2',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Target implicit step',
          transitions: {
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
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Target check 1',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
              },
            },
            {
              id: '2',
              description: 'Target check 2',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
              },
            },
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
      expect(actor.getSnapshot().value).toEqual({ 'step::2::2': 'idle' });

      actor.send({ type: 'PASS' }); // 2.2 -> parent PASS ALL -> should route to 3
      expect(actor.getSnapshot().value).toEqual({ 'step::3': 'idle' });
    });

    it('PASS ANY: CONTINUE advances when any passes', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Review step',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
          aggregation: { strategy: 'ANY' },
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
            {
              id: '2',
              description: 'Check 2',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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

      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
    });

    it('single substep aggregation works correctly', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Review step',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Only check',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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
      expect(actor2.getSnapshot().value).toEqual({ 'step::2': 'idle' });
    });

    it('three substeps with mixed results and PASS ALL waits for all DEFER results', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Review step',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
            {
              id: '2',
              description: 'Check 2',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
            {
              id: '3',
              description: 'Check 3',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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
      actor.send({ type: 'FAIL' }); // 1.2 fails → advance to 1.3
      expect(actor.getSnapshot().value).toEqual({ 'step::1::3': 'idle' });

      // 1.3 passes — all results in, FAIL ANY (all=true) has a fail → STOPPED
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
      expect(actor.getSnapshot().context.deferredResults).toEqual(['pass', 'fail', 'pass']);
    });

    it('FOR loop iterates through parent state', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'FOR loop',
          forClause: { start: 1, end: 3, ...DEFAULT_FOR_ITERATION },
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Sub 1',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
              },
            },
          ],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // iteration 1 -> parent -> loop-back
      actor.send({ type: 'PASS' }); // iteration 2 -> parent -> loop-back
      actor.send({ type: 'PASS' }); // iteration 3 (final) -> parent -> PASS ALL -> step::2

      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass', 'pass']);
      expect(actor.getSnapshot().context.deferredResults).toEqual(['pass']);
    });

    it('BREAK exits FOR loop via parent state', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'FOR loop',
          forClause: { start: 1, end: 3, ...DEFAULT_FOR_ITERATION },
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Sub 1',
              transitions: {
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

      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
    });

    it('NEXT skips to next iteration via parent state', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'FOR loop',
          forClause: { start: 1, end: 3, ...DEFAULT_FOR_ITERATION },
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Sub 1',
              transitions: {
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
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' }); // back at first substep, iteration 2

      // Iteration 2: substep 1 passes -> NEXT -> parent -> loop-back
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' }); // iteration 3

      // Iteration 3: substep 1 passes -> NEXT -> parent -> aggregation -> step::2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
    });

    it('FAIL ALL: STOP stops when all substeps fail under PASS ANY mode', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Review step',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
          aggregation: { strategy: 'ANY' },
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
            {
              id: '2',
              description: 'Check 2',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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
      expect(actor.getSnapshot().context.deferredResults).toEqual(['fail', 'fail']);
    });

    it('parent transitions with retry re-runs substeps before terminal action', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Retry step',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
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
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
            {
              id: '2',
              description: 'Check 2',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
          ],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // First FAIL at 1.1 → DEFER advances to 1.2, waits for all results
      actor.send({ type: 'FAIL' }); // 1.1 → advance to 1.2
      expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });

      // 1.2 fails → all results in, FAIL ANY (all=true) → retry #1 → back to 1.1
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });

      // Retry: 1.1 fails again → advance to 1.2
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });

      // 1.2 fails → all results in, retries exhausted → STOPPED
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
    });

    it('cross-step substep GOTO resets parentRetryCount before target parent retries', () => {
      const substepDeferTransitions = {
        aggregation: { strategy: 'ALL' },
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
      };

      const steps = inferSteps([
        {
          name: '1',
          description: 'Source with parent retry',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Jump to target',
              transitions: {
                pass: {
                  kind: 'pass' as const,
                  retry: 0,
                  action: { type: 'GOTO' as const, target: { step: '2', substep: '2' } },
                },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
            {
              id: '2',
              description: 'Fail to trigger parent retry',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Target with parent retry',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            { id: '1', description: 'Target 1', transitions: substepDeferTransitions },
            { id: '2', description: 'Target 2', transitions: substepDeferTransitions },
          ],
        },
        { name: '3', description: 'Done', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // 1.1 fails → DEFER advances to 1.2
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });

      // 1.2 fails → all results in, FAIL ANY → retry #1 → back to 1.1
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().context.parentRetryCount).toBe(1);

      actor.send({ type: 'PASS' }); // 1.1 -> GOTO 2.2 (bypass parent)
      expect(actor.getSnapshot().value).toEqual({ 'step::2::2': 'idle' });
      expect(actor.getSnapshot().context.parentRetryCount).toBe(0);

      // 2.2 is last substep of step 2: FAIL → parent aggregation → retry → 2.1
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2::1': 'idle' });
    });

    it('cross-step GOTO event resets parentRetryCount before target parent retries', () => {
      const substepDeferTransitions = {
        aggregation: { strategy: 'ALL' },
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
      };

      const steps = inferSteps([
        {
          name: '1',
          description: 'Source with parent retry',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            { id: '1', description: 'Source 1', transitions: substepDeferTransitions },
            { id: '2', description: 'Source 2', transitions: substepDeferTransitions },
          ],
        },
        {
          name: '2',
          description: 'Target with parent retry',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            { id: '1', description: 'Target 1', transitions: substepDeferTransitions },
            { id: '2', description: 'Target 2', transitions: substepDeferTransitions },
          ],
        },
        { name: '3', description: 'Done', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // 1.1 fails → DEFER advances to 1.2
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });

      // 1.2 fails → all results in, FAIL ANY → retry #1 → back to 1.1
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().context.parentRetryCount).toBe(1);

      actor.send({ type: 'GOTO', target: { step: '2', substep: '2' } });
      expect(actor.getSnapshot().value).toEqual({ 'step::2::2': 'idle' });
      expect(actor.getSnapshot().context.parentRetryCount).toBe(0);

      // 2.2 is last substep: FAIL → parent aggregation → retry → 2.1
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2::1': 'idle' });
    });

    it('parent COMPLETE action forces early completion', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Complete step',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check 1',
              transitions: {
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
      expect(actor.getSnapshot().context.lastAction).toEqual({
        type: 'COMPLETE',
        aggregated: true,
      });
    });

    describe('2-substep delegation bug scenarios', () => {
      it('Test A: explicit CONTINUE substeps with PASS ALL: COMPLETE parent — PASS 1.1 advances to 1.2', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Substep 1',
                transitions: {
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                },
              },
              {
                id: '2',
                description: 'Substep 2',
                transitions: {
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

        expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });
        expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'CONTINUE' });
      });

      it('Test B: explicit CONTINUE substeps with PASS ALL: COMPLETE parent — PASS both completes', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Substep 1',
                transitions: {
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                },
              },
              {
                id: '2',
                description: 'Substep 2',
                transitions: {
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
        expect(actor.getSnapshot().context.lastAction).toEqual({
          type: 'COMPLETE',
          aggregated: true,
        });
      });

      it('Test C: explicit DEFER substeps with PASS ALL: COMPLETE parent — PASS then FAIL stops', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Substep 1',
                transitions: {
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
                },
              },
              {
                id: '2',
                description: 'Substep 2',
                transitions: {
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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
        const DEFER_TRANSITIONS = {
          pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
          fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
        };
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Substep 1',
                // Parser fills in DEFER defaults for substeps under aggregating parent
                transitions: DEFER_TRANSITIONS,
              },
              {
                id: '2',
                description: 'Substep 2',
                // Parser fills in DEFER defaults for substeps under aggregating parent
                transitions: DEFER_TRANSITIONS,
              },
            ],
          },
        ]);

        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        actor.send({ type: 'PASS' }); // 1.1 passes -> should advance to 1.2, NOT COMPLETE

        expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });
        expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'DEFER' });
      });

      it('Test E: substep with explicit COMPLETE stops substep sequence and routes to parent', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Substep 1',
                transitions: {
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
                },
              },
              {
                id: '2',
                description: 'Substep 2',
                transitions: {
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

        // Substep 1.1 has PASS: COMPLETE — stops substep sequence, routes to parent
        // Parent aggregates [pass] with PASS ALL → passes → COMPLETE
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().value).toBe('COMPLETE');
      });

      it('Test F: substep FAIL with substep-level STOP routes directly to STOPPED', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Substep 1',
                transitions: {
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
                },
              },
              {
                id: '2',
                description: 'Substep 2',
                transitions: {
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

        // Substep 1.1 fails — substep's own fail: STOP routes directly to STOPPED
        actor.send({ type: 'FAIL' });
        expect(actor.getSnapshot().value).toBe('STOPPED');
      });

      it('PASS ANY (all=false) waits for all DEFER results before aggregation', () => {
        const DEFER_TRANSITIONS = {
          pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
          fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
        };
        const steps = inferSteps([
          {
            name: '1',
            description: 'Delegation step',
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
            aggregation: { strategy: 'ANY' },
            substeps: [
              { id: '1', description: 'Substep 1', transitions: DEFER_TRANSITIONS },
              { id: '2', description: 'Substep 2', transitions: DEFER_TRANSITIONS },
            ],
          },
        ]);

        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Substep 1.1 passes — DEFER advances to 1.2, aggregation waits for all results
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });

        // Substep 1.2 fails — all results in, PASS ANY (all=false) has a pass → COMPLETE
        actor.send({ type: 'FAIL' });
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
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Sub 1',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 3, action: { type: 'DEFER' as const } },
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
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      expect(actor.getSnapshot().context.retryCount).toBe(1);

      actor.send({ type: 'FAIL' }); // retry 2/3
      expect(actor.getSnapshot().context.retryCount).toBe(2);

      actor.send({ type: 'FAIL' }); // retry 3/3
      expect(actor.getSnapshot().context.retryCount).toBe(3);

      // Exhausted → CONTINUE to parent aggregation → parent FAIL (aggregation: 'ALL') → STOPPED
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
      expect(actor.getSnapshot().value).toEqual({ 'step::1': 'idle' });
      expect(actor.getSnapshot().context.retryCount).toBe(1);

      // PASS exhausted: retryCount 1 < 1 is false → execute exhausted (COMPLETE)
      // (retryCount is shared, so FAIL's increment carries over to PASS)
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('COMPLETE');
    });
  });

  describe('two-level FOR aggregation', () => {
    it('FOR with 2 substeps, mixed results, explicit DEFER iteration-level transitions', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 2,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
            },
            aggregation: { strategy: 'ALL' },
          },
          description: 'Loop with substeps',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Substep 1',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
            {
              id: '2',
              description: 'Substep 2',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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

      // Iteration-level transitions are PASS ALL (aggregation: 'ALL') with DEFER on both pass/fail
      // Iteration 1 failed, but action is DEFER, so loop continues
      // Step-level PASS ALL: [fail, pass] aggregates to fail (not all passed) → STOP
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      expect(snapshot.context.iterationResults).toEqual(['fail', 'pass']);
      expect(snapshot.context.deferredResults).toEqual(['pass', 'pass']);
    });

    it('FOR with FAIL ANY: BREAK iteration-level transition', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 3,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'BREAK' as const } },
            },
            aggregation: { strategy: 'ALL' },
          },
          description: 'Loop with BREAK on fail',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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

      // After BREAK: loop exits. BREAK is non-accumulating — iteration 2's fail
      // is NOT added to iterationResults. Parent aggregation sees only ['pass'] → passes → CONTINUE → step 2
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
      expect(snapshot.context.iterationResults).toEqual(['pass']);
      expect(snapshot.context.deferredResults).toEqual([]);
    });

    it('sequential FOR (no explicit forClause transitions) — simple loop-back without aggregation', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          description: 'Loop without explicit forClause transitions',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check A',
              transitions: DEFAULT_TRANSITIONS,
            },
            {
              id: '2',
              description: 'Check B',
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

      // Iteration 1: 1.1 PASS, 1.2 FAIL → sequential mode: substep FAIL fires STOP
      // No iteration-level aggregation — substep results route directly
      actor.send({ type: 'PASS' }); // 1.1 CONTINUE → 1.2
      actor.send({ type: 'FAIL' }); // 1.2 STOP → STOPPED

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
    });

    it('non-FOR steps are unaffected', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Non-FOR step with 2 substeps',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Substep 1',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
            {
              id: '2',
              description: 'Substep 2',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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
      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
      // Non-FOR steps use deferredResults (one per substep)
      expect(snapshot.context.deferredResults).toEqual(['pass', 'pass']);
      // iterationResults is initialized but unused for non-FOR steps (entry action sets [])
      expect(snapshot.context.iterationResults).toEqual([]);
    });

    it('FOR with PASS ANY iteration-level transitions', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 2,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
            },
            aggregation: { strategy: 'ANY' },
          },
          description: 'Loop with PASS ANY (aggregation: ANY)',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check X',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
            {
              id: '2',
              description: 'Check Y',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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

      // Iteration-level PASS ANY (aggregation: 'ANY'):
      //   Iteration 1 result = fail (0 passes), action = CONTINUE
      //   Iteration 2 result = pass (1 pass), action = CONTINUE
      // Step-level PASS ALL (aggregation: 'ALL'): [fail, pass] includes a failure → STOP
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      expect(snapshot.context.iterationResults).toEqual(['fail', 'pass']);
      expect(snapshot.context.deferredResults).toEqual(['pass', 'fail']);
    });

    it('FOR with FAIL ANY: RETRY 2 BREAK retries twice then breaks', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 3,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 2, action: { type: 'BREAK' as const } },
            },
            aggregation: { strategy: 'ALL' },
          },
          description: 'Loop with RETRY on fail',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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

      // After BREAK: BREAK is non-accumulating — no iteration results reach parent.
      // Parent aggregation sees [] → PASS ALL with no fails → passes → CONTINUE → step 2
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
    });

    it('FOR with FAIL ANY: RETRY 1 DEFER retries once then defers', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 2,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 1, action: { type: 'DEFER' as const } },
            },
            aggregation: { strategy: 'ALL' },
          },
          description: 'Loop with RETRY 1 DEFER on fail',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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

      // Retry exhausted: FAIL → DEFER (loop-back with accumulation), advance to iteration 2
      actor.send({ type: 'FAIL' });

      // iterationRetryCount resets on iteration advance
      expect(actor.getSnapshot().context.iterationRetryCount).toBe(0);

      // Iteration 2: PASS → DEFER, loop ends (last iteration)
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
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 2, action: { type: 'BREAK' as const } },
            },
            aggregation: { strategy: 'ALL' },
          },
          description: 'Loop with RETRY on fail',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
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
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 1, action: { type: 'DEFER' as const } },
            },
            aggregation: { strategy: 'ALL' },
          },
          description: 'Loop with RETRY 1 DEFER',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
      actor.send({ type: 'PASS' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
    });
  });

  describe('sequential FOR (no aggregation)', () => {
    it('all pass — loops through all iterations', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'Sequential loop',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check',
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

      // Iteration 1: substep PASS → CONTINUE → loop-back
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);

      // Iteration 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);

      // Iteration 3 — last iteration → exit loop → step::2
      actor.send({ type: 'PASS' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
      expect(snapshot.context.forStack).toEqual([]);
      expect(snapshot.context.iterationResults).toEqual([]);
    });

    it('multiple substeps, all pass', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          description: 'Sequential loop with substeps',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Sub A',
              transitions: DEFAULT_TRANSITIONS,
            },
            {
              id: '2',
              description: 'Sub B',
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

      // Iteration 1
      actor.send({ type: 'PASS' }); // 1.1 CONTINUE → 1.2
      expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });
      actor.send({ type: 'PASS' }); // 1.2 CONTINUE → loop-back → iter 2
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(2);

      // Iteration 2
      actor.send({ type: 'PASS' }); // 1.1 CONTINUE → 1.2
      expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });
      actor.send({ type: 'PASS' }); // 1.2 CONTINUE → exit → step::2
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
    });

    it('substep FAIL with STOP terminates immediately', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'Sequential loop',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
        {
          name: '2',
          description: 'Done',
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // iter 1 PASS → loop-back
      actor.send({ type: 'FAIL' }); // iter 2 FAIL → STOP → STOPPED

      expect(actor.getSnapshot().value).toBe('STOPPED');
    });

    it('BREAK exits loop without aggregation', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'Sequential loop with BREAK',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'BREAK' as const } },
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

      actor.send({ type: 'PASS' }); // iter 1 PASS → loop-back
      actor.send({ type: 'FAIL' }); // iter 2 FAIL → BREAK → exit loop → step::2

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
      expect(snapshot.context.forStack).toEqual([]);
      expect(snapshot.context.iterationResults).toEqual([]);
      expect(snapshot.context.lastAction).toEqual({ type: 'BREAK' });
    });

    it('NEXT advances iteration without accumulation', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 3 },
          description: 'Sequential loop with NEXT',
          transitions: DEFAULT_TRANSITIONS,
          substeps: [
            {
              id: '1',
              description: 'Sub A',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'NEXT' as const } },
              },
            },
            {
              id: '2',
              description: 'Sub B',
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

      // Iteration 1: 1.1 FAIL → NEXT → skip 1.2, advance to iter 2
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);
      expect(actor.getSnapshot().context.lastAction).toEqual({ type: 'NEXT' });

      // Iteration 2: both substeps pass
      actor.send({ type: 'PASS' }); // 1.1 CONTINUE → 1.2
      actor.send({ type: 'PASS' }); // 1.2 CONTINUE → loop-back → iter 3

      // Iteration 3: both substeps pass → exit
      actor.send({ type: 'PASS' }); // 1.1 CONTINUE → 1.2
      actor.send({ type: 'PASS' }); // 1.2 CONTINUE → exit → step::2

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
      expect(snapshot.context.forStack).toEqual([]);
      expect(snapshot.context.iterationResults).toEqual([]);
    });

    it('parent aggregation activates iteration machinery even without forClause transitions', () => {
      // Regression guard: step.aggregation makes needsIterationMachinery true
      // even without explicit forClause.transitions or forClause.aggregation
      const steps = inferSteps([
        {
          name: '1',
          forClause: { start: 1, end: 2 },
          description: 'FOR with parent aggregation only',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
          aggregation: { strategy: 'ALL' as const },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
          ],
        },
        {
          name: '2',
          description: 'Next',
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // All PASS → iteration machinery active → aggregation → COMPLETE
      actor.send({ type: 'PASS' }); // iter 1: substep DEFER → iteration DEFER
      actor.send({ type: 'PASS' }); // iter 2: substep DEFER → iteration DEFER

      // Parent ALL aggregation: all pass → COMPLETE (directly, not via step 2)
      expect(actor.getSnapshot().value).toBe('COMPLETE');
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);
    });
  });

  describe('substep loop-control bypasses iteration-level retry', () => {
    it('substep BREAK respects iteration-level retry before exiting', () => {
      // FOR with 3 items, 2 substeps: 1.1 DEFER (accumulates), 1.2 BREAK on fail
      // Iteration FAIL ALL: RETRY 2 BREAK
      // RETRY is universal — fires for ALL actions including BREAK. After retries
      // exhausted, BREAK exits the loop.
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 3,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 2, action: { type: 'BREAK' as const } },
            },
            aggregation: { strategy: 'ALL' },
          },
          description: 'Loop with RETRY on fail',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'First check',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
            {
              id: '2',
              description: 'Second check',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'BREAK' as const } },
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

      // Attempt 1: substep 1.1 FAIL (DEFER), substep 1.2 FAIL (BREAK) → retry fires
      actor.send({ type: 'FAIL' });
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().context.iterationRetryCount).toBe(1);

      // Attempt 2 (retry 1): same events → retry fires again
      actor.send({ type: 'FAIL' });
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().context.iterationRetryCount).toBe(2);

      // Attempt 3 (retry 2): retries exhausted → BREAK exits loop
      actor.send({ type: 'FAIL' });
      actor.send({ type: 'FAIL' });

      const snapshot = actor.getSnapshot();
      // iterationRetryCount reset to 0 by parent exit assign (intermediate checks proved retry fired)
      // BREAK exits loop (non-accumulating) → iterationResults = []
      // PASS ALL: vacuous pass → CONTINUE → step::2
      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
    });

    it('substep NEXT bypasses iteration-level retry', () => {
      // FOR with 3 items, iteration FAIL ANY: RETRY 2 DEFER, substep ON FAIL: NEXT
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 3,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 2, action: { type: 'DEFER' as const } },
            },
            aggregation: { strategy: 'ALL' },
          },
          description: 'Loop with RETRY on fail',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'NEXT' as const } },
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

      // Iteration 1: FAIL → substep NEXT fires (loops back, no retry)
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().context.iterationRetryCount).toBe(0);
      // NEXT skips accumulation → iterationResults should be empty
      expect(actor.getSnapshot().context.iterationResults).toEqual([]);

      // Iteration 2: PASS → DEFER accumulates
      actor.send({ type: 'PASS' });

      // Iteration 3: PASS → last iteration, aggregation fires
      actor.send({ type: 'PASS' });

      // iterationResults: [pass] (iteration 2 loop-backed); iteration 3 computed inline as pass
      // Step-level PASS ALL: [pass, pass] → CONTINUE → step 2
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
    });

    it('substep BREAK with iteration retry — retry fires before BREAK exits', () => {
      // FOR with 2 items, 2 substeps:
      //   1.1 DEFER (accumulates result), 1.2 BREAK on fail (exits loop)
      // Iteration FAIL ALL: RETRY 2 BREAK
      // RETRY is universal — fires for ALL actions including BREAK.
      // Iteration 1: 1.1 PASS (DEFER), 1.2 PASS (DEFER) → pass → DEFER loops back
      // Iteration 2: 1.1 FAIL (DEFER), 1.2 FAIL (BREAK) → fail → retry fires
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 2,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 2, action: { type: 'BREAK' as const } },
            },
            aggregation: { strategy: 'ALL' },
          },
          description: 'Loop with RETRY on fail only',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'First check',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
            {
              id: '2',
              description: 'Second check',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'BREAK' as const } },
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

      // Iteration 1: substep 1.1 PASS (DEFER), substep 1.2 PASS (DEFER) → iteration pass → DEFER loops back
      actor.send({ type: 'PASS' });
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().context.iterationRetryCount).toBe(0);

      // Iteration 2, attempt 1: substep 1.1 FAIL (DEFER), substep 1.2 FAIL (BREAK) → retry fires
      actor.send({ type: 'FAIL' });
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().context.iterationRetryCount).toBe(1);

      // Iteration 2, attempt 2 (retry 1): FAIL, FAIL → retry fires again
      actor.send({ type: 'FAIL' });
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().context.iterationRetryCount).toBe(2);

      // Iteration 2, attempt 3 (retry 2): retries exhausted → BREAK exits loop
      actor.send({ type: 'FAIL' });
      actor.send({ type: 'FAIL' });

      const snapshot = actor.getSnapshot();
      // iterationRetryCount reset to 0 by parent exit assign (intermediate checks proved retry fired)
      // iterationResults: ['pass'] (iteration 1 from loop-back; iteration 2 BREAK'd = non-accumulating)
      // Aggregation: ['pass'] → PASS ALL passes → CONTINUE → step::2
      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
      expect(snapshot.context.iterationResults).toEqual(['pass']);
    });
  });

  describe('FOR iteration-level NEXT and CONTINUE', () => {
    it('NEXT at iteration level loops back without accumulating result', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 3,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'NEXT' as const } },
            },
            aggregation: { strategy: 'ALL' },
          },
          description: 'Loop with NEXT on fail at iteration level',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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

      // Iteration 1: FAIL → NEXT at iteration level → loop back, no accumulation
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(2);
      expect(actor.getSnapshot().context.iterationResults).toEqual([]); // NEXT skips

      // Iteration 2: PASS → DEFER → loop back with accumulation
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(3);
      expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']); // DEFER accumulates

      // Iteration 3: PASS → last iteration, aggregation
      // iterationResults: ['pass'] + inline pass = all pass → CONTINUE → step 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
    });

    it('CONTINUE at iteration level exits loop and routes through parent aggregation', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 3,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
            },
            aggregation: { strategy: 'ALL' },
          },
          description: 'Loop with CONTINUE exit on pass at iteration level',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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

      // Iteration 1: PASS → substep DEFER feeds 'pass' → iteration pass → CONTINUE → exits loop
      // CONTINUE routes through parent aggregation: ['pass'] → PASS ALL → passes → CONTINUE → step 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
    });

    it('CONTINUE at iteration level does not accumulate — only DEFER results reach parent', () => {
      const steps = inferSteps([
        {
          name: '1',
          forClause: {
            start: 1,
            end: 3,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            },
            aggregation: { strategy: 'ALL' },
          },
          description: 'Loop with CONTINUE exit on fail at iteration level',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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

      // Iteration 1: PASS → substep DEFER feeds 'pass' → iteration DEFER → loop back
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });

      // Iteration 2: FAIL → substep DEFER feeds 'fail' → iteration CONTINUE → exits loop
      // CONTINUE is non-accumulating — iteration 2's fail is NOT added to iterationResults
      // Parent aggregation sees only ['pass'] from iteration 1 → passes → CONTINUE → step 2
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });
    });
  });

  describe('aggregation substep default transitions', () => {
    it('substeps default to DEFER on fail — advance to next substep under PASS ANY', () => {
      const DEFER_TRANSITIONS = {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
      };
      const steps = inferSteps([
        {
          name: '1',
          description: 'Aggregated check',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          aggregation: { strategy: 'ANY' },
          substeps: [
            { id: '1', description: 'First check', transitions: DEFER_TRANSITIONS },
            { id: '2', description: 'Second check', transitions: DEFER_TRANSITIONS },
          ],
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });

      // Substep 1 fails — DEFAULT_AGGREGATION_SUBSTEP_TRANSITIONS FAIL: DEFER → routes to parent
      // PASS ANY: first fail doesn't determine outcome → advance to substep 2
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });

      // Substep 2 also fails — aggregation: PASS ANY with no passes → STOP
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
    });

    it('substeps with explicit CONTINUE on fail advance to next substep but skip aggregation', () => {
      const SUBSTEP_CONTINUE = {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      };
      const steps = inferSteps([
        {
          name: '1',
          description: 'Aggregated check',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          aggregation: { strategy: 'ANY' },
          substeps: [
            { id: '1', description: 'First check', transitions: SUBSTEP_CONTINUE },
            { id: '2', description: 'Second check', transitions: SUBSTEP_CONTINUE },
          ],
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });

      // Substep 1 fails — explicit CONTINUE advances to substep 2 (navigation works)
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });

      // Substep 2 passes — CONTINUE does not feed deferredResults,
      // so aggregation sees zero results. PASS ANY with 0 passes → STOP.
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('STOPPED');
    });

    it('substeps under FOR default to DEFER — failure propagates to iteration aggregation', () => {
      const DEFER_TRANSITIONS = {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
      };
      const steps = inferSteps([
        {
          name: '1',
          description: 'FOR step',
          forClause: { start: 1, end: 2, ...DEFAULT_FOR_ITERATION },
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'Check item', transitions: DEFER_TRANSITIONS }],
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });

      // Iteration 1: substep fails → DEFER → parent → iteration fails (ALL mode)
      // DEFAULT_FOR_TRANSITIONS FAIL: DEFER → loop-back with result accumulation
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });
      expect(actor.getSnapshot().context.forStack[0].iteration).toBe(2);
    });

    it('FOR with explicit FAIL: DEFER on iteration loops back with accumulation', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'FOR step',
          forClause: {
            start: 1,
            end: 2,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
            },
            aggregation: { strategy: 'ALL' },
          },
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Check item',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
            },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });

      // Iteration 1: substep fails → CONTINUE → parent → iteration DEFER → loop-back
      actor.send({ type: 'FAIL' });
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });

      // Iteration 2: substep passes → loop completes → Case C (no step transitions) → step 2
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toEqual({ 'step::2': 'idle' });

      // Step 2 passes → COMPLETE
      actor.send({ type: 'PASS' });
      expect(actor.getSnapshot().value).toBe('COMPLETE');
    });
  });

  describe('deferredResults: substep action permutations', () => {
    // Tests that only DEFER feeds deferredResults (aggregation).
    // CONTINUE, NEXT, and BREAK are flow control — they advance navigation
    // (substepCompletedCount) but do NOT populate deferredResults.

    const PASS_ALL_TRANSITIONS = {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
    };
    const PASS_ANY_TRANSITIONS = {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
    };

    function makeSubstepTransitions(passAction: string, failAction: string) {
      return {
        pass: { kind: 'pass' as const, retry: 0, action: { type: passAction as 'DEFER' } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: failAction as 'DEFER' } },
      };
    }

    describe('non-FOR: single substep', () => {
      it.each([
        // [substep action, event, expected deferredResults, expected final state]
        ['DEFER', 'PASS', ['pass'], 'COMPLETE'],
        ['DEFER', 'FAIL', ['fail'], 'STOPPED'],
        ['CONTINUE', 'PASS', [], 'COMPLETE'],
        ['CONTINUE', 'FAIL', [], 'COMPLETE'],
      ])('substep %s on %s → deferredResults=%j, final=%s (PASS ALL)', (action, event, expectedDeferred, expectedState) => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Parent',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Only substep',
                transitions: makeSubstepTransitions(action, action),
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();
        actor.send({ type: event as 'PASS' | 'FAIL' });
        const ctx = actor.getSnapshot().context;
        expect(ctx.deferredResults).toEqual(expectedDeferred);
        expect(actor.getSnapshot().value).toBe(expectedState);
      });
    });

    describe('non-FOR: two substeps, PASS ALL', () => {
      it.each([
        // [sub1 action, sub2 action, event1, event2, expected deferredResults, expected state]
        ['DEFER', 'DEFER', 'PASS', 'PASS', ['pass', 'pass'], 'COMPLETE'],
        ['DEFER', 'DEFER', 'PASS', 'FAIL', ['pass', 'fail'], 'STOPPED'],
        ['DEFER', 'DEFER', 'FAIL', 'PASS', ['fail', 'pass'], 'STOPPED'],
        ['DEFER', 'DEFER', 'FAIL', 'FAIL', ['fail', 'fail'], 'STOPPED'],
        ['CONTINUE', 'DEFER', 'PASS', 'PASS', ['pass'], 'COMPLETE'],
        ['CONTINUE', 'DEFER', 'FAIL', 'FAIL', ['fail'], 'STOPPED'],
        ['DEFER', 'CONTINUE', 'PASS', 'PASS', ['pass'], 'COMPLETE'],
        ['DEFER', 'CONTINUE', 'FAIL', 'FAIL', ['fail'], 'STOPPED'],
        ['CONTINUE', 'CONTINUE', 'PASS', 'PASS', [], 'COMPLETE'],
        ['CONTINUE', 'CONTINUE', 'FAIL', 'FAIL', [], 'COMPLETE'],
        ['CONTINUE', 'CONTINUE', 'PASS', 'FAIL', [], 'COMPLETE'],
      ])('sub1=%s sub2=%s events=%s,%s → deferredResults=%j, final=%s', (sub1Action, sub2Action, event1, event2, expectedDeferred, expectedState) => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Parent',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1',
                transitions: makeSubstepTransitions(sub1Action, sub1Action),
              },
              {
                id: '2',
                description: 'Sub 2',
                transitions: makeSubstepTransitions(sub2Action, sub2Action),
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();
        actor.send({ type: event1 as 'PASS' | 'FAIL' });
        actor.send({ type: event2 as 'PASS' | 'FAIL' });
        const ctx = actor.getSnapshot().context;
        expect(ctx.deferredResults).toEqual(expectedDeferred);
        expect(actor.getSnapshot().value).toBe(expectedState);
      });
    });

    describe('non-FOR: two substeps, PASS ANY', () => {
      it.each([
        // PASS ANY: at least one pass in deferredResults → COMPLETE; else STOPPED
        ['DEFER', 'DEFER', 'PASS', 'FAIL', ['pass', 'fail'], 'COMPLETE'],
        ['DEFER', 'DEFER', 'FAIL', 'FAIL', ['fail', 'fail'], 'STOPPED'],
        ['DEFER', 'DEFER', 'FAIL', 'PASS', ['fail', 'pass'], 'COMPLETE'],
        ['CONTINUE', 'CONTINUE', 'PASS', 'PASS', [], 'STOPPED'],
        ['CONTINUE', 'CONTINUE', 'FAIL', 'FAIL', [], 'STOPPED'],
        ['CONTINUE', 'DEFER', 'FAIL', 'PASS', ['pass'], 'COMPLETE'],
        ['CONTINUE', 'DEFER', 'FAIL', 'FAIL', ['fail'], 'STOPPED'],
      ])('sub1=%s sub2=%s events=%s,%s → deferredResults=%j, final=%s (PASS ANY)', (sub1Action, sub2Action, event1, event2, expectedDeferred, expectedState) => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Parent',
            transitions: PASS_ANY_TRANSITIONS,
            aggregation: { strategy: 'ANY' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1',
                transitions: makeSubstepTransitions(sub1Action, sub1Action),
              },
              {
                id: '2',
                description: 'Sub 2',
                transitions: makeSubstepTransitions(sub2Action, sub2Action),
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();
        actor.send({ type: event1 as 'PASS' | 'FAIL' });
        actor.send({ type: event2 as 'PASS' | 'FAIL' });
        const ctx = actor.getSnapshot().context;
        expect(ctx.deferredResults).toEqual(expectedDeferred);
        expect(actor.getSnapshot().value).toBe(expectedState);
      });
    });

    describe('non-FOR: BREAK substep in multi-substep step', () => {
      it('BREAK on second substep — only first substep DEFER feeds deferredResults', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Parent',
            forClause: { start: 1, end: 2, ...DEFAULT_FOR_ITERATION },
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1',
                transitions: makeSubstepTransitions('DEFER', 'DEFER'),
              },
              {
                id: '2',
                description: 'Sub 2',
                transitions: {
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'BREAK' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'BREAK' as const } },
                },
              },
            ],
          },
          {
            name: '2',
            description: 'Done',
            transitions: PASS_ALL_TRANSITIONS,
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Sub 1: PASS → DEFER feeds ['pass'] to deferredResults
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });

        // Sub 2: FAIL → BREAK (clears deferredResults, exits loop)
        actor.send({ type: 'FAIL' });
        expect(actor.getSnapshot().context.deferredResults).toEqual([]);
        // BREAK is non-accumulating → iterationResults = [] → PASS ALL: vacuous pass → COMPLETE
        expect(actor.getSnapshot().value).toBe('COMPLETE');
      });

      it('BREAK on second substep — DEFER+BREAK with fail gives correct aggregation', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Parent',
            forClause: { start: 1, end: 2, ...DEFAULT_FOR_ITERATION },
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1',
                transitions: makeSubstepTransitions('DEFER', 'DEFER'),
              },
              {
                id: '2',
                description: 'Sub 2',
                transitions: {
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'BREAK' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'BREAK' as const } },
                },
              },
            ],
          },
          {
            name: '2',
            description: 'Done',
            transitions: PASS_ALL_TRANSITIONS,
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Sub 1: FAIL → DEFER feeds ['fail']
        actor.send({ type: 'FAIL' });
        // Sub 2: PASS → BREAK (clears deferredResults, exits loop)
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().context.deferredResults).toEqual([]);
        // BREAK is non-accumulating → iterationResults = [] → PASS ALL: vacuous pass → COMPLETE
        expect(actor.getSnapshot().value).toBe('COMPLETE');
      });
    });

    describe('non-FOR: NEXT substep (outside FOR → STOPPED)', () => {
      it('NEXT outside FOR loop goes to STOPPED', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Parent',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1',
                transitions: {
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'NEXT' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
                },
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().value).toBe('STOPPED');
      });
    });

    describe('FOR: substep action permutations with iteration aggregation', () => {
      const FOR_DEFER_TRANSITIONS = {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
      };

      it.each([
        // [substep action, iter1 event, iter2 event, expected iterationResults, expected final]
        // Every iteration is treated uniformly — all DEFER'd results are in iterationResults.
        ['DEFER', 'PASS', 'PASS', ['pass', 'pass'], 'COMPLETE'],
        ['DEFER', 'PASS', 'FAIL', ['pass', 'fail'], 'STOPPED'],
        ['DEFER', 'FAIL', 'PASS', ['fail', 'pass'], 'STOPPED'],
        ['DEFER', 'FAIL', 'FAIL', ['fail', 'fail'], 'STOPPED'],
        // CONTINUE substep: no DEFER → deferredResults empty → vacuous pass per iteration
        ['CONTINUE', 'PASS', 'PASS', ['pass', 'pass'], 'COMPLETE'],
        ['CONTINUE', 'FAIL', 'PASS', ['pass', 'pass'], 'COMPLETE'],
        ['CONTINUE', 'PASS', 'FAIL', ['pass', 'pass'], 'COMPLETE'],
        ['CONTINUE', 'FAIL', 'FAIL', ['pass', 'pass'], 'COMPLETE'],
      ])('substep %s: iter1=%s iter2=%s → iterationResults=%j, final=%s (PASS ALL, 2 iters)', (action, event1, event2, expectedIterResults, expectedState) => {
        const steps = inferSteps([
          {
            name: '1',
            forClause: {
              start: 1,
              end: 2,
              transitions: FOR_DEFER_TRANSITIONS,
              aggregation: { strategy: 'ALL' },
            },
            description: 'FOR loop',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Single substep',
                transitions: makeSubstepTransitions(action, action),
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
        actor.send({ type: event1 as 'PASS' | 'FAIL' }); // iteration 1
        actor.send({ type: event2 as 'PASS' | 'FAIL' }); // iteration 2
        const ctx = actor.getSnapshot().context;
        expect(ctx.iterationResults).toEqual(expectedIterResults);
        expect(actor.getSnapshot().value).toBe(expectedState);
      });
    });

    describe('FOR: mixed substep actions in multi-substep iteration', () => {
      const FOR_DEFER_TRANSITIONS = {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
      };

      it('DEFER+CONTINUE: only DEFER substep feeds iteration aggregation', () => {
        const steps = inferSteps([
          {
            name: '1',
            forClause: {
              start: 1,
              end: 1,
              transitions: FOR_DEFER_TRANSITIONS,
              aggregation: { strategy: 'ALL' },
            },
            description: 'FOR loop',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1 (DEFER)',
                transitions: makeSubstepTransitions('DEFER', 'DEFER'),
              },
              {
                id: '2',
                description: 'Sub 2 (CONTINUE)',
                transitions: makeSubstepTransitions('CONTINUE', 'CONTINUE'),
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Sub 1: PASS → DEFER feeds 'pass'
        actor.send({ type: 'PASS' });
        // Sub 2: FAIL → CONTINUE (does NOT feed deferredResults)
        actor.send({ type: 'FAIL' });
        // deferredResults = ['pass'] → ALL: pass → COMPLETE
        expect(actor.getSnapshot().context.deferredResults).toEqual(['pass']);
        expect(actor.getSnapshot().value).toBe('COMPLETE');
      });

      it('CONTINUE+DEFER: only DEFER substep feeds iteration aggregation', () => {
        const steps = inferSteps([
          {
            name: '1',
            forClause: {
              start: 1,
              end: 1,
              transitions: FOR_DEFER_TRANSITIONS,
              aggregation: { strategy: 'ALL' },
            },
            description: 'FOR loop',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1 (CONTINUE)',
                transitions: makeSubstepTransitions('CONTINUE', 'CONTINUE'),
              },
              {
                id: '2',
                description: 'Sub 2 (DEFER)',
                transitions: makeSubstepTransitions('DEFER', 'DEFER'),
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Sub 1: FAIL → CONTINUE (no deferredResults entry)
        actor.send({ type: 'FAIL' });
        // Sub 2: FAIL → DEFER feeds 'fail'
        actor.send({ type: 'FAIL' });
        // deferredResults = ['fail'] → ALL: fail → STOPPED
        expect(actor.getSnapshot().context.deferredResults).toEqual(['fail']);
        expect(actor.getSnapshot().value).toBe('STOPPED');
      });

      it('all CONTINUE in FOR: iteration-level ALL gives vacuous pass, parent sees pass', () => {
        // PASS ALL at parent: iteration ALL vacuous pass → parent ALL → COMPLETE
        const stepsAll = inferSteps([
          {
            name: '1',
            forClause: {
              start: 1,
              end: 1,
              transitions: FOR_DEFER_TRANSITIONS,
              aggregation: { strategy: 'ALL' },
            },
            description: 'FOR loop',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1',
                transitions: makeSubstepTransitions('CONTINUE', 'CONTINUE'),
              },
            ],
          },
        ]);
        const machineAll = compileRunbookToMachine(stepsAll);
        const actorAll = createActor(machineAll);
        actorAll.start();
        actorAll.send({ type: 'FAIL' }); // CONTINUE does not feed deferredResults
        expect(actorAll.getSnapshot().context.deferredResults).toEqual([]);
        // Iteration ALL over empty deferredResults = vacuous pass → iteration result 'pass'
        // Parent ALL over ['pass'] → pass → COMPLETE
        expect(actorAll.getSnapshot().value).toBe('COMPLETE');

        // PASS ANY at parent: iteration ALL vacuous pass → parent ANY sees 'pass' → COMPLETE
        // (The vacuous behavior at the parent depends on iteration-level aggregation)
        const stepsAny = inferSteps([
          {
            name: '1',
            forClause: {
              start: 1,
              end: 1,
              transitions: FOR_DEFER_TRANSITIONS,
              aggregation: { strategy: 'ALL' },
            },
            description: 'FOR loop',
            transitions: PASS_ANY_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1',
                transitions: makeSubstepTransitions('CONTINUE', 'CONTINUE'),
              },
            ],
          },
        ]);
        const machineAny = compileRunbookToMachine(stepsAny);
        const actorAny = createActor(machineAny);
        actorAny.start();
        actorAny.send({ type: 'PASS' }); // CONTINUE does not feed deferredResults
        expect(actorAny.getSnapshot().context.deferredResults).toEqual([]);
        // Iteration ALL over empty = vacuous pass → parent ANY sees 'pass' → COMPLETE
        expect(actorAny.getSnapshot().value).toBe('COMPLETE');
      });

      it('S1: 3 substeps DEFER+CONTINUE+DEFER, 2 iterations — CONTINUE in middle is invisible', () => {
        const steps = inferSteps([
          {
            name: '1',
            forClause: {
              start: 1,
              end: 2,
              transitions: FOR_DEFER_TRANSITIONS,
              aggregation: { strategy: 'ALL' },
            },
            description: 'FOR loop',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1 (DEFER)',
                transitions: makeSubstepTransitions('DEFER', 'DEFER'),
              },
              {
                id: '2',
                description: 'Sub 2 (CONTINUE)',
                transitions: makeSubstepTransitions('CONTINUE', 'CONTINUE'),
              },
              {
                id: '3',
                description: 'Sub 3 (DEFER)',
                transitions: makeSubstepTransitions('DEFER', 'DEFER'),
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Iter 1: sub1=PASS(DEFER), sub2=FAIL(CONTINUE), sub3=PASS(DEFER)
        actor.send({ type: 'PASS' }); // sub1 → DEFER feeds 'pass'
        actor.send({ type: 'FAIL' }); // sub2 → CONTINUE (invisible)
        actor.send({ type: 'PASS' }); // sub3 → DEFER feeds 'pass'
        // deferredResults=['pass','pass'] → ALL: pass → iter pass → DEFER → loopback
        expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

        // Iter 2: sub1=PASS(DEFER), sub2=PASS(CONTINUE), sub3=PASS(DEFER)
        actor.send({ type: 'PASS' }); // sub1 → DEFER feeds 'pass'
        actor.send({ type: 'PASS' }); // sub2 → CONTINUE (invisible)
        actor.send({ type: 'PASS' }); // sub3 → DEFER feeds 'pass'
        // deferredResults=['pass','pass'] → ALL: pass → iter pass
        // Parent: iterationResults=['pass','pass'] → ALL: pass → COMPLETE
        expect(actor.getSnapshot().value).toBe('COMPLETE');
      });

      it('S2: 3 substeps DEFER+CONTINUE+DEFER, 1 iteration — hidden failure', () => {
        const steps = inferSteps([
          {
            name: '1',
            forClause: {
              start: 1,
              end: 1,
              transitions: FOR_DEFER_TRANSITIONS,
              aggregation: { strategy: 'ALL' },
            },
            description: 'FOR loop',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1 (DEFER)',
                transitions: makeSubstepTransitions('DEFER', 'DEFER'),
              },
              {
                id: '2',
                description: 'Sub 2 (CONTINUE)',
                transitions: makeSubstepTransitions('CONTINUE', 'CONTINUE'),
              },
              {
                id: '3',
                description: 'Sub 3 (DEFER)',
                transitions: makeSubstepTransitions('DEFER', 'DEFER'),
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // sub1=PASS(DEFER), sub2=FAIL(CONTINUE), sub3=PASS(DEFER)
        actor.send({ type: 'PASS' }); // sub1 → DEFER feeds 'pass'
        actor.send({ type: 'FAIL' }); // sub2 → CONTINUE (failure invisible)
        actor.send({ type: 'PASS' }); // sub3 → DEFER feeds 'pass'
        // deferredResults=['pass','pass'] → ALL: pass → COMPLETE
        expect(actor.getSnapshot().context.deferredResults).toEqual(['pass', 'pass']);
        expect(actor.getSnapshot().value).toBe('COMPLETE');
      });

      it('S3: 2 substeps CONTINUE+DEFER with iteration-level CONTINUE on pass', () => {
        const steps = inferSteps([
          {
            name: '1',
            forClause: {
              start: 1,
              end: 3,
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
              aggregation: { strategy: 'ALL' },
            },
            description: 'FOR loop',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1 (CONTINUE)',
                transitions: makeSubstepTransitions('CONTINUE', 'CONTINUE'),
              },
              {
                id: '2',
                description: 'Sub 2 (DEFER)',
                transitions: makeSubstepTransitions('DEFER', 'DEFER'),
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Iter 1: sub1=PASS(CONTINUE), sub2=PASS(DEFER)
        actor.send({ type: 'PASS' }); // sub1 → CONTINUE (invisible)
        actor.send({ type: 'PASS' }); // sub2 → DEFER feeds 'pass'
        // deferredResults=['pass'] → ALL: pass → iter pass → CONTINUE → exits loop
        // Parent: iterationResults=[] + partial feed → ALL: pass → COMPLETE
        expect(actor.getSnapshot().value).toBe('COMPLETE');
      });

      it('S4: 2 substeps CONTINUE+DEFER, 3 iterations — DEFER loopback then CONTINUE exit', () => {
        const steps = inferSteps([
          {
            name: '1',
            forClause: {
              start: 1,
              end: 3,
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              },
              aggregation: { strategy: 'ALL' },
            },
            description: 'FOR loop',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1 (CONTINUE)',
                transitions: makeSubstepTransitions('CONTINUE', 'CONTINUE'),
              },
              {
                id: '2',
                description: 'Sub 2 (DEFER)',
                transitions: makeSubstepTransitions('DEFER', 'DEFER'),
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Iter 1: sub1=PASS(CONTINUE), sub2=PASS(DEFER)
        actor.send({ type: 'PASS' }); // sub1 → CONTINUE (invisible)
        actor.send({ type: 'PASS' }); // sub2 → DEFER feeds 'pass'
        // deferredResults=['pass'] → ALL: pass → iter pass → DEFER → loopback
        expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

        // Iter 2: sub1=PASS(CONTINUE), sub2=PASS(DEFER)
        actor.send({ type: 'PASS' }); // sub1 → CONTINUE (invisible)
        actor.send({ type: 'PASS' }); // sub2 → DEFER feeds 'pass'
        // deferredResults=['pass'] → ALL: pass → iter pass → DEFER → loopback
        expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);

        // Iter 3: sub1=FAIL(CONTINUE), sub2=FAIL(DEFER)
        actor.send({ type: 'FAIL' }); // sub1 → CONTINUE (invisible)
        actor.send({ type: 'FAIL' }); // sub2 → DEFER feeds 'fail'
        // deferredResults=['fail'] → ALL: fail → iter fail → CONTINUE → exits loop
        // CONTINUE is non-accumulating — iter 3's fail is NOT added to iterationResults
        // Parent: iterationResults=['pass','pass'] → ALL passes → COMPLETE
        expect(actor.getSnapshot().value).toBe('COMPLETE');
      });

      it('S5: 3 substeps CONTINUE+CONTINUE+DEFER — only last feeds results', () => {
        const steps = inferSteps([
          {
            name: '1',
            forClause: {
              start: 1,
              end: 1,
              transitions: FOR_DEFER_TRANSITIONS,
              aggregation: { strategy: 'ALL' },
            },
            description: 'FOR loop',
            transitions: PASS_ANY_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1 (CONTINUE)',
                transitions: makeSubstepTransitions('CONTINUE', 'CONTINUE'),
              },
              {
                id: '2',
                description: 'Sub 2 (CONTINUE)',
                transitions: makeSubstepTransitions('CONTINUE', 'CONTINUE'),
              },
              {
                id: '3',
                description: 'Sub 3 (DEFER)',
                transitions: makeSubstepTransitions('DEFER', 'DEFER'),
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // sub1=PASS(CONTINUE), sub2=PASS(CONTINUE), sub3=FAIL(DEFER)
        actor.send({ type: 'PASS' }); // sub1 → CONTINUE (invisible)
        actor.send({ type: 'PASS' }); // sub2 → CONTINUE (invisible)
        actor.send({ type: 'FAIL' }); // sub3 → DEFER feeds 'fail'
        // deferredResults=['fail'] → ALL: fail → iter fail
        // Parent ANY: ['fail'] → 0 passes → STOPPED
        expect(actor.getSnapshot().context.deferredResults).toEqual(['fail']);
        expect(actor.getSnapshot().value).toBe('STOPPED');
      });

      it('S6: 3 substeps DEFER+CONTINUE+DEFER, PASS ANY at iteration level', () => {
        const FOR_ANY_DEFER_TRANSITIONS = {
          aggregation: { strategy: 'ANY' },
          pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
          fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
        };
        const steps = inferSteps([
          {
            name: '1',
            forClause: {
              start: 1,
              end: 2,
              transitions: FOR_ANY_DEFER_TRANSITIONS,
              aggregation: { strategy: 'ANY' },
            },
            description: 'FOR loop',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1 (DEFER)',
                transitions: makeSubstepTransitions('DEFER', 'DEFER'),
              },
              {
                id: '2',
                description: 'Sub 2 (CONTINUE)',
                transitions: makeSubstepTransitions('CONTINUE', 'CONTINUE'),
              },
              {
                id: '3',
                description: 'Sub 3 (DEFER)',
                transitions: makeSubstepTransitions('DEFER', 'DEFER'),
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Iter 1: sub1=FAIL(DEFER), sub2=PASS(CONTINUE), sub3=FAIL(DEFER)
        actor.send({ type: 'FAIL' }); // sub1 → DEFER feeds 'fail'
        actor.send({ type: 'PASS' }); // sub2 → CONTINUE (invisible — would be 'pass' but hidden)
        actor.send({ type: 'FAIL' }); // sub3 → DEFER feeds 'fail'
        // deferredResults=['fail','fail'] → ANY: 0 passes → fail → DEFER → loopback
        expect(actor.getSnapshot().context.iterationResults).toEqual(['fail']);

        // Iter 2: sub1=FAIL(DEFER), sub2=FAIL(CONTINUE), sub3=PASS(DEFER)
        actor.send({ type: 'FAIL' }); // sub1 → DEFER feeds 'fail'
        actor.send({ type: 'FAIL' }); // sub2 → CONTINUE (invisible)
        actor.send({ type: 'PASS' }); // sub3 → DEFER feeds 'pass'
        // deferredResults=['fail','pass'] → ANY: 1 pass → pass → iter pass
        // Parent: iterationResults=['fail','pass'] → ALL fails → STOPPED
        expect(actor.getSnapshot().value).toBe('STOPPED');
      });

      it('S7: all-CONTINUE substeps, 3 iterations — vacuous pass propagation', () => {
        const steps = inferSteps([
          {
            name: '1',
            forClause: {
              start: 1,
              end: 3,
              transitions: FOR_DEFER_TRANSITIONS,
              aggregation: { strategy: 'ALL' },
            },
            description: 'FOR loop',
            transitions: PASS_ANY_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1 (CONTINUE)',
                transitions: makeSubstepTransitions('CONTINUE', 'CONTINUE'),
              },
              {
                id: '2',
                description: 'Sub 2 (CONTINUE)',
                transitions: makeSubstepTransitions('CONTINUE', 'CONTINUE'),
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Iter 1: both FAIL → both CONTINUE → deferredResults=[] → ALL vacuous pass → DEFER
        actor.send({ type: 'FAIL' });
        actor.send({ type: 'FAIL' });
        expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

        // Iter 2: both FAIL → both CONTINUE → deferredResults=[] → ALL vacuous pass → DEFER
        actor.send({ type: 'FAIL' });
        actor.send({ type: 'FAIL' });
        expect(actor.getSnapshot().context.iterationResults).toEqual(['pass', 'pass']);

        // Iter 3: both FAIL → both CONTINUE → deferredResults=[] → ALL vacuous pass
        // Parent: iterationResults=['pass','pass','pass'] → ANY: 3 passes → COMPLETE
        actor.send({ type: 'FAIL' });
        actor.send({ type: 'FAIL' });
        expect(actor.getSnapshot().value).toBe('COMPLETE');
      });

      it('S8: asymmetric PASS→CONTINUE, FAIL→DEFER across 3 substeps', () => {
        const steps = inferSteps([
          {
            name: '1',
            forClause: {
              start: 1,
              end: 2,
              transitions: FOR_DEFER_TRANSITIONS,
              aggregation: { strategy: 'ALL' },
            },
            description: 'FOR loop',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1 (pass→CONTINUE, fail→DEFER)',
                transitions: makeSubstepTransitions('CONTINUE', 'DEFER'),
              },
              {
                id: '2',
                description: 'Sub 2 (pass→CONTINUE, fail→DEFER)',
                transitions: makeSubstepTransitions('CONTINUE', 'DEFER'),
              },
              {
                id: '3',
                description: 'Sub 3 (pass→CONTINUE, fail→DEFER)',
                transitions: makeSubstepTransitions('CONTINUE', 'DEFER'),
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Iter 1: sub1=PASS(CONTINUE), sub2=FAIL(DEFER), sub3=PASS(CONTINUE)
        actor.send({ type: 'PASS' }); // sub1 → CONTINUE (pass hidden)
        actor.send({ type: 'FAIL' }); // sub2 → DEFER feeds 'fail'
        actor.send({ type: 'PASS' }); // sub3 → CONTINUE (pass hidden)
        // deferredResults=['fail'] → ALL: fail → iter fail → DEFER → loopback
        expect(actor.getSnapshot().context.iterationResults).toEqual(['fail']);

        // Iter 2: sub1=PASS(CONTINUE), sub2=PASS(CONTINUE), sub3=PASS(CONTINUE)
        actor.send({ type: 'PASS' }); // sub1 → CONTINUE (hidden)
        actor.send({ type: 'PASS' }); // sub2 → CONTINUE (hidden)
        actor.send({ type: 'PASS' }); // sub3 → CONTINUE (hidden)
        // deferredResults=[] → ALL vacuous pass → iter pass
        // Parent: iterationResults=['fail','pass'] → ALL fails → STOPPED
        expect(actor.getSnapshot().value).toBe('STOPPED');
      });

      it('non-FOR: all CONTINUE with PASS ANY → vacuous fail (no deferred results)', () => {
        // Non-FOR context: deferredResults directly used for parent aggregation
        // PASS ANY with zero results → no passes → STOPPED
        const steps = inferSteps([
          {
            name: '1',
            description: 'Parent',
            transitions: PASS_ANY_TRANSITIONS,
            aggregation: { strategy: 'ANY' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1',
                transitions: makeSubstepTransitions('CONTINUE', 'CONTINUE'),
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();
        actor.send({ type: 'PASS' }); // CONTINUE does not feed deferredResults
        expect(actor.getSnapshot().context.deferredResults).toEqual([]);
        // Parent ANY over empty = no passes → STOPPED
        expect(actor.getSnapshot().value).toBe('STOPPED');
      });
    });

    describe('substepCompletedCount tracks all action types', () => {
      it('DEFER increments substepCompletedCount', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Parent',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1',
                transitions: makeSubstepTransitions('DEFER', 'DEFER'),
              },
              {
                id: '2',
                description: 'Sub 2',
                transitions: makeSubstepTransitions('DEFER', 'DEFER'),
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().context.substepCompletedCount).toBe(1);
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().context.substepCompletedCount).toBe(2);
      });

      it('CONTINUE increments substepCompletedCount', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Parent',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1',
                transitions: makeSubstepTransitions('CONTINUE', 'CONTINUE'),
              },
              {
                id: '2',
                description: 'Sub 2',
                transitions: makeSubstepTransitions('CONTINUE', 'CONTINUE'),
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().context.substepCompletedCount).toBe(1);
        actor.send({ type: 'FAIL' });
        expect(actor.getSnapshot().context.substepCompletedCount).toBe(2);
      });

      it('mixed DEFER/CONTINUE: both increment count, only DEFER feeds results', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Parent',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1 (CONTINUE)',
                transitions: makeSubstepTransitions('CONTINUE', 'CONTINUE'),
              },
              {
                id: '2',
                description: 'Sub 2 (DEFER)',
                transitions: makeSubstepTransitions('DEFER', 'DEFER'),
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        actor.send({ type: 'PASS' }); // CONTINUE: count=1, deferredResults=[]
        expect(actor.getSnapshot().context.substepCompletedCount).toBe(1);
        expect(actor.getSnapshot().value).toEqual({ 'step::1::2': 'idle' });

        actor.send({ type: 'FAIL' }); // DEFER: count=2, deferredResults=['fail']
        expect(actor.getSnapshot().context.substepCompletedCount).toBe(2);
        expect(actor.getSnapshot().context.deferredResults).toEqual(['fail']);
      });
    });

    describe('FOR: NEXT and BREAK do not feed deferredResults', () => {
      it('NEXT substep in FOR: does not populate deferredResults', () => {
        const steps = inferSteps([
          {
            name: '1',
            forClause: { start: 1, end: 2, ...DEFAULT_FOR_ITERATION },
            description: 'FOR loop',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1',
                transitions: {
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'NEXT' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
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

        // Iteration 1: PASS → NEXT (deferredResults stays [])
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().context.deferredResults).toEqual([]);

        // Iteration 2: FAIL → DEFER feeds 'fail'
        actor.send({ type: 'FAIL' });
        expect(actor.getSnapshot().context.deferredResults).toEqual(['fail']);
      });

      it('BREAK substep in FOR: does not populate deferredResults', () => {
        const steps = inferSteps([
          {
            name: '1',
            forClause: { start: 1, end: 3, ...DEFAULT_FOR_ITERATION },
            description: 'FOR loop',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1',
                transitions: {
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'BREAK' as const } },
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

        // Iteration 1: PASS → DEFER feeds 'pass'
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);

        // Iteration 2: FAIL → BREAK (deferredResults for this iteration = [], NOT ['fail'])
        actor.send({ type: 'FAIL' });
        expect(actor.getSnapshot().context.deferredResults).toEqual([]);
        // BREAK is non-accumulating — iterationResults stays ['pass'] (from iteration 1)
        expect(actor.getSnapshot().context.iterationResults).toEqual(['pass']);
        // PASS ALL with ['pass'] → all pass → COMPLETE
        expect(actor.getSnapshot().value).toBe('COMPLETE');
      });
    });

    describe('asymmetric substep actions (pass vs fail use different actions)', () => {
      it('PASS→DEFER, FAIL→CONTINUE: only pass events feed deferredResults', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Parent',
            transitions: PASS_ALL_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1',
                transitions: {
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                },
              },
              {
                id: '2',
                description: 'Sub 2',
                transitions: {
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                },
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Sub 1: FAIL → CONTINUE (no deferredResults entry)
        actor.send({ type: 'FAIL' });
        // Sub 2: PASS → DEFER feeds 'pass'
        actor.send({ type: 'PASS' });
        expect(actor.getSnapshot().context.deferredResults).toEqual(['pass']);
        // PASS ALL over ['pass'] → pass → COMPLETE
        expect(actor.getSnapshot().value).toBe('COMPLETE');
      });

      it('PASS→CONTINUE, FAIL→DEFER: only fail events feed deferredResults', () => {
        const steps = inferSteps([
          {
            name: '1',
            description: 'Parent',
            transitions: PASS_ANY_TRANSITIONS,
            aggregation: { strategy: 'ALL' },
            substeps: [
              {
                id: '1',
                description: 'Sub 1',
                transitions: {
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
                },
              },
              {
                id: '2',
                description: 'Sub 2',
                transitions: {
                  pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
                  fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
                },
              },
            ],
          },
        ]);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine);
        actor.start();

        // Sub 1: PASS → CONTINUE (no deferredResults entry)
        actor.send({ type: 'PASS' });
        // Sub 2: FAIL → DEFER feeds 'fail'
        actor.send({ type: 'FAIL' });
        expect(actor.getSnapshot().context.deferredResults).toEqual(['fail']);
        // PASS ANY over ['fail'] → no passes → STOPPED
        expect(actor.getSnapshot().value).toBe('STOPPED');
      });
    });
  });

  describe('graph validation', () => {
    it('compiles a multi-step runbook without graph validation errors', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'First',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
          },
        },
        {
          name: '2',
          description: 'Second',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
          },
        },
        {
          name: '3',
          description: 'Third',
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      // Should not throw — all targets resolve to valid states
      expect(() => compileRunbookToMachine(steps)).not.toThrow();
    });

    it('throws on GOTO to nonexistent step instead of silently routing', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Only step',
          transitions: {
            pass: {
              kind: 'pass' as const,
              retry: 0,
              action: { type: 'GOTO' as const, target: { step: 'nonexistent' } },
            },
            fail: DEFAULT_TRANSITIONS.fail,
          },
        },
      ]);

      expect(() => compileRunbookToMachine(steps)).toThrow(/GOTO target step .* does not exist/);
    });

    it('throws when NEXT appears as parent-step action', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step with substeps',
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ],
          transitions: {
            pass: {
              kind: 'pass' as const,
              retry: 0,
              action: { type: 'NEXT' as const },
            },
            fail: DEFAULT_TRANSITIONS.fail,
          },
          aggregation: { strategy: 'ALL' },
        },
        {
          name: '2',
          description: 'Second step',
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      expect(() => compileRunbookToMachine(steps)).toThrow(/invariant violation/);
    });

    it('throws when DEFER appears as parent-step pass action (substeps)', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step with substeps',
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ],
          transitions: {
            pass: {
              kind: 'pass' as const,
              retry: 0,
              action: { type: 'DEFER' as const },
            },
            fail: DEFAULT_TRANSITIONS.fail,
          },
          aggregation: { strategy: 'ALL' },
        },
        {
          name: '2',
          description: 'Second step',
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      expect(() => compileRunbookToMachine(steps)).toThrow(/DEFER.*parent.step/i);
    });

    it('throws when DEFER appears as parent-step fail action (substeps)', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step with substeps',
          substeps: [
            { id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ],
          transitions: {
            pass: DEFAULT_TRANSITIONS.pass,
            fail: {
              kind: 'fail' as const,
              retry: 0,
              action: { type: 'DEFER' as const },
            },
          },
          aggregation: { strategy: 'ALL' },
        },
        {
          name: '2',
          description: 'Second step',
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      expect(() => compileRunbookToMachine(steps)).toThrow(/DEFER.*parent.step/i);
    });

    it('throws when DEFER appears as parent FOR step action', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'FOR step',
          forClause: { start: 1, end: 3, ...DEFAULT_FOR_ITERATION },
          substeps: [{ id: '1', description: 'Sub 1', transitions: DEFAULT_TRANSITIONS }],
          transitions: {
            pass: {
              kind: 'pass' as const,
              retry: 0,
              action: { type: 'DEFER' as const },
            },
            fail: DEFAULT_TRANSITIONS.fail,
          },
          aggregation: { strategy: 'ALL' },
        },
        {
          name: '2',
          description: 'Second step',
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      expect(() => compileRunbookToMachine(steps)).toThrow(/DEFER.*parent.step/i);
    });

    it('allows DEFER at substep level (non-regression)', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Step with substeps',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Sub 1',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
            { id: '2', description: 'Sub 2', transitions: DEFAULT_TRANSITIONS },
          ],
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      expect(() => compileRunbookToMachine(steps)).not.toThrow();
    });

    it('throws on duplicate state IDs', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'First step',
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '1',
          description: 'Duplicate step name',
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      expect(() => compileRunbookToMachine(steps)).toThrow(/duplicate state ID/);
    });
  });

  describe('SET_VARIABLES event', () => {
    it('SET_VARIABLES event merges into context.variables without changing step', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'First step',
          transitions: DEFAULT_TRANSITIONS,
        },
        {
          name: '2',
          description: 'Second step',
          transitions: {
            ...DEFAULT_TRANSITIONS,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      expect(actor.getSnapshot().context.variables).toEqual({});

      actor.send({ type: 'SET_VARIABLES', vars: { PlanPath: 'plan.json', count: '3' } });

      const snapshot = actor.getSnapshot();
      expect(snapshot.context.variables).toEqual({ PlanPath: 'plan.json', count: '3' });
      // Step should not have changed
      expect(snapshot.value).toEqual({ 'step::1': 'idle' });
    });

    it('SET_VARIABLES merges additively (does not replace)', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'First step',
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'SET_VARIABLES', vars: { A: 'first' } });
      actor.send({ type: 'SET_VARIABLES', vars: { B: 'second' } });

      expect(actor.getSnapshot().context.variables).toEqual({ A: 'first', B: 'second' });
    });

    it('SET_VARIABLES overwrites existing key on repeated send', () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'First step',
          transitions: DEFAULT_TRANSITIONS,
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'SET_VARIABLES', vars: { Answer: '41' } });
      actor.send({ type: 'SET_VARIABLES', vars: { Answer: '42' } });

      expect(actor.getSnapshot().context.variables).toEqual({ Answer: '42' });
    });
  });

  describe('COMMAND_RESULT event with OUTPUTS', () => {
    let tmp: string;

    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'command-result-'));
    });

    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    async function writeChannel(name: string, contents: string) {
      const channelPath = path.join(tmp, name);
      await writeFile(channelPath, contents, 'utf-8');
      return { name, path: channelPath };
    }

    it('nests a single __capture child whose actor passes through the result discriminant', () => {
      const steps = createRunbook(`## 1. capture
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - Foo
\`\`\`bash
echo hi
\`\`\`
`);
      const machine = compileRunbookToMachine(steps);
      const states = machine.config.states as Record<string, any>;

      // No top-level capture states (sibling-design relics)
      expect(states['step::1::__capture']).toBeUndefined();
      expect(states['step::1::__capture-pass']).toBeUndefined();
      expect(states['step::1::__capture-fail']).toBeUndefined();

      // Leaf is now compound with a single __capture child
      const leaf = states['step::1'];
      expect(leaf.initial).toBe('idle');
      expect(leaf.states.idle).toBeDefined();
      expect(leaf.states.__capture).toBeDefined();
      expect(leaf.states.__capture.tags).toContain(PENDING_MACHINE_EFFECT_TAG);

      // Leaf idle state's COMMAND_RESULT is a single unguarded transition to the child.
      // No assign — discriminant passes through actor IO, not context.
      // XState may normalise a single-object transition into an array of one;
      // tolerate both shapes when reading back the config.
      const cr = leaf.states.idle.on.COMMAND_RESULT;
      const crT = Array.isArray(cr) ? cr[0] : cr;
      expect(crT.target).toBe('#step::1.__capture');
      expect(crT.guard).toBeUndefined();
      // `actions` may be absent or an empty array depending on normalization.
      expect(crT.actions ?? []).toEqual([]);

      // onDone has NO target — raised PASS/FAIL bubbles to the leaf.
      expect(leaf.states.__capture.invoke.onDone.target).toBeUndefined();

      // onError routes to top-level STOPPED via #STOPPED id reference
      expect(leaf.states.__capture.invoke.onError.target).toBe('#STOPPED');

      // STOPPED carries its id so #STOPPED resolves
      expect(states.STOPPED.id).toBe('STOPPED');

      // No pendingResult-like context field
      expect('pendingResult' in machine.config.context).toBe(false);
    });

    it('rejects relative transition targets that do not resolve to child states', () => {
      expect(() => {
        validateGraphForTest(
          {
            'step::1': {
              initial: 'idle',
              on: {
                COMMAND_RESULT: {
                  target: '.__missing',
                },
              },
              states: {
                idle: {},
              },
            },
          },
          'step::1',
          new Set(['COMPLETE', 'STOPPED']),
          '#STOPPED',
        );
      }).toThrow(/unknown relative target "\.__missing"/);
    });

    it('rejects side-effect child states missing PENDING_MACHINE_EFFECT_TAG', () => {
      // Issue 14: a __capture / __resolve-artifacts child must carry the
      // pending-effect tag so consumers can hold off persistence while the
      // invoke is in flight. Tag-less side-effect children are an invariant
      // violation. The fabricated graph is intentionally malformed —
      // bypass the strict XState `invoke` typing via a structural cast that
      // still preserves the public {@link validateGraphForTest} signature.
      type ValidateGraphStates = Parameters<typeof validateGraphForTest>[0];
      const malformed = {
        'step::1': {
          initial: 'idle',
          states: {
            idle: {},
            __capture: {
              // tags missing — must be flagged
              invoke: {
                src: 'outputCaptureActor',
                onError: { target: '#STOPPED' },
              },
            },
          },
        },
      } as unknown as ValidateGraphStates;
      expect(() => {
        validateGraphForTest(malformed, 'step::1', new Set(['COMPLETE', 'STOPPED']), '#STOPPED');
      }).toThrow(/must include ".*pending-machine-effect" tag|PENDING_MACHINE_EFFECT_TAG/);
    });

    it('rejects side-effect child states whose onError does not target #STOPPED', () => {
      // Issue 14: side-effect children must fail-closed to #STOPPED. Any
      // other onError target risks bypassing the terminal failure path.
      type ValidateGraphStates = Parameters<typeof validateGraphForTest>[0];
      const malformed = {
        'step::1': {
          initial: 'idle',
          states: {
            idle: {},
            __capture: {
              tags: [PENDING_MACHINE_EFFECT_TAG],
              invoke: {
                src: 'outputCaptureActor',
                onError: { target: 'idle' },
              },
            },
          },
        },
      } as unknown as ValidateGraphStates;
      expect(() => {
        validateGraphForTest(malformed, 'step::1', new Set(['COMPLETE', 'STOPPED']), '#STOPPED');
      }).toThrow(/onError\.target/);
    });

    it('rejects side-effect child onDone targets that point at non-sibling states', () => {
      // Issue 14: onDone targets on side-effect children must refer to a
      // sibling child of the same compound parent. Anything else (top-level
      // state, dotted reference into another state) would break the invoke
      // completion path and leave the machine in a half-state.
      type ValidateGraphStates = Parameters<typeof validateGraphForTest>[0];
      const malformed = {
        'step::1': {
          initial: 'idle',
          states: {
            idle: {},
            __capture: {
              tags: [PENDING_MACHINE_EFFECT_TAG],
              invoke: {
                src: 'outputCaptureActor',
                onDone: { target: '.__not-a-sibling' },
                onError: { target: '#STOPPED' },
              },
            },
          },
        },
      } as unknown as ValidateGraphStates;
      expect(() => {
        validateGraphForTest(malformed, 'step::1', new Set(['COMPLETE', 'STOPPED']), '#STOPPED');
      }).toThrow(/unknown child/);
    });

    it('rejects parent-entry states missing PENDING_MACHINE_EFFECT_TAG', () => {
      type ValidateGraphStates = Parameters<typeof validateGraphForTest>[0];
      const malformed = {
        'step::1::__parent-entry::2': {
          // tags missing — parent-entry resolution is a machine effect and
          // must block persistence while its invoke is in flight.
          invoke: {
            src: 'artifactResolveActor',
            onDone: { target: 'step::1::2' },
            onError: { target: '#STOPPED' },
          },
        },
        'step::1::2': {
          initial: 'idle',
          states: {
            idle: {},
          },
        },
      } as unknown as ValidateGraphStates;

      expect(() => {
        validateGraphForTest(
          malformed,
          'step::1::__parent-entry::2',
          new Set(['COMPLETE', 'STOPPED']),
          '#STOPPED',
        );
      }).toThrow(/parent-entry.*pending-machine-effect/);
    });

    it('rejects parent-entry states whose onError does not target #STOPPED', () => {
      type ValidateGraphStates = Parameters<typeof validateGraphForTest>[0];
      const malformed = {
        'step::1::__parent-entry::2': {
          tags: [PENDING_MACHINE_EFFECT_TAG],
          invoke: {
            src: 'artifactResolveActor',
            onDone: { target: 'step::1::2' },
            onError: { target: 'step::1::2' },
          },
        },
        'step::1::2': {
          initial: 'idle',
          states: {
            idle: {},
          },
        },
      } as unknown as ValidateGraphStates;

      expect(() => {
        validateGraphForTest(
          malformed,
          'step::1::__parent-entry::2',
          new Set(['COMPLETE', 'STOPPED']),
          '#STOPPED',
        );
      }).toThrow(/parent-entry.*onError\.target/);
    });

    it('rejects parent-entry states whose success target is not a generated state', () => {
      type ValidateGraphStates = Parameters<typeof validateGraphForTest>[0];
      const malformed = {
        'step::1::__parent-entry::2': {
          tags: [PENDING_MACHINE_EFFECT_TAG],
          invoke: {
            src: 'artifactResolveActor',
            onDone: { target: 'step::1::missing' },
            onError: { target: '#STOPPED' },
          },
        },
        'step::1::2': {
          initial: 'idle',
          states: {
            idle: {},
          },
        },
      } as unknown as ValidateGraphStates;

      expect(() => {
        validateGraphForTest(
          malformed,
          'step::1::__parent-entry::2',
          new Set(['COMPLETE', 'STOPPED']),
          '#STOPPED',
        );
      }).toThrow(/parent-entry.*onDone\.target.*generated state/);
    });

    it('rejects __execute-command child states missing PENDING_MACHINE_EFFECT_TAG (regression: isSideEffectLeafSubstate excludes __execute-command)', () => {
      // Regression coverage: __execute-command is a machine-owned pending
      // effect and must carry the pending-effect tag like the other side-effect
      // children.
      type ValidateGraphStates = Parameters<typeof validateGraphForTest>[0];
      const malformed = {
        'step::1': {
          initial: 'idle',
          states: {
            idle: {},
            '__execute-command': {
              // tags intentionally missing — must be flagged by validateGraph
              invoke: {
                src: 'commandExecActor',
                onError: { target: '#STOPPED' },
              },
            },
          },
        },
      } as unknown as ValidateGraphStates;
      expect(() => {
        validateGraphForTest(malformed, 'step::1', new Set(['COMPLETE', 'STOPPED']), '#STOPPED');
      }).toThrow(/must include ".*pending-machine-effect" tag|PENDING_MACHINE_EFFECT_TAG/);
    });

    it('keeps COMMAND_RESULT scoped to idle while output capture is pending', async () => {
      let resolveCapture: ((output: OutputCaptureOutput) => void) | undefined;
      const steps = createRunbook(`## 1. capture
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - Foo
\`\`\`bash
echo hi
\`\`\`
`);
      const machine = compileRunbookToMachine(steps).provide({
        actors: {
          outputCaptureActor: fromPromise<OutputCaptureOutput, OutputCaptureInput>(
            () =>
              new Promise<OutputCaptureOutput>((resolve) => {
                resolveCapture = resolve;
              }),
          ),
        },
      });
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'COMMAND_RESULT', result: 'pass', channels: [] });
      await waitFor(actor, (snapshot) => snapshot.hasTag(PENDING_MACHINE_EFFECT_TAG), {
        timeout: 1_000,
      });

      actor.send({ type: 'COMMAND_RESULT', result: 'fail', channels: [] });
      expect(actor.getSnapshot().value).toEqual({ 'step::1': '__capture' });

      expect(resolveCapture).toBeDefined();
      resolveCapture!({ result: 'pass', variables: { Foo: 'first' } });
      const snap = await waitFor(
        actor,
        (snapshot) => !snapshot.hasTag(PENDING_MACHINE_EFFECT_TAG),
        {
          timeout: 1_000,
        },
      );

      expect(snap.value).toBe('COMPLETE');
      expect(snap.context.variables).toEqual({ Foo: 'first' });
    });

    it('keeps EXECUTE_COMMAND scoped to idle while command execution is pending', async () => {
      let executeCalls = 0;
      let resolveCommand: ((output: CommandExecutionOutput) => void) | undefined;
      const steps = createRunbook(`## 1. run
- PASS COMPLETE
- FAIL STOP
\`\`\`bash
echo hi
\`\`\`
`);
      const machine = compileRunbookToMachine(steps, {
        commandServices: COMMAND_SERVICES,
        evaluationOptions: { cwd: process.cwd() },
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: 'rd_11111111111111111111111111111111',
          ContextId: 'ctx',
          WorkPath: '.rundown/work',
          RunbookRef: { source: 'project', path: 'workflow.runbook.md' },
        }),
      }).provide({
        actors: {
          commandExecActor: fromPromise<CommandExecutionOutput, CommandExecutionInput>(
            () =>
              new Promise<CommandExecutionOutput>((resolve) => {
                executeCalls += 1;
                resolveCommand = resolve;
              }),
          ),
        },
      });
      const actor = createActor(machine);
      actor.start();

      actor.send({
        type: 'EXECUTE_COMMAND',
        command: 'echo first',
        displayCommand: 'echo first',
        outputScope: { stepId: '1' },
        nakedOutputs: [],
        rdInjected: {},
      });
      await waitFor(actor, (snapshot) => snapshot.hasTag(PENDING_MACHINE_EFFECT_TAG), {
        timeout: 1_000,
      });

      actor.send({
        type: 'EXECUTE_COMMAND',
        command: 'echo second',
        displayCommand: 'echo second',
        outputScope: { stepId: '1' },
        nakedOutputs: [],
        rdInjected: {},
      });
      expect(executeCalls).toBe(1);
      expect(actor.getSnapshot().value).toEqual({ 'step::1': '__execute-command' });

      expect(resolveCommand).toBeDefined();
      resolveCommand!({
        kind: 'completed',
        command: 'echo first',
        displayCommand: 'echo first',
        success: true,
        result: 'pass',
        exitCode: 0,
        channels: [],
      });
      const snap = await waitFor(
        actor,
        (snapshot) => !snapshot.hasTag(PENDING_MACHINE_EFFECT_TAG),
        {
          timeout: 1_000,
        },
      );

      expect(snap.value).toBe('COMPLETE');
      expect(executeCalls).toBe(1);
    });

    it('keeps APPLY_CURRENT_RESOLVED_COMPLETION scoped to idle while output capture is pending', async () => {
      let resolveCapture: ((output: OutputCaptureOutput) => void) | undefined;
      const steps = createRunbook(`## 1. capture
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - Foo
\`\`\`bash
echo hi
\`\`\`
`);
      const machine = compileRunbookToMachine(steps).provide({
        actors: {
          outputCaptureActor: fromPromise<OutputCaptureOutput, OutputCaptureInput>(
            () =>
              new Promise<OutputCaptureOutput>((resolve) => {
                resolveCapture = resolve;
              }),
          ),
        },
      });
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'COMMAND_RESULT', result: 'pass', channels: [] });
      await waitFor(actor, (snapshot) => snapshot.hasTag(PENDING_MACHINE_EFFECT_TAG), {
        timeout: 1_000,
      });

      actor.send({
        type: 'APPLY_CURRENT_RESOLVED_COMPLETION',
        completionKey: buildCompletionKey(buildFrameKey('1'), 1, '1'),
        completion: brandCurrentCursorResolvedCompletionForTest({
          agentId: 'delegation',
          result: 'fail',
          targetStep: '1',
          targetSubstep: '1',
          targetFrameKey: buildFrameKey('1'),
          targetEntry: 1,
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      });
      expect(actor.getSnapshot().value).toEqual({ 'step::1': '__capture' });

      expect(resolveCapture).toBeDefined();
      resolveCapture!({ result: 'pass', variables: { Foo: 'first' } });
      const snap = await waitFor(
        actor,
        (snapshot) => !snapshot.hasTag(PENDING_MACHINE_EFFECT_TAG),
        {
          timeout: 1_000,
        },
      );

      expect(snap.value).toBe('COMPLETE');
      expect(snap.context.variables).toEqual({ Foo: 'first' });
    });

    it('captures (no-op) with empty channels and still fires PASS', async () => {
      const steps = createRunbook(`## 1. capture
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - Foo
\`\`\`bash
echo hi
\`\`\`
`);
      const actor = createActor(compileRunbookToMachine(steps));
      actor.start();

      // Pin the `initial: 'idle'` contract — before any COMMAND_RESULT, the
      // leaf must be settled in its idle child, not in __capture.
      expect(actor.getSnapshot().value).toEqual({ 'step::1': 'idle' });

      actor.send({
        type: 'COMMAND_RESULT',
        result: 'pass',
        channels: [],
      });

      const snap = await waitFor(
        actor,
        (snapshot) => !snapshot.hasTag(PENDING_MACHINE_EFFECT_TAG),
        { timeout: 1_000 },
      );

      expect(snap.context.variables).toEqual({});
      expect(snap.value).toBe('COMPLETE');
    });

    it('captures during pending retries and overwrites on subsequent attempts', async () => {
      const steps = createRunbook(`## 1. capture
- PASS COMPLETE
- FAIL RETRY 2 STOP
- OUTPUTS
  - Foo
\`\`\`bash
exit 1
\`\`\`
`);
      const actor = createActor(compileRunbookToMachine(steps));
      actor.start();

      actor.send({
        type: 'COMMAND_RESULT',
        result: 'fail',
        channels: [await writeChannel('Foo', 'first-attempt')],
      });
      const snap = await waitFor(
        actor,
        (snapshot) => !snapshot.hasTag(PENDING_MACHINE_EFFECT_TAG),
        { timeout: 1_000 },
      );
      expect(snap.context.variables.Foo).toBe('first-attempt');
      expect(snap.context.retryCount).toBe(1);
      // After RETRY cycle, leaf settles in the idle substate (compound shape).
      // Assert the exact compound value so a regression that lands in
      // __capture (still tagged) or a different leaf is caught.
      expect(snap.value).toEqual({ 'step::1': 'idle' });
    });

    it('overwrites captured variables on the retry-exhausting attempt', async () => {
      const steps = createRunbook(`## 1. capture
- PASS COMPLETE
- FAIL RETRY 1 STOP
- OUTPUTS
  - Foo
\`\`\`bash
exit 1
\`\`\`
`);
      const actor = createActor(compileRunbookToMachine(steps));
      actor.start();

      actor.send({
        type: 'COMMAND_RESULT',
        result: 'fail',
        channels: [await writeChannel('Foo', 'first-attempt')],
      });
      let snap = await waitFor(actor, (snapshot) => !snapshot.hasTag(PENDING_MACHINE_EFFECT_TAG), {
        timeout: 1_000,
      });
      expect(snap.context.variables.Foo).toBe('first-attempt');
      expect(snap.context.retryCount).toBe(1);
      expect(snap.value).toEqual({ 'step::1': 'idle' });

      actor.send({
        type: 'COMMAND_RESULT',
        result: 'fail',
        channels: [await writeChannel('Foo', 'final-attempt')],
      });
      snap = await waitFor(actor, (snapshot) => !snapshot.hasTag(PENDING_MACHINE_EFFECT_TAG), {
        timeout: 1_000,
      });
      expect(snap.context.variables.Foo).toBe('final-attempt');
      expect(snap.value).toBe('STOPPED');
    });

    it('captures variables on COMMAND_RESULT inside a FOR-iteration substep leaf', async () => {
      const steps = createRunbook(`## 1. deploy
- FOR i IN 1 TO 2
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 run step
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - DeployResult
\`\`\`bash
echo "deployed $i"
\`\`\`

## 2. done
- PASS COMPLETE
- FAIL STOP
`);
      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Machine starts at step::1::1 (first FOR-iteration substep leaf)
      // After Task 3, substep leaves are compound with nested __capture child
      expect(actor.getSnapshot().value).toEqual({ 'step::1::1': 'idle' });

      const channel1 = await writeChannel('DeployResult', 'ok-staging\n');

      actor.send({
        type: 'COMMAND_RESULT',
        result: 'pass',
        channels: [channel1],
      });

      const snap = await waitFor(
        actor,
        (snapshot) => !snapshot.hasTag(PENDING_MACHINE_EFFECT_TAG),
        { timeout: 1_000 },
      );

      expect(snap.context.variables.DeployResult).toBe('ok-staging');
      // The leaf stays active through idle ↔ __capture, so initForStack
      // (entry action) is not re-fired during capture. forStack must have
      // exactly one frame — double-init would push a second.
      expect(snap.context.forStack.length).toBe(1);
    });

    it('captures variables and continues to next step on FAIL CONTINUE', async () => {
      const steps = createRunbook(`## 1. capture
- PASS COMPLETE
- FAIL CONTINUE
- OUTPUTS
  - Foo
\`\`\`bash
exit 1
\`\`\`

## 2. done
- PASS COMPLETE
- FAIL STOP
`);
      const actor = createActor(compileRunbookToMachine(steps));
      actor.start();

      actor.send({
        type: 'COMMAND_RESULT',
        result: 'fail',
        channels: [await writeChannel('Foo', 'captured-on-fail')],
      });
      const snap = await waitFor(
        actor,
        (snapshot) => !snapshot.hasTag(PENDING_MACHINE_EFFECT_TAG),
        {
          timeout: 1_000,
        },
      );

      expect(snap.context.variables.Foo).toBe('captured-on-fail');
      expect(snap.value).toEqual({ 'step::2': 'idle' });
    });

    it('routes to STOPPED with OUTPUT_CAPTURE_FAILED when outputCaptureActor rejects', async () => {
      const steps = createRunbook(`## 1. capture
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - Foo
\`\`\`bash
echo hi
\`\`\`
`);
      const machine = compileRunbookToMachine(steps).provide({
        actors: {
          outputCaptureActor: fromPromise(() => Promise.reject(new Error('disk full'))),
        },
      });
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'COMMAND_RESULT', result: 'pass', channels: [] });

      const snap = await waitFor(actor, (s) => s.value === 'STOPPED', { timeout: 1_000 });
      expect(snap.value).toBe('STOPPED');
      expect(snap.context.lastAction?.type).toBe('OUTPUT_CAPTURE_FAILED');
      expect((snap.context.lastAction as { message?: string }).message).toBe('disk full');
      expect(snap.context.lifecycle).toBe('stopped');
    });
  });

  describe('ARTIFACTS entry resolution', () => {
    interface TestStateConfig {
      readonly initial?: unknown;
      readonly states?: Readonly<Record<string, TestStateConfig>>;
      readonly tags?: readonly unknown[];
      readonly invoke?: {
        readonly src?: unknown;
        readonly onDone?: unknown;
        readonly onError?: unknown;
      };
    }

    function isRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    function asTestStateConfig(value: unknown): TestStateConfig {
      if (!isRecord(value)) {
        throw new Error('Expected state config object');
      }
      return value;
    }

    function getRequiredStateForTest(config: unknown, id: string): TestStateConfig {
      if (!isRecord(config) || !isRecord(config.states)) {
        throw new Error('Expected machine config with states');
      }
      const state = config.states[id];
      if (state === undefined) {
        throw new Error(`Missing state ${id}`);
      }
      return asTestStateConfig(state);
    }

    function getRequiredChildStateForTest(state: TestStateConfig, id: string): TestStateConfig {
      const child = state.states?.[id];
      if (child === undefined) {
        throw new Error(`Missing child state ${id}`);
      }
      return child;
    }

    function getChildStatesForTest(
      state: TestStateConfig,
    ): Readonly<Record<string, TestStateConfig>> {
      return state.states ?? {};
    }

    function getTagsForTest(state: TestStateConfig): readonly unknown[] {
      return state.tags ?? [];
    }

    function getInvokeForTest(state: TestStateConfig): NonNullable<TestStateConfig['invoke']> {
      if (state.invoke === undefined) {
        throw new Error('Expected state config with invoke');
      }
      return state.invoke;
    }

    function transitionTargetForTest(value: unknown): unknown {
      if (Array.isArray(value)) {
        return transitionTargetForTest(value[0]);
      }
      return isRecord(value) ? value.target : undefined;
    }

    async function appendArtifactManifestRecordForTest(
      cwd: string,
      uri: string,
      runbook: RunbookRef,
    ): Promise<void> {
      const identity = parseExactArtifactUriParts(uri);
      if (identity === null) {
        throw new Error(`Expected exact artifact URI, got ${uri}`);
      }

      await appendArtifactManifestRecord(
        { cwd, workPath: '.rundown/work' },
        {
          kind: 'artifact-record',
          uri,
          runId: identity.runId,
          contextId: identity.contextId,
          runbook,
          key: identity.key,
          timestamp: '2026-05-12T00:00:00.000Z',
        },
      );
      await mkdir(path.join(cwd, '.rundown/work', `.rd-${identity.contextId}`, identity.runId), {
        recursive: true,
      });
      await writeFile(
        path.join(cwd, '.rundown/work', `.rd-${identity.contextId}`, identity.runId, identity.key),
        '{}',
      );
    }

    it('adds __resolve-artifacts before idle for ARTIFACTS-bearing simple steps', () => {
      const steps = createRunbook(`## 1. Write plan
- ARTIFACTS
  - PlanPath "plan.json"
- PASS COMPLETE
`);

      const machine = compileRunbookToMachine(steps);
      const leaf = getRequiredStateForTest(machine.config, 'step::1');
      const resolver = getRequiredChildStateForTest(leaf, '__resolve-artifacts');

      expect(leaf.initial).toBe('__resolve-artifacts');
      expect(resolver.tags).toContain(PENDING_MACHINE_EFFECT_TAG);
      expect(resolver.invoke?.src).toBe('artifactResolveActor');
      expect(transitionTargetForTest(resolver.invoke?.onDone)).toBe('idle');
      expect(transitionTargetForTest(resolver.invoke?.onError)).toBe('#STOPPED');
    });

    it('does not add __resolve-artifacts to leaves without ARTIFACTS', () => {
      const steps = createRunbook(`## 1. No artifacts
- PASS COMPLETE
`);

      const machine = compileRunbookToMachine(steps);
      const leaf = getRequiredStateForTest(machine.config, 'step::1');

      expect(leaf.initial).toBe('idle');
      expect(leaf.states?.['__resolve-artifacts']).toBeUndefined();
    });

    it('resolves substep ARTIFACTS into variables before the substep opens', async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'rundown-substep-artifacts-'));
      try {
        const steps = createRunbook(`## 1. Parent
### 1.1 Child
- ARTIFACTS
  - ChildPath "child.json"
- PASS COMPLETE
`);
        const machine = compileRunbookToMachine(steps, {
          templateVars: brandFlattenedTemplateVarsForTest({
            WorkPath: '.rundown/work',
            ContextId: 'ctx1',
            RunId: 'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            RunbookRef: { source: 'project', path: 'parent.md' },
          }),
          evaluationOptions: { cwd },
        });
        const actor = createActor(machine);
        actor.start();

        const snapshot = await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG), {
          timeout: 3000,
        });

        expect(snapshot.value).toEqual({ 'step::1::1': 'idle' });
        expect(snapshot.context.variables.ChildPath).toMatchObject({
          uri: 'rd://artifacts/ctx1/rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/child.json',
          key: 'child.json',
        });
        expect(snapshot.context.enteredArtifacts).toEqual({
          ChildPath: snapshot.context.variables.ChildPath,
        });
        actor.stop();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('resolves parent-step ARTIFACTS before entering the first child', async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'rundown-parent-artifacts-first-'));
      try {
        const steps = createRunbook(`## 1. Parent
- ARTIFACTS
  - ParentPath "parent.json"
### 1.1 First
- PASS CONTINUE
### 1.2 Second
- PASS COMPLETE
`);
        const machine = compileRunbookToMachine(steps, {
          templateVars: brandFlattenedTemplateVarsForTest({
            WorkPath: '.rundown/work',
            ContextId: 'ctx1',
            RunId: 'rd_cccccccccccccccccccccccccccccccc',
            RunbookRef: { source: 'project', path: 'parent.md' },
          }),
          evaluationOptions: { cwd },
        });
        const actor = createActor(machine);
        actor.start();

        const snapshot = await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG), {
          timeout: 3000,
        });

        expect(snapshot.value).toEqual({ 'step::1::1': 'idle' });
        expect(snapshot.context.variables.ParentPath).toMatchObject({
          key: 'parent.json',
        });
        expect(snapshot.context.enteredArtifacts).toEqual({
          ParentPath: snapshot.context.variables.ParentPath,
        });
        actor.stop();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('resolves parent-step ARTIFACTS before direct GOTO to a non-first child', async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'rundown-parent-artifacts-goto-'));
      try {
        const steps = createRunbook(`## 1. Start
- PASS GOTO 2.2

## 2. Parent
- ARTIFACTS
  - ParentPath "parent.json"
### 2.1 First
- PASS CONTINUE
### 2.2 Second
- PASS COMPLETE
`);
        const machine = compileRunbookToMachine(steps, {
          templateVars: brandFlattenedTemplateVarsForTest({
            WorkPath: '.rundown/work',
            ContextId: 'ctx1',
            RunId: 'rd_dddddddddddddddddddddddddddddddd',
            RunbookRef: { source: 'project', path: 'parent.md' },
          }),
          evaluationOptions: { cwd },
        });
        const actor = createActor(machine);
        actor.start();
        actor.send({ type: 'PASS' });

        const snapshot = await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG), {
          timeout: 3000,
        });

        expect(snapshot.value).toEqual({ 'step::2::2': 'idle' });
        expect(snapshot.context.variables.ParentPath).toMatchObject({
          uri: 'rd://artifacts/ctx1/rd_dddddddddddddddddddddddddddddddd/parent.json',
        });
        actor.stop();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('makes parent ARTIFACTS visible to later sibling substeps', async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'rundown-parent-artifacts-sibling-'));
      try {
        const steps = createRunbook(`## 1. Parent
- ARTIFACTS
  - ParentPath "parent.json"
### 1.1 First
- PASS CONTINUE
### 1.2 Second
- ARTIFACTS
  - ParentPath
- PASS COMPLETE
`);
        const machine = compileRunbookToMachine(steps, {
          templateVars: brandFlattenedTemplateVarsForTest({
            WorkPath: '.rundown/work',
            ContextId: 'ctx1',
            RunId: 'rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            RunbookRef: { source: 'project', path: 'parent.md' },
          }),
          evaluationOptions: { cwd },
        });
        const actor = createActor(machine);
        actor.start();
        await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG), {
          timeout: 3000,
        });
        actor.send({ type: 'PASS' });
        const second = await waitFor(
          actor,
          (snap) =>
            !snap.hasTag(PENDING_MACHINE_EFFECT_TAG) &&
            JSON.stringify(snap.value) === JSON.stringify({ 'step::1::2': 'idle' }),
          { timeout: 3000 },
        );

        expect(second.context.enteredArtifacts?.ParentPath).toEqual(
          second.context.variables.ParentPath,
        );
        actor.stop();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('keeps ARTIFACTS in global variables for subsequent steps', async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'rundown-artifacts-global-vars-'));
      try {
        const steps = createRunbook(`## 1. Produce
- ARTIFACTS
  - PlanPath "plan.json"
- PASS CONTINUE

## 2. Consume later
- ARTIFACTS
  - PlanPath
- PASS COMPLETE
`);
        const machine = compileRunbookToMachine(steps, {
          templateVars: brandFlattenedTemplateVarsForTest({
            WorkPath: '.rundown/work',
            ContextId: 'ctx1',
            RunId: 'rd_a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2',
            RunbookRef: { source: 'project', path: 'global-vars.md' },
          }),
          evaluationOptions: { cwd },
        });
        const actor = createActor(machine);
        actor.start();
        const first = await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG), {
          timeout: 3000,
        });
        actor.send({ type: 'PASS' });
        const second = await waitFor(
          actor,
          (snap) =>
            !snap.hasTag(PENDING_MACHINE_EFFECT_TAG) &&
            JSON.stringify(snap.value) === JSON.stringify({ 'step::2': 'idle' }),
          { timeout: 3000 },
        );

        expect(second.context.variables.PlanPath).toEqual(first.context.variables.PlanPath);
        expect(second.context.enteredArtifacts).toEqual({
          PlanPath: first.context.variables.PlanPath,
        });
        actor.stop();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('clears entered ARTIFACTS when entering a later step without ARTIFACTS', async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'rundown-artifacts-clear-entry-'));
      try {
        const steps = createRunbook(`## 1. Produce
- ARTIFACTS
  - PlanPath "plan.json"
- PASS CONTINUE

## 2. Consume later
- ARTIFACTS
  - PlanPath
- PASS CONTINUE

## 3. Plain
- PASS COMPLETE
`);
        const machine = compileRunbookToMachine(steps, {
          templateVars: brandFlattenedTemplateVarsForTest({
            WorkPath: '.rundown/work',
            ContextId: 'ctx1',
            RunId: 'rd_a1d2a1d2a1d2a1d2a1d2a1d2a1d2a1d2',
            RunbookRef: { source: 'project', path: 'clear-entry.md' },
          }),
          evaluationOptions: { cwd },
        });
        const actor = createActor(machine);
        actor.start();
        const first = await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG), {
          timeout: 3000,
        });
        actor.send({ type: 'PASS' });
        await waitFor(
          actor,
          (snap) =>
            !snap.hasTag(PENDING_MACHINE_EFFECT_TAG) &&
            JSON.stringify(snap.value) === JSON.stringify({ 'step::2': 'idle' }),
          { timeout: 3000 },
        );
        actor.send({ type: 'PASS' });
        const plain = await waitFor(
          actor,
          (snap) =>
            !snap.hasTag(PENDING_MACHINE_EFFECT_TAG) &&
            JSON.stringify(snap.value) === JSON.stringify({ 'step::3': 'idle' }),
          { timeout: 3000 },
        );

        expect(plain.context.variables.PlanPath).toEqual(first.context.variables.PlanPath);
        expect(plain.context.enteredArtifacts).toBeUndefined();
        actor.stop();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('routes runtime GOTO to a parent substep through parent ARTIFACTS', async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'rundown-parent-artifacts-runtime-goto-'));
      try {
        const steps = createRunbook(`## 1. Start
- PASS CONTINUE

## 2. Parent
- ARTIFACTS
  - ParentPath "parent.json"
### 2.1 First
- PASS CONTINUE
### 2.2 Second
- PASS COMPLETE
`);
        const machine = compileRunbookToMachine(steps, {
          templateVars: brandFlattenedTemplateVarsForTest({
            WorkPath: '.rundown/work',
            ContextId: 'ctx1',
            RunId: 'rd_a1c2a1c2a1c2a1c2a1c2a1c2a1c2a1c2',
            RunbookRef: { source: 'project', path: 'runtime-goto.md' },
          }),
          evaluationOptions: { cwd },
        });
        const actor = createActor(machine);
        actor.start();
        actor.send({ type: 'GOTO', target: { step: '2', substep: '2' } });

        const snapshot = await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG), {
          timeout: 3000,
        });
        expect(snapshot.value).toEqual({ 'step::2::2': 'idle' });
        expect(snapshot.context.variables.ParentPath).toMatchObject({ key: 'parent.json' });
        actor.stop();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('stops through ARTIFACT_RESOLUTION_FAILED when resolver rejects', async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'rundown-artifacts-failure-'));
      try {
        const steps = createRunbook(`## 1. Consume missing artifact
- ARTIFACTS
  - Missing
- PASS COMPLETE
`);
        const machine = compileRunbookToMachine(steps, {
          templateVars: brandFlattenedTemplateVarsForTest({
            WorkPath: '.rundown/work',
            ContextId: 'ctx1',
            RunId: 'rd_33333333333333333333333333333333',
            RunbookRef: { source: 'project', path: 'missing.md' },
          }),
          evaluationOptions: { cwd },
        });
        const actor = createActor(machine);
        actor.start();

        const snapshot = await waitFor(actor, (snap) => snap.value === 'STOPPED', {
          timeout: 3000,
        });

        expect(snapshot.value).toBe('STOPPED');
        expect(snapshot.context.lifecycle).toBe('stopped');
        if (snapshot.context.lastAction?.type !== 'ARTIFACT_RESOLUTION_FAILED') {
          throw new Error('Expected ARTIFACT_RESOLUTION_FAILED last action');
        }
        expect(snapshot.context.lastAction.message).toMatch(/unbound/i);
        actor.stop();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('resolves naked ARTIFACTS again on RETRY re-entry using the latest variable context', async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'rundown-artifacts-retry-'));
      try {
        const runbook: RunbookRef = { source: 'project', path: 'retry.md' };
        const steps = createRunbook(`## 1. Retry plan
- ARTIFACTS
  - PlanPath
- PASS RETRY 1 COMPLETE
`);
        const firstUri = 'rd://artifacts/ctx1/rd_44444444444444444444444444444444/first.json';
        const secondUri = 'rd://artifacts/ctx1/rd_44444444444444444444444444444444/second.json';
        await appendArtifactManifestRecordForTest(cwd, firstUri, runbook);
        await appendArtifactManifestRecordForTest(cwd, secondUri, runbook);
        const machine = compileRunbookToMachine(steps, {
          templateVars: brandFlattenedTemplateVarsForTest({
            WorkPath: '.rundown/work',
            ContextId: 'ctx1',
            RunId: 'rd_44444444444444444444444444444444',
            RunbookRef: runbook,
            PlanPath: firstUri,
          }),
          evaluationOptions: { cwd },
        });
        const actor = createActor(machine);
        actor.start();
        const first = await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG), {
          timeout: 3000,
        });
        const firstArtifact = first.context.variables.PlanPath;
        expect(firstArtifact).toMatchObject({ key: 'first.json' });

        actor.send({ type: 'SET_VARIABLES', vars: { PlanPath: secondUri } });
        actor.send({ type: 'PASS' });
        const retried = await waitFor(
          actor,
          (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG) && snap.context.retryCount === 1,
          { timeout: 3000 },
        );

        expect(retried.value).toEqual({ 'step::1': 'idle' });
        expect(retried.context.variables.PlanPath).toMatchObject({ key: 'second.json' });
        expect(retried.context.variables.PlanPath).not.toEqual(firstArtifact);
        expect(retried.context.enteredArtifacts).toEqual({
          PlanPath: retried.context.variables.PlanPath,
        });
        actor.stop();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('re-runs parent ARTIFACTS on retry re-entry before reopening the child', async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'rundown-parent-artifacts-retry-'));
      try {
        const runbook: RunbookRef = { source: 'project', path: 'parent-retry.md' };
        const steps = createRunbook(`## 1. Parent
- ARTIFACTS
  - ParentPath
- PASS ANY RETRY 1 COMPLETE
- FAIL ALL STOP
### 1.1 Child
- PASS DEFER
- FAIL STOP
`);
        const firstUri =
          'rd://artifacts/ctx1/rd_45454545454545454545454545454545/parent-first.json';
        const secondUri =
          'rd://artifacts/ctx1/rd_45454545454545454545454545454545/parent-second.json';
        await appendArtifactManifestRecordForTest(cwd, firstUri, runbook);
        await appendArtifactManifestRecordForTest(cwd, secondUri, runbook);
        const machine = compileRunbookToMachine(steps, {
          templateVars: brandFlattenedTemplateVarsForTest({
            WorkPath: '.rundown/work',
            ContextId: 'ctx1',
            RunId: 'rd_45454545454545454545454545454545',
            RunbookRef: runbook,
            ParentPath: firstUri,
          }),
          evaluationOptions: { cwd },
        });
        const actor = createActor(machine);
        actor.start();
        const first = await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG), {
          timeout: 3000,
        });
        expect(first.context.variables.ParentPath).toMatchObject({ key: 'parent-first.json' });

        actor.send({ type: 'SET_VARIABLES', vars: { ParentPath: secondUri } });
        actor.send({ type: 'PASS' });
        const retried = await waitFor(
          actor,
          (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG) && snap.context.parentRetryCount === 1,
          { timeout: 3000 },
        );

        expect(retried.value).toEqual({ 'step::1::1': 'idle' });
        expect(retried.context.variables.ParentPath).toMatchObject({
          key: 'parent-second.json',
        });
        actor.stop();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('re-resolves parent ARTIFACTS on substep RETRY via __parent-entry routing', async () => {
      // Regression: substep RETRY (`PASS RETRY N ...`) used to target the
      // substep state directly, bypassing the parent's `__resolve-artifacts`
      // entry. Every other re-entry transition (PASS/FAIL/CONTINUE/NEXT/
      // BREAK/GOTO) routes through `routeThroughParentArtifactsIfNeeded`;
      // RETRY now does too, so parent ARTIFACTS re-resolve before the
      // substep re-enters.
      const cwd = await mkdtemp(path.join(tmpdir(), 'rundown-substep-retry-artifacts-'));
      try {
        const runbook: RunbookRef = { source: 'project', path: 'substep-retry.md' };
        const steps = createRunbook(`## 1. Parent
- ARTIFACTS
  - ParentPath
- PASS ALL COMPLETE
- FAIL ANY STOP
### 1.1 Child
- PASS RETRY 1 COMPLETE
- FAIL STOP
`);
        const firstUri =
          'rd://artifacts/ctx1/rd_46464646464646464646464646464646/parent-first.json';
        const secondUri =
          'rd://artifacts/ctx1/rd_46464646464646464646464646464646/parent-second.json';
        await appendArtifactManifestRecordForTest(cwd, firstUri, runbook);
        await appendArtifactManifestRecordForTest(cwd, secondUri, runbook);
        const machine = compileRunbookToMachine(steps, {
          templateVars: brandFlattenedTemplateVarsForTest({
            WorkPath: '.rundown/work',
            ContextId: 'ctx1',
            RunId: 'rd_46464646464646464646464646464646',
            RunbookRef: runbook,
            ParentPath: firstUri,
          }),
          evaluationOptions: { cwd },
        });
        const actor = createActor(machine);
        actor.start();
        const first = await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG), {
          timeout: 3000,
        });
        expect(first.context.variables.ParentPath).toMatchObject({ key: 'parent-first.json' });

        actor.send({ type: 'SET_VARIABLES', vars: { ParentPath: secondUri } });
        actor.send({ type: 'PASS' });
        const retried = await waitFor(
          actor,
          (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG) && snap.context.retryCount === 1,
          { timeout: 3000 },
        );

        expect(retried.value).toEqual({ 'step::1::1': 'idle' });
        expect(retried.context.variables.ParentPath).toMatchObject({
          key: 'parent-second.json',
        });
        expect(retried.context.variables.ParentPath).not.toMatchObject({
          key: 'parent-first.json',
        });
        actor.stop();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('all side-effect child states have terminal onError routes', () => {
      const steps = createRunbook(`## 1. Write
- ARTIFACTS
  - PlanPath "plan.json"
- PASS COMPLETE

\`\`\`bash
echo ok
\`\`\`
`);
      const machine = compileRunbookToMachine(steps);
      const states = getChildStatesForTest(asTestStateConfig(machine.config));

      for (const state of Object.values(states)) {
        for (const [childName, child] of Object.entries(getChildStatesForTest(state))) {
          if (childName === '__capture' || childName === '__resolve-artifacts') {
            expect(getTagsForTest(child)).toContain(PENDING_MACHINE_EFFECT_TAG);
            expect(transitionTargetForTest(getInvokeForTest(child).onError)).toBe('#STOPPED');
          }
        }
      }
    });

    it('generates no parent-entry states for an empty-substep parent with ARTIFACTS', () => {
      // Issue 13 edge: a step typed as parent (kind === 'substeps') with an
      // empty `substeps: []` and ARTIFACTS declarations must not emit any
      // `__parent-entry::*` sibling — there are no children to wrap.
      //
      // The parser does not produce this shape from author markdown today,
      // but the structural type `ResolvedStepWithSubsteps` permits it, and
      // the compiler MUST tolerate it without producing dangling states.
      // The for-loop in compiler.ts iterates `step.substeps` directly, so
      // empty arrays produce zero parent-entry inserts — that's the property
      // we lock in here.
      const steps = inferSteps([
        {
          name: '1',
          description: 'Empty parent',
          // `substeps: []` is admitted by the type; the runbook compiler
          // must NOT generate __parent-entry::* states for an empty list.
          substeps: [],
          artifacts: [{ name: 'ParentPath', rawToken: 'parent.json' }],
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
          aggregation: { strategy: 'ALL' as const },
        },
      ]);
      const machine = compileRunbookToMachine(steps);
      const states = getChildStatesForTest(asTestStateConfig(machine.config));

      for (const stateId of Object.keys(states)) {
        expect(stateId).not.toMatch(/::__parent-entry::/);
      }
    });
  });

  describe('OUTPUTS actions', () => {
    // Compiler-only actor tests intentionally assert structural placement of
    // storeStepOutputs. Naked step/substep OUTPUTS are file-backed channels:
    // values only enter context.variables when the executor prepares
    // RD_OUTPUTS_* files, runs the command, reads captured content, and sends
    // SET_VARIABLES.
    function getState(machine: ReturnType<typeof compileRunbookToMachine>, id: string): any {
      return (machine.config.states as Record<string, unknown>)[id] as any;
    }

    function getActionTypes(actions: unknown): string[] {
      const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
      return list.map((entry: { type: string }) => entry.type);
    }

    function asActionList(actions: unknown): readonly unknown[] {
      if (Array.isArray(actions)) return actions;
      return actions === undefined ? [] : [actions];
    }

    it('places storeFrontmatterOutputs on STOPPED.entry for direct-step FAIL terminal transitions', () => {
      const steps = createRunbook(`## 1. Produce
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - Result
`);

      const machine = compileRunbookToMachine(steps, {
        frontmatterOutputs: [{ name: 'Result' }],
      });

      // The step's FAIL transition still carries storeStepOutputs (step OUTPUTS
      // fire on the step's own exit) and setLastAction, but NOT
      // storeFrontmatterOutputs (single owner: terminal-entry).
      const failTransition = getState(machine, 'step::1').on.FAIL;
      expect(getActionTypes(failTransition.actions)).toEqual(
        expect.arrayContaining(['storeStepOutputs', 'setLastAction']),
      );
      expect(getActionTypes(failTransition.actions)).not.toContain('storeFrontmatterOutputs');

      // Single-owner terminal-entry architecture: storeFrontmatterOutputs is the
      // first action on STOPPED.entry.
      const stoppedEntry = getState(machine, 'STOPPED').entry as any[];
      expect(getActionTypes(stoppedEntry)[0]).toBe('storeFrontmatterOutputs');
    });

    it('stores STOPPED frontmatter outputs while naked step OUTPUTS do not synthesize values', () => {
      const steps = createRunbook(`## 1. Produce
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - Result
`);

      const machine = compileRunbookToMachine(steps, {
        frontmatterOutputs: [{ name: 'Result', value: '"failed-value"' }],
      });
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'FAIL' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      expect(snapshot.context.variables).not.toHaveProperty('Result');
      expect(snapshot.context.finalVars).toEqual({ Result: 'failed-value' });
    });

    it('does not fall back to process cwd for artifact OUTPUTS without evaluation options', async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'rd-compiler-no-eval-options-'));
      const previousCwd = process.cwd();
      process.chdir(cwd);
      try {
        const runId = 'rd_0123456789abcdef0123456789abcdef';
        const steps = createRunbook(`## 1. Produce
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - ArtifactPath
`);

        const machine = compileRunbookToMachine(steps, {
          templateVars: brandFlattenedTemplateVarsForTest({
            WorkPath: '.rundown/work',
            ContextId: 'ctx1',
            RunId: runId,
            RunbookRef: {
              source: 'plugin',
              path: 'planning/review/review-plan-risk-safety.runbook.md',
            },
          }),
        });
        const actor = createActor(machine);
        actor.start();
        actor.send({ type: 'PASS' });

        expect(actor.getSnapshot().context.variables).not.toHaveProperty('ArtifactPath');
        await expect(
          readArtifactManifest({ cwd, workPath: '.rundown/work' }, 'ctx1'),
        ).resolves.toEqual([]);
      } finally {
        process.chdir(previousCwd);
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('decorates parent-step exit transitions with storeStepOutputs only (not storeFrontmatterOutputs)', () => {
      const steps = createRunbook(`## 1. Parent
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - ParentVar

### 1.1 First
- PASS CONTINUE
- FAIL CONTINUE

### 1.2 Last
- PASS CONTINUE
- FAIL STOP

## 2. Done
- PASS COMPLETE
- FAIL STOP
`);

      const machine = compileRunbookToMachine(steps, {
        frontmatterOutputs: [{ name: 'ParentVar' }],
      });

      const parentAlways = getState(machine, 'step::1').always as any[];
      const continueExit = parentAlways.find((entry) => entry.target === 'step::2');
      // Two STOPPED entries coexist on the parent: the priority-0
      // RETRY_ERROR router (no actions) and the FAIL-path exit (carries
      // storeStepOutputs). Target the latter via the `actions` filter.
      const failTerminal = parentAlways.find(
        (entry) => entry.target === 'STOPPED' && entry.actions !== undefined,
      );

      // Parent exit transitions carry storeStepOutputs (not storeFrontmatterOutputs):
      expect(continueExit).toBeDefined();
      expect(getActionTypes(continueExit.actions)).toContain('storeStepOutputs');
      expect(getActionTypes(continueExit.actions)).not.toContain('storeFrontmatterOutputs');

      // The FAIL→STOPPED transition also carries storeStepOutputs (parent has outputs;
      // FAIL fires step OUTPUTS per spec) but NOT storeFrontmatterOutputs (single
      // owner is the terminal STOPPED.entry).
      expect(failTerminal).toBeDefined();
      expect(getActionTypes(failTerminal.actions)).toContain('storeStepOutputs');
      expect(getActionTypes(failTerminal.actions)).not.toContain('storeFrontmatterOutputs');
    });

    it('places storeFrontmatterOutputs as the first entry action on COMPLETE and STOPPED', () => {
      const steps = createRunbook(`## 1. Parent
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - ParentVar
`);

      const machine = compileRunbookToMachine(steps, {
        frontmatterOutputs: [{ name: 'ParentVar' }],
      });

      const completeEntry = getState(machine, 'COMPLETE').entry as any[];
      const stoppedEntry = getState(machine, 'STOPPED').entry as any[];

      // Single-owner terminal-entry architecture: storeFrontmatterOutputs is the
      // first action on both terminal states' entry, before the lifecycle marker
      // assign that writes completed/stopped flags.
      expect(getActionTypes(completeEntry)[0]).toBe('storeFrontmatterOutputs');
      expect(getActionTypes(stoppedEntry)[0]).toBe('storeFrontmatterOutputs');
    });

    it('routes forced terminal events through terminal entry without duplicating frontmatter output actions', () => {
      const steps = createRunbook(`## 1. Produce
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - Result
`);

      const machine = compileRunbookToMachine(steps, {
        frontmatterOutputs: [{ name: 'Result' }],
      });

      const rootOn = machine.config.on as Record<string, { target?: string; actions?: unknown }>;
      expect(rootOn.FORCE_COMPLETE.target).toBe('.COMPLETE');
      expect(rootOn.FORCE_STOP.target).toBe('.STOPPED');
      expect(getActionTypes(rootOn.FORCE_COMPLETE.actions)).not.toContain(
        'storeFrontmatterOutputs',
      );
      expect(getActionTypes(rootOn.FORCE_STOP.actions)).not.toContain('storeFrontmatterOutputs');

      const completeEntry = asActionList(getState(machine, 'COMPLETE').entry);
      const stoppedEntry = asActionList(getState(machine, 'STOPPED').entry);
      expect(getActionTypes(completeEntry)[0]).toBe('storeFrontmatterOutputs');
      expect(getActionTypes(stoppedEntry)[0]).toBe('storeFrontmatterOutputs');
      expect(
        getActionTypes(completeEntry).filter((type) => type === 'storeFrontmatterOutputs'),
      ).toHaveLength(1);
      expect(
        getActionTypes(stoppedEntry).filter((type) => type === 'storeFrontmatterOutputs'),
      ).toHaveLength(1);
    });

    it('does not decorate substep-internal always transitions with storeStepOutputs', () => {
      // Spec Testing §: "storeStepOutputs absent on substep-internal always transitions".
      const steps = createRunbook(`## 1. Parent
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - ParentVar

### 1.1 First
- PASS CONTINUE
- FAIL CONTINUE

### 1.2 Last
- PASS CONTINUE
- FAIL STOP

## 2. Done
- PASS COMPLETE
- FAIL STOP
`);

      const machine = compileRunbookToMachine(steps);
      const parentAlways = getState(machine, 'step::1').always as any[];
      const advanceToSecond = parentAlways.find((entry) => entry.target === 'step::1::2');

      expect(advanceToSecond).toBeDefined();
      expect(getActionTypes(advanceToSecond.actions)).not.toContain('storeStepOutputs');
    });

    it('does not fire storeStepOutputs on the substep BREAK exit transition', () => {
      // Spec Testing §: "FAIL→BREAK transition does NOT carry storeStepOutputs
      // (BREAK exits loop without advancing)". BREAK's parent-level cleanup
      // always-transition targets the parent state itself (self-loop), so it is
      // not a parent-exit and must not carry outputs. The eventual exit-to-next
      // transition IS a parent-exit and DOES carry outputs — that's the
      // parent-step completion, distinct from the BREAK signal itself.
      const steps = createRunbook(`## 1. Loop
- FOR i IN 1 TO 2
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - LoopVar

### 1.1 Inside
- PASS CONTINUE
- FAIL BREAK
`);

      const machine = compileRunbookToMachine(steps);
      const parentAlways = getState(machine, 'step::1').always as any[];
      // The BREAK cleanup transition is identified by its target == self-state
      // AND an assign that sets lastAction: { type: 'BREAK' }. Here we use the
      // simpler structural check: any always entry whose target is the parent
      // state itself must not carry storeStepOutputs.
      const selfTargeting = parentAlways.filter((entry) => entry.target === 'step::1');
      for (const entry of selfTargeting) {
        expect(getActionTypes(entry.actions)).not.toContain('storeStepOutputs');
      }

      // The substep's own FAIL transition (the BREAK signal itself) must also not
      // carry storeStepOutputs — BREAK routes back to the parent aggregation state
      // (exitsParent=false), so no parent output injection occurs there either.
      const substepFail = getState(machine, 'step::1::1').on.FAIL;
      expect(substepFail).toBeDefined();
      expect(getActionTypes(substepFail.actions)).not.toContain('storeStepOutputs');
    });

    it('carries storeStepOutputs on the substep FAIL→BREAK transition when the substep declares OUTPUTS', () => {
      // When the substep itself (not the parent) declares OUTPUTS, buildActionTransition
      // attaches storeStepOutputs regardless of action type — including BREAK.
      // The BREAK signal self-targets the parent state, so decorateParentTransition
      // never runs for substep-level outputs. storeStepOutputs is therefore placed
      // directly on the substep's FAIL transition by buildActionTransition.
      const steps = createRunbook(`## 1. Loop
- FOR i IN 1 TO 2
- PASS CONTINUE
- FAIL STOP

### 1.1 Inside
- PASS CONTINUE
- FAIL BREAK
- OUTPUTS
  - SubResult
`);

      const machine = compileRunbookToMachine(steps);
      const substepState = getState(machine, 'step::1::1');
      const failTransition = substepState.on?.FAIL;
      const failEntry = Array.isArray(failTransition) ? failTransition[0] : failTransition;
      expect(getActionTypes(failEntry?.actions)).toContain('storeStepOutputs');
    });

    it('does not synthesize naked substep OUTPUTS values after FAIL BREAK', () => {
      // Naked OUTPUTS are file-backed executor channels. The compiler still
      // attaches storeStepOutputs structurally, but there is no expression value
      // to evaluate in core-only actor tests.
      const steps = createRunbook(`## 1. Loop
- FOR i IN 1 TO 2
- PASS CONTINUE
- FAIL STOP

### 1.1 Inside
- PASS CONTINUE
- FAIL BREAK
- OUTPUTS
  - SubResult
`);

      const machine = compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest(),
      });
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'FAIL' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.context.variables).not.toHaveProperty('SubResult');
    });

    it('does not synthesize naked parent OUTPUTS values after BREAK without captured files', () => {
      // After BREAK the parent's always transitions evaluate and the parent-exit
      // transition carries storeStepOutputs for the parent's OUTPUTS (via
      // decorateParentTransition). Because these declarations are naked, the
      // compiler action does not synthesize values in core-only actor tests;
      // executor-captured RD_OUTPUTS_* files are the only runtime value source.
      // This is distinct from the structural test asserting that the self-targeting
      // BREAK transition does not carry storeStepOutputs.
      const steps = createRunbook(`## 1. Loop
- FOR i IN 1 TO 2
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - LoopResult
  - StepCursor
  - SubstepCursor
  - IterCursor
  - LoopCursor

### 1.1 Inside
- PASS CONTINUE
- FAIL BREAK
`);

      const machine = compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest(),
      });
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'FAIL' });

      const snapshot = actor.getSnapshot();
      for (const key of ['LoopResult', 'StepCursor', 'SubstepCursor', 'IterCursor', 'LoopCursor']) {
        expect(snapshot.context.variables).not.toHaveProperty(key);
      }
    });

    it('[P2] keeps naked parent OUTPUTS inert on completing last-substep cursor exit', () => {
      const steps = createRunbook(`## 1. Parent
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - StepCursor
  - SubstepCursor
  - AtCursor

### 1.1 First
- PASS CONTINUE
- FAIL STOP

### 1.2 Last
- PASS CONTINUE
- FAIL STOP

## 2. Done
- PASS COMPLETE
- FAIL STOP
`);

      const machine = compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest(),
      });
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });
      actor.send({ type: 'PASS' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
      for (const key of ['StepCursor', 'SubstepCursor', 'AtCursor']) {
        expect(snapshot.context.variables).not.toHaveProperty(key);
      }
    });

    it('[P2] keeps naked parent OUTPUTS inert on BREAK-origin substep cursor exit', () => {
      const steps = createRunbook(`## 1. Loop
- FOR i IN 1 TO 2
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - StepCursor
  - SubstepCursor

### 1.1 Breaker
- PASS CONTINUE
- FAIL BREAK

### 1.2 Skipped
- PASS CONTINUE
- FAIL CONTINUE
`);

      const machine = compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest(),
      });
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'FAIL' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
      for (const key of ['StepCursor', 'SubstepCursor']) {
        expect(snapshot.context.variables).not.toHaveProperty(key);
      }
    });

    it('keeps naked parent OUTPUTS inert against the completed FOR frame on BREAK exit', () => {
      const steps = createRunbook(`## 1. Loop
- FOR i IN 1 TO 3
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - StepCursor
  - SubstepCursor
  - AtCursor
  - IndexCursor
  - LoopValue

### 1.1 Breaker
- PASS CONTINUE
- FAIL BREAK

### 1.2 Skipped
- PASS CONTINUE
- FAIL CONTINUE
`);
      const machine = compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest(),
      });
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'FAIL' }); // substep 1.1, iteration 1, fires BREAK

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
      for (const key of ['StepCursor', 'SubstepCursor', 'AtCursor', 'IndexCursor', 'LoopValue']) {
        expect(snapshot.context.variables).not.toHaveProperty(key);
      }
    });

    it('keeps naked parent OUTPUTS inert against the completed FOR frame on NEXT-exhausted loop exit', () => {
      const steps = createRunbook(`## 1. Loop
- FOR i IN 1 TO 2
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - StepCursor
  - AtCursor
  - IndexCursor
  - LoopValue

### 1.1 Walker
- PASS NEXT
- FAIL STOP
`);
      const machine = compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest(),
      });
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' }); // iteration 1 → NEXT → loop-back
      actor.send({ type: 'PASS' }); // iteration 2 → NEXT → exhausted, exit

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
      for (const key of ['StepCursor', 'AtCursor', 'IndexCursor', 'LoopValue']) {
        expect(snapshot.context.variables).not.toHaveProperty(key);
      }
    });

    it('fires storeStepOutputs on the parent-exit transition of a FOR step', () => {
      // The parent-exit always transition (target === 'step::2') must carry
      // storeStepOutputs so executor-captured FOR outputs have a transition
      // point at parent exit. The loop-back transitions stay within the same
      // parent and are intentionally NOT decorated. This test is structural;
      // value capture is covered by CLI integration tests.
      const steps = createRunbook(`## 1. Loop
- FOR i IN 1 TO 2
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - Value

### 1.1 Inside
- PASS CONTINUE
- FAIL CONTINUE

## 2. Done
- PASS COMPLETE
- FAIL STOP
`);

      const machine = compileRunbookToMachine(steps);
      const parentAlways = getState(machine, 'step::1').always as any[];
      // The parent-exit transition (target === 'step::2') must carry outputs.
      const exitToNext = parentAlways.find((entry) => entry.target === 'step::2');
      expect(getActionTypes(exitToNext.actions)).toContain('storeStepOutputs');
    });

    it('does not synthesize FOR output values without executor channel capture', () => {
      // Naked OUTPUTS require executor-created channel files; the compiler
      // action alone does not derive values from the FOR frame.
      const steps = createRunbook(`## 1. Loop
- FOR i IN 1 TO 2
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - Value

### 1.1 Inside
- PASS CONTINUE
- FAIL CONTINUE
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      // Drive both iterations through PASS.
      actor.send({ type: 'PASS' });
      actor.send({ type: 'PASS' });

      const snapshot = actor.getSnapshot() as any;
      expect(snapshot.context.variables).not.toHaveProperty('Value');
    });

    it('injects storeStepOutputs for parent OUTPUTS on substep PASS COMPLETE transition (structural)', () => {
      // Bug: buildActionTransition only injects the substep's own storeStepOutputs.
      // When a substep fires COMPLETE/STOP directly, the parent aggregation state is
      // bypassed and decorateParentTransition never runs, so parent OUTPUTS are lost.
      // The substep's PASS transition must carry storeStepOutputs for the parent.
      const steps = createRunbook(`## 1. Parent
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - ParentVar

### 1.1 Only
- PASS COMPLETE
- FAIL STOP
`);

      const machine = compileRunbookToMachine(steps);

      const substepPassTransition = getState(machine, 'step::1::1').on.PASS;
      expect(getActionTypes(substepPassTransition.actions)).toContain('storeStepOutputs');
    });

    it('does not synthesize naked parent OUTPUTS when substep fires COMPLETE directly', () => {
      // Runtime counterpart: naked parent OUTPUTS still carry storeStepOutputs
      // structurally, but no value is produced without an executor-captured file.
      const steps = createRunbook(`## 1. Parent
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - ParentVar
  - StepCursor
  - SubstepCursor

### 1.1 Only
- PASS COMPLETE
- FAIL STOP
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
      for (const key of ['ParentVar', 'StepCursor', 'SubstepCursor']) {
        expect(snapshot.context.variables).not.toHaveProperty(key);
      }
    });

    it('does not synthesize naked parent OUTPUTS when substep fires STOP directly', () => {
      // Same as above but for FAIL STOP: the parent's OUTPUTS must fire even when
      // a substep routes directly to STOPPED without entering the parent state.
      const steps = createRunbook(`## 1. Parent
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - ParentVar
  - StepCursor
  - SubstepCursor

### 1.1 Only
- PASS CONTINUE
- FAIL STOP
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'FAIL' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      for (const key of ['ParentVar', 'StepCursor', 'SubstepCursor']) {
        expect(snapshot.context.variables).not.toHaveProperty(key);
      }
    });

    it('does not synthesize naked parent OUTPUTS when non-last substep fires COMPLETE directly', () => {
      // Substep 1.1 of a 3-substep parent fires COMPLETE, bypassing 1.2, 1.3, and
      // the parent aggregation state. exitsParent is position-agnostic — the check
      // only cares that the target is not the parent or a sibling substep.
      const steps = createRunbook(`## 1. Parent
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - ParentVar
  - StepCursor
  - SubstepCursor

### 1.1 First
- PASS COMPLETE
- FAIL STOP

### 1.2 Middle
- PASS CONTINUE
- FAIL CONTINUE

### 1.3 Last
- PASS CONTINUE
- FAIL CONTINUE
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
      for (const key of ['ParentVar', 'StepCursor', 'SubstepCursor']) {
        expect(snapshot.context.variables).not.toHaveProperty(key);
      }
    });

    it('does not synthesize naked parent OUTPUTS when non-last substep fires STOP directly', () => {
      const steps = createRunbook(`## 1. Parent
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - ParentVar
  - StepCursor
  - SubstepCursor

### 1.1 First
- PASS CONTINUE
- FAIL STOP

### 1.2 Last
- PASS CONTINUE
- FAIL CONTINUE
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'FAIL' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      for (const key of ['ParentVar', 'StepCursor', 'SubstepCursor']) {
        expect(snapshot.context.variables).not.toHaveProperty(key);
      }
    });

    it('does not synthesize naked parent OUTPUTS when substep fires GOTO to external step', () => {
      // When a substep GOTOs a different step, the parent aggregation state is also
      // bypassed. The exitsParent check applies equally to GOTO targets.
      const steps = createRunbook(`## 1. Parent
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - ParentVar
  - StepCursor
  - SubstepCursor

### 1.1 Only
- PASS GOTO 2
- FAIL STOP

## 2. Done
- PASS COMPLETE
- FAIL STOP
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });

      // After GOTO 2, machine is at step::2 — parent outputs already fired during transition.
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toEqual({ 'step::2': 'idle' });
      for (const key of ['ParentVar', 'StepCursor', 'SubstepCursor']) {
        expect(snapshot.context.variables).not.toHaveProperty(key);
      }
    });

    it('does not synthesize naked parent OUTPUTS when FOR loop substep fires COMPLETE directly', () => {
      // resolvedStepHasSubsteps returns true for FOR steps, so the exitsParent
      // guard applies equally — the FOR parent's outputs must fire.
      const steps = createRunbook(`## 1. Loop
- FOR i IN 1 TO 2
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - LoopVar
  - StepCursor
  - SubstepCursor
  - IterCursor
  - LoopCursor

### 1.1 Inside
- PASS COMPLETE
- FAIL STOP
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
      for (const key of ['LoopVar', 'StepCursor', 'SubstepCursor', 'IterCursor', 'LoopCursor']) {
        expect(snapshot.context.variables).not.toHaveProperty(key);
      }
    });

    it('does not synthesize naked parent OUTPUTS when FOR loop substep fires STOP directly', () => {
      const steps = createRunbook(`## 1. Loop
- FOR i IN 1 TO 2
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - LoopVar
  - StepCursor
  - SubstepCursor
  - IterCursor
  - LoopCursor

### 1.1 Inside
- PASS CONTINUE
- FAIL STOP
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'FAIL' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('STOPPED');
      for (const key of ['LoopVar', 'StepCursor', 'SubstepCursor', 'IterCursor', 'LoopCursor']) {
        expect(snapshot.context.variables).not.toHaveProperty(key);
      }
    });

    it('does not synthesize naked substep or parent OUTPUTS when both declare outputs', () => {
      // Both the substep and the parent declare naked OUTPUTS. The structural
      // storeStepOutputs actions still exist, but no expression values are produced.
      const steps = createRunbook(`## 1. Parent
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - ParentVar
  - StepCursor
  - SubstepCursor

### 1.1 Only
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - SubstepVar
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
      for (const key of ['ParentVar', 'StepCursor', 'SubstepCursor', 'SubstepVar']) {
        expect(snapshot.context.variables).not.toHaveProperty(key);
      }
    });

    it('keeps same-key naked substep and parent OUTPUTS inert without captured files', () => {
      // Parent fires after substep structurally, but neither naked declaration
      // has a value in core-only actor tests.
      const steps = createRunbook(`## 1. Parent
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - Result
  - StepCursor
  - SubstepCursor

### 1.1 Only
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - Result
`);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
      for (const key of ['Result', 'StepCursor', 'SubstepCursor']) {
        expect(snapshot.context.variables).not.toHaveProperty(key);
      }
    });

    it('keeps naked parent OUTPUTS inert on sibling-GOTO substep transition', () => {
      // When substep 1.1 GOTOs sibling substep 1.2, the target is 'step::1::2' which
      // starts with 'step::1::' — exitsParent=false. Parent outputs must NOT fire here;
      // they fire later when substep 1.2 actually exits the parent.
      const steps = createRunbook(`## 1. Parent
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - ParentVar
  - StepCursor
  - SubstepCursor

### 1.1 First
- PASS GOTO 1.2
- FAIL STOP

### 1.2 Last
- PASS COMPLETE
- FAIL STOP
`);

      const machine = compileRunbookToMachine(steps);

      // Structural: sibling-GOTO transition must not carry parent storeStepOutputs.
      const substepGotoTransition = getState(machine, 'step::1::1').on.PASS;
      expect(getActionTypes(substepGotoTransition.actions)).not.toContain('storeStepOutputs');

      // Structural/runtime cutoff: parent storeStepOutputs fires once via
      // substep 1.2's COMPLETE exit, but naked OUTPUTS do not synthesize values
      // without executor-captured files.
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'PASS' }); // substep 1.1 GOTOs 1.2
      actor.send({ type: 'PASS' }); // substep 1.2 fires COMPLETE

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
      for (const key of ['ParentVar', 'StepCursor', 'SubstepCursor']) {
        expect(snapshot.context.variables).not.toHaveProperty(key);
      }
    });
  });

  describe('parent-step unconditional-exit FAIL routing (Bug A)', () => {
    function getState(machine: ReturnType<typeof compileRunbookToMachine>, id: string): any {
      return (machine.config.states as Record<string, unknown>)[id] as any;
    }

    function getAssignPayload(actions: unknown): Record<string, unknown> {
      const arr = Array.isArray(actions) ? actions : [actions];
      for (const action of arr) {
        const a = action as { type?: string; assignment?: unknown };
        if (a.type === 'xstate.assign' && a.assignment && typeof a.assignment === 'object') {
          return a.assignment as Record<string, unknown>;
        }
      }
      throw new Error(`No assign payload found in actions: ${JSON.stringify(actions)}`);
    }

    it('emits a parent-level FAIL routing entry when parentStep.transitions.fail is STOP and there is no aggregation', () => {
      const steps = createRunbook(`## 1. Parent
- PASS CONTINUE
- FAIL STOP

### 1.1 First
- PASS CONTINUE
- FAIL CONTINUE

### 1.2 Last
- PASS CONTINUE
- FAIL CONTINUE

## 2. Done
- PASS COMPLETE
- FAIL STOP
`);

      const machine = compileRunbookToMachine(steps);
      const parentAlways = getState(machine, 'step::1').always as any[];

      const stoppedEntry = parentAlways.find((entry) => entry.target === 'STOPPED');
      const continueEntry = parentAlways.find((entry) => entry.target === 'step::2');

      expect(stoppedEntry).toBeDefined();
      expect(continueEntry).toBeDefined();

      // Critical anti-pattern check: both entries MUST have guards. If one
      // has a guard and the other does not, the unguarded one will fire first
      // and shadow the guarded one (XState evaluates `always` entries in order).
      expect(stoppedEntry.guard).toBeDefined();
      expect(continueEntry.guard).toBeDefined();
    });

    it('routes to STOPPED at runtime when any FOR iteration failed and parent has FAIL STOP (Case C)', () => {
      // Runtime counterpart to the structural test above. Iteration-level DEFER
      // accumulates a pass/fail verdict into iterationResults every iteration,
      // and a mix of verdicts must route the parent-exit to the parent's FAIL
      // target (STOPPED) — a predicate typo (`every` vs `some`) would still
      // pass the structural test but fail this one.
      const steps = inferSteps([
        {
          name: '1',
          description: 'FOR step',
          forClause: {
            start: 1,
            end: 2,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
            },
            aggregation: { strategy: 'ALL' as const },
          },
          // No step-level aggregation — forces the unconditional-exit branch.
          substeps: [
            {
              id: '1',
              description: 'Inside',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
          ],
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        },
        {
          name: '2',
          description: 'Done',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: substep FAIL → DEFER → iteration aggregation fails → iterationResults += 'fail'
      actor.send({ type: 'FAIL' });
      // Iteration 2: substep PASS → DEFER → iteration aggregation passes → iterationResults += 'pass'
      actor.send({ type: 'PASS' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.context.iterationResults).toEqual(['fail', 'pass']);
      expect(snapshot.value).toBe('STOPPED');
    });

    it('sets lastAction and lastMessage on Case C FOR PASS routing when parent PASS action is GOTO (Bug fix)', () => {
      // Case C: FOR without aggregation. When all iterations pass, the always
      // transition routes to the parent PASS target. Previously, lastAction and
      // lastMessage were NOT assigned in the PASS branch — only in the FAIL branch
      // — leaving stale substep action metadata when the parent PASS action is
      // anything other than CONTINUE (e.g. GOTO, COMPLETE, STOP).
      const steps = inferSteps([
        {
          name: '1',
          description: 'FOR step',
          forClause: {
            start: 1,
            end: 2,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
            },
          },
          // No step-level aggregation — forces Case C (unconditional-exit) branch.
          substeps: [
            {
              id: '1',
              description: 'Inside',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
          ],
          transitions: {
            pass: {
              kind: 'pass' as const,
              retry: 0,
              action: { type: 'GOTO' as const, target: { step: '3' } },
            },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        },
        {
          name: '2',
          description: 'Skipped',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        },
        {
          name: '3',
          description: 'GOTO target',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      // Iteration 1: substep PASS → DEFER → iterationResults += 'pass' → loop-back
      actor.send({ type: 'PASS' });
      // Iteration 2: substep PASS → DEFER → iterationResults += 'pass' → exits loop
      actor.send({ type: 'PASS' });

      // All iterations passed → parent PASS action (GOTO 3) fires → step::3
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toEqual({ 'step::3': 'idle' });
      // lastAction must reflect the GOTO target, not stale substep data
      expect(snapshot.context.lastAction).toEqual({ type: 'GOTO', target: '3' });
      expect(snapshot.context.lastMessage).toBeUndefined();
    });

    it('sets lastAction and lastMessage on Case C FOR PASS routing when parent PASS action is COMPLETE (Bug fix)', () => {
      // Verify the COMPLETE variant: passLastMessage must be propagated when present.
      const steps = inferSteps([
        {
          name: '1',
          description: 'FOR step',
          forClause: {
            start: 1,
            end: 1,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
            },
          },
          substeps: [
            {
              id: '1',
              description: 'Inside',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
              },
            },
          ],
          transitions: {
            pass: {
              kind: 'pass' as const,
              retry: 0,
              action: { type: 'COMPLETE' as const, message: 'all done' },
            },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'PASS' }); // single iteration passes → exits loop

      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe('COMPLETE');
      expect(snapshot.context.lastAction).toEqual({ type: 'COMPLETE' });
      expect(snapshot.context.lastMessage).toBe('all done');
    });

    it('records the parent declared PASS action on lastAction when the exit fires (not a forced CONTINUE)', () => {
      const steps = createRunbook(`## 1. Parent
- PASS COMPLETE
- FAIL STOP

### 1.1 First
- PASS CONTINUE
- FAIL CONTINUE

### 1.2 Last
- PASS CONTINUE
- FAIL CONTINUE
`);

      const machine = compileRunbookToMachine(steps);
      const parentAlways = getState(machine, 'step::1').always as any[];

      // Parent's declared PASS action is COMPLETE. The PASS-path exit entry
      // MUST record lastAction.type === 'COMPLETE', not CONTINUE.
      const completeEntry = parentAlways.find((entry) => entry.target === 'COMPLETE');
      expect(completeEntry).toBeDefined();

      const assignPayload = getAssignPayload(completeEntry.actions);
      expect(assignPayload.lastAction).toEqual({ type: 'COMPLETE' });
    });

    it('records the parent declared FAIL action on lastAction when the FAIL-path exit fires', () => {
      const steps = createRunbook(`## 1. Parent
- PASS CONTINUE
- FAIL STOP

### 1.1 First
- PASS CONTINUE
- FAIL CONTINUE

### 1.2 Last
- PASS CONTINUE
- FAIL CONTINUE
`);

      const machine = compileRunbookToMachine(steps);
      const parentAlways = getState(machine, 'step::1').always as any[];

      // Two STOPPED entries coexist on the parent: the priority-0
      // RETRY_ERROR router (no actions — lastAction is already the
      // RetryErrorLastAction variant, preserved verbatim) and the
      // FAIL-path exit entry (assigns `lastAction: { type: 'STOP' }`).
      // This test targets the latter.
      const stoppedEntry = parentAlways.find(
        (entry) => entry.target === 'STOPPED' && entry.actions !== undefined,
      );
      expect(stoppedEntry).toBeDefined();

      const assignPayload = getAssignPayload(stoppedEntry.actions);
      expect(assignPayload.lastAction).toEqual({ type: 'STOP' });
    });

    it('records the parent declared PASS action on lastAction for unconditional FOR exit (Case C)', () => {
      // Case C: FOR step, no parent-level aggregation, declared PASS COMPLETE.
      // Omitting `aggregation` from the parent step (while keeping it inside forClause
      // via DEFAULT_FOR_ITERATION) selects Case C in buildParentStateConfig.
      const steps = inferSteps([
        {
          name: '1',
          description: 'FOR parent, Case C — no aggregation',
          forClause: { start: 1, end: 1, ...DEFAULT_FOR_ITERATION },
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'COMPLETE' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
          substeps: [
            {
              id: '1',
              description: 'Iteration substep',
              transitions: DEFAULT_TRANSITIONS,
            },
          ],
        },
      ]);

      const machine = compileRunbookToMachine(steps);
      const parentAlways = getState(machine, 'step::1').always as any[];

      // Guards are now named in runbookSetup: entry.guard is a plain string at
      // runtime, enabling unambiguous discriminants without inspecting payload content.
      const passEntry = parentAlways.find((e: any) => e.guard === 'loopCompletedNormally');
      expect(passEntry).toBeDefined();
      const assignPayload = getAssignPayload(passEntry.actions);
      expect(assignPayload.lastAction).toEqual({ type: 'COMPLETE' });

      // BREAK/NEXT entry must NOT override lastAction — it preserves the iteration's own disposition.
      const breakEntry = parentAlways.find((e: any) => e.guard === 'loopExitedViaControl');
      expect(breakEntry).toBeDefined();
      const breakActions = (
        Array.isArray(breakEntry.actions) ? breakEntry.actions : [breakEntry.actions]
      ) as any[];
      expect(breakActions.some((a: any) => 'lastAction' in (a.assignment ?? {}))).toBe(false);
    });
  });

  describe('parent-aggregation retry with DELEGATE substeps', () => {
    /** Seed fresh delegations for the named substeps of step `1` (frameKey = buildFrameKey('1')). */
    function seedDelegations(
      steps: ResolvedStep[],
      substepIds: string[],
      childRunbookRefForSubstep: (substepId: string) => RunbookRef = (substepId) => ({
        source: 'project',
        path: `child-${substepId}.md`,
      }),
    ): readonly SubstepState[] {
      const frameKey = buildFrameKey('1');
      // Start from a minimal persistent state; createDelegation updates substepStates.
      let state: RunbookState = {
        id: brandRunIdForTest(`rd_${'a'.repeat(32)}`),
        runbook: { source: 'project', path: 'parent.md' },
        runbookPath: 'parent.md',
        step: '1',
        stepName: 'Parent',
        retryCount: 0,
        variables: brandStoredOutputsForTest({}),
        steps: [{ id: '1', status: 'running' }],
        startedAt: '2026-02-27T10:00:00.000Z',
        updatedAt: '2026-02-27T10:00:00.000Z',
        substepStates: substepIds.map((id) => ({ id, frameKey, status: 'pending' as const })),
        templateVars: brandInitialTemplateVarsForTest({}),
      };

      for (const substepId of substepIds) {
        const childRunbookRef = childRunbookRefForSubstep(substepId);
        const result = createDelegation(
          {
            state,
            stepId: `1.${substepId}`,
            childRunbookPath: childRunbookRef.path,
            childRunbookRef,
            ancestors: [],
            frameKey,
          },
          steps,
        );
        if (result.status !== 'created') {
          throw new Error(`Failed to seed delegation for substep ${substepId}: ${result.status}`);
        }
        state = { ...state, substepStates: result.updatedSubstepStates };
      }

      return state.substepStates ?? [];
    }

    /**
     * Build a 2-substep parent (DEFER/DEFER inside, ALL aggregation, FAIL retry:1) and
     * seed a snapshot where substep 1.1 result = `pass` and substep 1.2 result = `fail`
     * (or whatever `results` map specifies). Returns a started actor positioned at the
     * parent aggregation state, ready to trigger the retry branch on its next always step.
     */
    function buildRetryScenario(args: {
      results: Record<string, 'pass' | 'fail' | undefined>;
      seedIds: string[];
      trimSteps?: boolean;
      childRunbookRefForSubstep?: (substepId: string) => RunbookRef;
    }): { actor: ReturnType<typeof createActor>; frameKey: ReturnType<typeof buildFrameKey> } {
      const substepDefer = {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
      };
      const parentTransitions = {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
      };

      // Build parent with exactly the substeps we're seeding, so aggregation fires
      // after the final substep's result is recorded.
      const buildParent = (ids: string[]): ResolvedStep[] =>
        inferSteps([
          {
            name: '1',
            description: 'Parent with delegate substeps',
            transitions: parentTransitions,
            aggregation: { strategy: 'ALL' },
            substeps: ids.map((id): StepWithSubsteps['substeps'][number] => ({
              id,
              description: `Sub ${id}`,
              transitions: substepDefer,
            })),
          },
          { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
        ]);
      const fullSteps = buildParent(args.seedIds);

      // Seed delegations using the full step list — createDelegation validates
      // the substep exists in the step definitions.
      const seededStates = seedDelegations(fullSteps, args.seedIds, args.childRunbookRefForSubstep);

      // Apply result markers (pass/fail) to the seeded delegations per args.results.
      // Skip the active substep (the one the dispatched event is supposed to close
      // aggregation for): pre-marking it 'done' would mask any regression where
      // the live PASS/FAIL path stops persisting that outcome.
      const frameKey = buildFrameKey('1');
      const lastSeedSubstep = args.seedIds[args.seedIds.length - 1];
      const preparedSubsteps: SubstepState[] = seededStates.map((ss) => {
        const result = args.results[ss.id];
        if (result === undefined) return ss;
        if (ss.id === lastSeedSubstep && ss.frameKey === frameKey) return ss;
        return { ...ss, status: 'done' as const, result };
      });

      // If trimSteps: drop substep '1' from the compiled runbook so retryDelegation
      // fails validation (substep no longer exists in steps). The seeded state
      // retains the delegation on '1', guaranteeing we hit the error branch.
      const compileSteps: ResolvedStep[] = args.trimSteps
        ? buildParent(args.seedIds.filter((id) => id !== '1'))
        : fullSteps;

      const machine = compileRunbookToMachine(compileSteps);

      // Start at the last seeded substep so the aggregation fires on next event.
      // We use the snapshot/hydration pattern rather than stepping through PASS/FAIL
      // because we need substepStates + activeFrameKey mirrored into context before
      // the retry branch is evaluated.
      const tmp = createActor(machine);
      tmp.start();
      const baseSnap = tmp.getSnapshot();
      tmp.stop();

      // Drive to the last substep programmatically via deferredResults/substep mirror,
      // so the next FAIL triggers the parent aggregation and then the retry branch.
      const resultOrder = args.seedIds
        .map((id) => args.results[id])
        .filter((r): r is 'pass' | 'fail' => r !== undefined);
      const lastSubstep = args.seedIds[args.seedIds.length - 1];

      const persisted = {
        ...baseSnap,
        value: `step::1::${lastSubstep}`,
        context: {
          ...baseSnap.context,
          substepStates: preparedSubsteps,
          activeFrameKey: frameKey,
          substep: lastSubstep,
          // The aggregation guards inspect deferredResults. Pre-populate with
          // N-1 prior deferred outcomes so the final FAIL closes aggregation.
          deferredResults: resultOrder.slice(0, -1),
          substepCompletedCount: args.seedIds.length - 1,
        },
      };

      const actor = createActor(machine, { snapshot: persisted });
      actor.start();
      return { actor, frameKey };
    }

    it('populates delegateFrontier with every delegated substep (pass and fail alike)', () => {
      // Scenario: 1.1 pass (with delegation), 1.2 fail (with delegation).
      // Under uniform re-delegation (docs/spec/language.md §4.2, §5), BOTH substeps
      // re-issue on retry — the pass branch is not preserved.
      const { actor } = buildRetryScenario({
        seedIds: ['1', '2'],
        results: { '1': 'pass', '2': 'fail' },
      });

      // Capture the pre-retry tokenHashes for both substeps so we can assert
      // they are replaced with fresh tokens.
      const preCtx = actor.getSnapshot().context as RunbookContext;
      const preHash1 = preCtx.substepStates?.find((ss) => ss.id === '1')?.delegation?.tokenHash;
      const preHash2 = preCtx.substepStates?.find((ss) => ss.id === '2')?.delegation?.tokenHash;
      expect(preHash1).toBeDefined();
      expect(preHash2).toBeDefined();

      // Send the final FAIL for substep 1.2. This closes aggregation with [pass, fail],
      // ALL strategy fails, retry guard fires → runRetryHook runs.
      actor.send({ type: 'FAIL' });

      const ctx = actor.getSnapshot().context as RunbookContext;

      // Retry hook must have minted fresh tokens for BOTH substeps (uniform
      // re-delegation). Frontier has 2 entries, one per delegated substep.
      expect(ctx.delegateFrontier).toBeDefined();
      expect(ctx.delegateFrontier?.length).toBe(2);
      const frontierIds = ctx.delegateFrontier?.map((e) => e.id).sort();
      expect(frontierIds).toEqual(['1.1', '1.2']);

      // Each retried substep's state is reset: status pending, result cleared.
      const post1 = ctx.substepStates?.find((ss) => ss.id === '1');
      const post2 = ctx.substepStates?.find((ss) => ss.id === '2');
      expect(post1?.status).toBe('pending');
      expect(post1?.result).toBeUndefined();
      expect(post2?.status).toBe('pending');
      expect(post2?.result).toBeUndefined();

      // Each retried substep's delegation has a fresh tokenHash (different
      // from the seeded one). This is the "every prior token is unclaimable"
      // invariant from retry-semantics spec §3.1 at the state level.
      expect(post1?.delegation?.tokenHash).not.toBe(preHash1);
      expect(post2?.delegation?.tokenHash).not.toBe(preHash2);

      // lastAction is RETRY with aggregated: true (spec §3.5).
      expect(ctx.lastAction?.type).toBe('RETRY');
      expect(ctx.lastAction?.aggregated).toBe(true);

      // Counters incremented on success.
      expect(ctx.parentRetryCount).toBe(1);
      expect(ctx.retryCount).toBe(1);
      expect((ctx as { retryHookError?: unknown }).retryHookError).toBeUndefined();

      // Frame-entry invariant: the retry routing (parent-self re-enter +
      // always hop to firstSubstepStateId) must produce exactly one new
      // frame entry per successful retry, not two. At the substepStates
      // level this surfaces as: each (id, frameKey) pair remains a single
      // entry — updated in-place — not duplicated by the self-re-enter.
      //
      // Pre-retry: 2 substep states (ids '1','2' on the parent frameKey).
      // Post-retry: still exactly 2 substep states on the same frameKey.
      // A duplicated entry count (e.g. 4) would indicate the retry routing
      // appended a new SubstepState per hop instead of updating in place.
      const retriedFrameKey = buildFrameKey('1');
      const activeFrameSubsteps = (ctx.substepStates ?? []).filter(
        (ss) => ss.frameKey === retriedFrameKey,
      );
      expect(activeFrameSubsteps.length).toBe(2);
      const activeFrameIds = activeFrameSubsteps.map((ss) => ss.id).sort();
      expect(activeFrameIds).toEqual(['1', '2']);

      actor.stop();
    });

    it('preserves external child runbook refs when retry reissues delegated substeps', () => {
      const externalChildRef: RunbookRef = {
        source: 'external',
        path: '/tmp/external-child.runbook.md',
      };
      const { actor } = buildRetryScenario({
        seedIds: ['1'],
        results: { '1': 'fail' },
        childRunbookRefForSubstep: () => externalChildRef,
      });

      actor.send({ type: 'FAIL' });

      const ctx = actor.getSnapshot().context as RunbookContext;
      const post = ctx.substepStates?.find((ss) => ss.id === '1');
      expect(post?.delegation?.childRunbookRef).toEqual(externalChildRef);

      actor.stop();
    });

    it('clears delegateFrontier when the frontend consumes it', () => {
      const { actor } = buildRetryScenario({
        seedIds: ['1', '2'],
        results: { '1': 'pass', '2': 'fail' },
      });

      actor.send({ type: 'FAIL' });
      expect((actor.getSnapshot().context as RunbookContext).delegateFrontier).toBeDefined();

      actor.send({ type: 'DELEGATE_FRONTIER_CONSUMED' });

      expect((actor.getSnapshot().context as RunbookContext).delegateFrontier).toBeUndefined();

      actor.stop();
    });

    /**
     * Build a scenario where a `RETRY_ERROR` lastAction variant is seeded
     * directly into the actor's context before it is started.
     *
     * Triggering the hook error via the natural flow (making
     * `retryDelegation` return `{ status: 'error' }`) requires a step
     * topology that XState's state-ID parser cannot represent (substep ids
     * containing dots) or heavy module-level mocking. The always-entry
     * routing itself inspects `context.lastAction?.type === 'RETRY_ERROR'`;
     * seeding that variant exercises the transition under test directly.
     */
    function buildSeededRetryHookError(): ReturnType<typeof buildRetryScenario> {
      const frameKey = buildFrameKey('1');
      const substepDefer = {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
      };
      const parentTransitions = {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
      };

      const steps = inferSteps([
        {
          name: '1',
          description: 'Parent',
          transitions: parentTransitions,
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'Sub 1', transitions: substepDefer }],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const tmp = createActor(machine);
      tmp.start();
      const baseSnap = tmp.getSnapshot();
      tmp.stop();

      // Seed the actor at the parent aggregation state with a RETRY_ERROR
      // lastAction already populated. The always-entry should observe it on
      // start and immediately route to STOPPED.
      const persisted = {
        ...baseSnap,
        value: `step::1`,
        context: {
          ...baseSnap.context,
          activeFrameKey: frameKey,
          substep: undefined,
          lastAction: { type: 'RETRY_ERROR' as const, code: 'RD-902', message: 'hook failed' },
          parentRetryCount: 0,
          retryCount: 0,
          delegateFrontier: undefined,
        },
      };

      const actor = createActor(machine, { snapshot: persisted });
      actor.start();
      return { actor, frameKey };
    }

    it('seeded RETRY_ERROR lastAction routes to STOPPED with lifecycle=stopped and no retryHookError context field', () => {
      // Seeded routing test: when context.lastAction is a RETRY_ERROR variant
      // on actor start, the priority-0 always-entry on the parent state
      // routes the machine to STOPPED. The STOPPED entry action assigns
      // lifecycle='stopped'. Counters must remain at zero (retry never
      // actually taken) and the removed `retryHookError` context field must
      // not reappear.
      //
      // This test does NOT trigger createDelegation to fail; it verifies the
      // assign → always-guard → STOPPED chain given a pre-populated variant.
      // The only naturally-reachable RETRY_ERROR production path
      // (RD-902) is covered separately below.
      const { actor } = buildSeededRetryHookError();

      // Nudge the actor — XState v5 resolves always transitions on event
      // dispatch. Send a no-op event; the higher-priority always entry
      // should fire on re-evaluation.
      actor.send({ type: 'PASS' });

      const snap = actor.getSnapshot();
      const ctx = snap.context as RunbookContext;

      expect(snap.value).toBe('STOPPED');
      expect(ctx.lifecycle).toBe('stopped');
      expect(ctx.lastAction?.type).toBe('RETRY_ERROR');
      if (ctx.lastAction?.type === 'RETRY_ERROR') {
        expect(ctx.lastAction.code).toMatch(/^RD-/);
        expect(typeof ctx.lastAction.message).toBe('string');
      }
      // Counters untouched (retry never actually taken).
      expect(ctx.parentRetryCount).toBe(0);
      expect(ctx.retryCount).toBe(0);
      // Old context field no longer exists (migration from retryHookError to
      // the RetryErrorLastAction variant).
      expect((ctx as { retryHookError?: unknown }).retryHookError).toBeUndefined();

      actor.stop();
    });

    it('iteration-retry hook failure routes to STOPPED via RETRY_ERROR variant', () => {
      // Structural sibling of the parent-aggregation RETRY_ERROR test:
      // confirms the iteration-retry `assign` callback also writes the
      // RETRY_ERROR variant on hook failure, and the priority-0 always-entry
      // on the parent state routes to STOPPED. Seeds the lastAction variant
      // directly to avoid the FOR-loop mechanics of a natural-flow trigger —
      // the routing is independent of which assign callback set the variant.
      const frameKey = buildFrameKey('1');
      const substepDefer = {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
      };
      const parentTransitions = {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      };

      const steps = inferSteps([
        {
          name: '1',
          description: 'Parent',
          transitions: parentTransitions,
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'Sub 1', transitions: substepDefer }],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps);
      const tmp = createActor(machine);
      tmp.start();
      const baseSnap = tmp.getSnapshot();
      tmp.stop();

      // Seed context as-if the iteration-retry assign had just executed
      // with a hook error. iterationRetryCount stays at 0 (retry never
      // actually taken). retryHookError field does not exist.
      const persisted = {
        ...baseSnap,
        value: `step::1`,
        context: {
          ...baseSnap.context,
          activeFrameKey: frameKey,
          substep: undefined,
          lastAction: {
            type: 'RETRY_ERROR' as const,
            code: 'RD-902',
            message: 'iteration retry hook failed',
          },
          iterationRetryCount: 0,
          retryCount: 0,
          delegateFrontier: undefined,
        },
      };

      const actor = createActor(machine, { snapshot: persisted });
      actor.start();
      actor.send({ type: 'PASS' });

      const snap = actor.getSnapshot();
      const ctx = snap.context;

      expect(snap.value).toBe('STOPPED');
      expect(ctx.lifecycle).toBe('stopped');
      expect(ctx.lastAction?.type).toBe('RETRY_ERROR');
      if (ctx.lastAction?.type === 'RETRY_ERROR') {
        expect(ctx.lastAction.code).toBe('RD-902');
        expect(ctx.lastAction.message).toMatch(/iteration retry hook failed/);
      }
      expect(ctx.iterationRetryCount).toBe(0);
      expect(ctx.retryCount).toBe(0);

      actor.stop();
    });

    it('excludes substeps without delegation records (command/prompt substeps)', () => {
      // Mix scenario (uniform re-delegation per docs/spec/language.md §4.2, §5):
      //   1.1 pass + delegation (retried — prior pass does not exclude it)
      //   1.2 fail + no delegation (skipped — has no delegation to re-issue)
      //   1.3 fail + delegation (retried)
      // The hook is provenance- and result-agnostic; its inclusion criterion
      // is "has delegation record in active frame," not prior result.
      const frameKey = buildFrameKey('1');
      const substepDefer = {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
      };
      const parentTransitions = {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
      };
      const steps = inferSteps([
        {
          name: '1',
          description: 'Parent with mixed delegations',
          transitions: parentTransitions,
          aggregation: { strategy: 'ALL' },
          substeps: [
            { id: '1', description: 'Sub 1', transitions: substepDefer },
            { id: '2', description: 'Sub 2', transitions: substepDefer },
            { id: '3', description: 'Sub 3', transitions: substepDefer },
          ],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      // Seed delegations only on 1.1 and 1.3; 1.2 has no delegation.
      const seededStates = seedDelegations(steps, ['1', '3']);

      // Capture the original 1.1 SubstepState for tokenHash comparison after re-issuance.
      const originalSS1 = seededStates.find((ss) => ss.id === '1');
      expect(originalSS1?.delegation).toBeDefined();

      // Inject 1.2 manually without a delegation, and mark final results.
      const preparedSubsteps: SubstepState[] = [
        // 1.1: pass + delegation (IS re-issued under β uniform re-delegation).
        { ...originalSS1!, status: 'done' as const, result: 'pass' as const },
        // 1.2: fail but no delegation (skipped by hook)
        { id: '2', frameKey, status: 'done' as const, result: 'fail' as const },
        // 1.3: fail + delegation (retried)
        (() => {
          const ss = seededStates.find((s) => s.id === '3')!;
          return { ...ss, status: 'done' as const, result: 'fail' as const };
        })(),
      ];

      const machine = compileRunbookToMachine(steps);
      const tmp = createActor(machine);
      tmp.start();
      const baseSnap = tmp.getSnapshot();
      tmp.stop();

      const persisted = {
        ...baseSnap,
        value: `step::1::3`,
        context: {
          ...baseSnap.context,
          substepStates: preparedSubsteps,
          activeFrameKey: frameKey,
          substep: '3',
          deferredResults: ['pass', 'fail'] as ('pass' | 'fail')[],
          substepCompletedCount: 2,
        },
      };

      const actor = createActor(machine, { snapshot: persisted });
      actor.start();

      // Final FAIL closes the aggregation → ALL fails → retry fires → hook runs.
      actor.send({ type: 'FAIL' });

      const ctx = actor.getSnapshot().context;

      // Under uniform re-delegation (docs/spec/language.md §4.2, §5):
      //   1.1 (pass + delegation)    → RE-ISSUED (prior pass no longer excludes)
      //   1.2 (fail, no delegation)  → SKIPPED (no delegation to re-issue)
      //   1.3 (fail + delegation)    → RE-ISSUED
      // Frontier has 2 entries: ids 1.1 and 1.3.
      expect(ctx.delegateFrontier?.length).toBe(2);
      const frontierIds = ctx.delegateFrontier?.map((e) => e.id).sort();
      expect(frontierIds).toEqual(['1.1', '1.3']);

      // 1.1's delegation is replaced with a fresh token (not byte-equal).
      const post1 = ctx.substepStates?.find((ss) => ss.id === '1');
      expect(post1?.delegation?.tokenHash).not.toBe(originalSS1?.delegation?.tokenHash);
      // 1.1's substep state is reset (status pending, result cleared).
      expect(post1?.status).toBe('pending');
      expect(post1?.result).toBeUndefined();

      // 1.3's delegation must have a fresh tokenHash (different from seeded).
      const seed3Hash = seededStates.find((ss) => ss.id === '3')?.delegation?.tokenHash;
      const post3 = ctx.substepStates?.find((ss) => ss.id === '3');
      expect(post3?.delegation?.tokenHash).not.toBe(seed3Hash);
      expect(post3?.status).toBe('pending');
      expect(post3?.result).toBeUndefined();

      // 1.2 has no delegation — it's skipped by the hook. Its state is
      // preserved byte-for-byte from the prepared snapshot; the cursor-re-entry
      // machinery handles it separately. A regression that touched non-delegated
      // substeps would flip status or clear result here.
      const pre2 = preparedSubsteps.find((ss) => ss.id === '2');
      const post2 = ctx.substepStates?.find((ss) => ss.id === '2');
      expect(post2?.delegation).toBeUndefined();
      expect(post2?.status).toBe(pre2?.status);
      expect(post2?.result).toBe(pre2?.result);

      actor.stop();
    });
  });

  describe('FOR iteration retry with DELEGATE substeps', () => {
    /**
     * Seed a delegation for a single substep on a specific iteration frame of
     * a FOR step. Uses `createDelegation` directly so the SubstepState carries
     * a full DelegationRecord with tokenHash (required by retryDelegation).
     */
    function seedIterationDelegation(
      steps: ResolvedStep[],
      substepId: string,
      iteration: number,
      childRunbookRef: RunbookRef = {
        source: 'project',
        path: `child-${substepId}-iter${String(iteration)}.md`,
      },
    ): SubstepState {
      const frameKey = buildFrameKey('1', iteration);
      const baseState: RunbookState = {
        id: brandRunIdForTest(`rd_${'b'.repeat(32)}`),
        runbook: { source: 'project', path: 'parent.md' },
        runbookPath: 'parent.md',
        step: '1',
        stepName: 'Parent',
        retryCount: 0,
        variables: brandStoredOutputsForTest({}),
        steps: [{ id: '1', status: 'running' }],
        startedAt: '2026-02-27T10:00:00.000Z',
        updatedAt: '2026-02-27T10:00:00.000Z',
        substepStates: [{ id: substepId, frameKey, status: 'pending' as const }],
        templateVars: brandInitialTemplateVarsForTest({}),
      };

      const result = createDelegation(
        {
          state: baseState,
          stepId: `1.${substepId}`,
          childRunbookPath: childRunbookRef.path,
          childRunbookRef,
          ancestors: [],
          frameKey,
        },
        steps,
      );

      if (result.status !== 'created') {
        throw new Error(`Failed to seed delegation for ${substepId}@${frameKey}: ${result.status}`);
      }
      const ss = result.updatedSubstepStates.find(
        (s) => s.id === substepId && s.frameKey === frameKey,
      );
      if (!ss) throw new Error(`Failed to seed delegation for ${substepId}@${frameKey}`);
      return ss;
    }

    it('iteration retry populates delegateFrontier with the iteration-frame substep', () => {
      // FOR 1..2 with one DELEGATE substep, iteration FAIL ALL: RETRY 1 DEFER.
      // Seed iteration 1 frame with a failed-delegated substep; iteration 2 frame
      // also has a delegation but must NOT be touched by the hook.
      const substepDefer = {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
      };
      const steps = inferSteps([
        {
          name: '1',
          description: 'FOR with delegate substep',
          forClause: {
            start: 1,
            end: 2,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
              fail: { kind: 'fail' as const, retry: 1, action: { type: 'DEFER' as const } },
            },
            aggregation: { strategy: 'ALL' },
          },
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'Sub 1', transitions: substepDefer }],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const iter1FrameKey = buildFrameKey('1', 1);
      const iter2FrameKey = buildFrameKey('1', 2);
      const iter1ChildRef: RunbookRef = {
        source: 'external',
        path: '/tmp/external-iteration-child.runbook.md',
      };

      // Seed delegations on both iteration frames.
      const iter1Seeded = seedIterationDelegation(steps, '1', 1, iter1ChildRef);
      const iter2Seeded = seedIterationDelegation(steps, '1', 2);

      // Iteration 1: leave pending — the dispatched FAIL below is what closes
      // aggregation; pre-marking would mask any regression where the live PASS/FAIL
      // path stops persisting that outcome. Iteration 2: untouched, must remain byte-equal.
      const preparedSubsteps: SubstepState[] = [iter1Seeded, iter2Seeded];

      const machine = compileRunbookToMachine(steps);
      const tmp = createActor(machine);
      tmp.start();
      const baseSnap = tmp.getSnapshot();
      tmp.stop();

      // Drive the actor to iteration 1's substep-1 state with all iteration
      // machinery populated. The final FAIL closes the iteration's aggregation
      // and triggers the iteration-retry always entry.
      const persisted = {
        ...baseSnap,
        value: `step::1::1`,
        context: {
          ...baseSnap.context,
          substepStates: preparedSubsteps,
          activeFrameKey: iter1FrameKey,
          substep: '1',
          forStack: [
            {
              stepId: '1',
              iteration: 1,
              start: 1,
              end: 2,
              implicit: false,
              source: { kind: 'range' as const },
            },
          ],
          // Iteration aggregation has not yet received any results; the FAIL we
          // send below will be the single substep's result, closing ALL aggregation.
          deferredResults: [] as ('pass' | 'fail')[],
          substepCompletedCount: 0,
          iterationResults: [] as ('pass' | 'fail')[],
        },
      };

      const actor = createActor(machine, { snapshot: persisted });
      actor.start();

      // FAIL the single substep → deferredResults=[fail] → ALL aggregation fails →
      // iteration-retry guard fires → runRetryHook runs for iteration 1's frame.
      actor.send({ type: 'FAIL' });

      const ctx = actor.getSnapshot().context;

      // The retry hook minted exactly one fresh token for iteration 1's substep.
      // Frontier id is the canonical contextSnapshot.at (step.iteration.substep)
      // per commit 8ce42858; for iteration 1 of step 1, substep 1 → "1.1.1".
      expect(ctx.delegateFrontier).toBeDefined();
      expect(ctx.delegateFrontier?.length).toBe(1);
      expect(ctx.delegateFrontier?.[0]?.id).toBe('1.1.1');

      // Iteration 1's retried substep has its state reset: status pending,
      // prior result cleared (spec §3 step 3, §3.1 invariant).
      const postIter1 = ctx.substepStates?.find(
        (ss) => ss.id === '1' && ss.frameKey === iter1FrameKey,
      );
      expect(postIter1?.status).toBe('pending');
      expect(postIter1?.result).toBeUndefined();

      // lastAction is RETRY with aggregated: true (spec §3.5).
      expect(ctx.lastAction?.type).toBe('RETRY');
      expect(ctx.lastAction?.aggregated).toBe(true);

      // Iteration counters incremented on success.
      expect(ctx.iterationRetryCount).toBe(1);
      expect(ctx.retryCount).toBe(1);
      expect((ctx as { retryHookError?: unknown }).retryHookError).toBeUndefined();

      // Iteration 2's substep state must be byte-for-byte unchanged: same
      // delegation object with the original tokenHash and createdAt; status and
      // result preserved so a regression that resets non-target iteration frames
      // would fail this assertion.
      const post2 = ctx.substepStates?.find((ss) => ss.id === '1' && ss.frameKey === iter2FrameKey);
      expect(post2?.delegation?.tokenHash).toBe(iter2Seeded.delegation?.tokenHash);
      expect(post2?.delegation?.createdAt).toBe(iter2Seeded.delegation?.createdAt);
      expect(post2?.delegation?.cancelledAt).toBe(iter2Seeded.delegation?.cancelledAt);
      expect(post2?.status).toBe(iter2Seeded.status);
      expect(post2?.result).toBe(iter2Seeded.result);

      // Iteration 1's delegation must have a fresh tokenHash (different from seeded).
      const post1 = ctx.substepStates?.find((ss) => ss.id === '1' && ss.frameKey === iter1FrameKey);
      expect(post1?.delegation?.tokenHash).not.toBe(iter1Seeded.delegation?.tokenHash);
      expect(post1?.delegation?.childRunbookRef).toEqual(iter1ChildRef);

      actor.stop();
    });
  });

  describe('leafIssuesDelegations: GOTO into a non-first delegated substep', () => {
    it('routes through __issue-delegations and mints claims when GOTO targets a later delegated substep', async () => {
      const steps = inferSteps([
        {
          name: '1',
          description: 'Parent with mixed substeps',
          transitions: DEFAULT_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
          substeps: [
            { id: '1', description: 'Non-delegated', transitions: DEFAULT_TRANSITIONS },
            {
              id: '2',
              description: 'Delegated A',
              transitions: DEFAULT_TRANSITIONS,
              runbooks: ['child-a.runbook.md'],
              delegate: true,
            },
            {
              id: '3',
              description: 'Delegated B',
              transitions: DEFAULT_TRANSITIONS,
              runbooks: ['child-b.runbook.md'],
              delegate: true,
            },
          ],
        },
        { name: '2', description: 'Next', transitions: DEFAULT_TRANSITIONS },
      ]);

      const machine = compileRunbookToMachine(steps, {
        templateVars: brandFlattenedTemplateVarsForTest({
          RunId: brandRunIdForTest('rd_cccccccccccccccccccccccccccccccc'),
        }),
        resolveDelegationRunbook: async (runbookRef) => ({
          path: `/resolved/${runbookRef}`,
          runbookRef,
          childRunbookRef: { source: 'project' as const, path: `/canonical/${runbookRef}` },
        }),
      });
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'GOTO', target: { step: '1', substep: '3' } });

      await waitFor(actor, (snapshot) => {
        const states = snapshot.context.substepStates ?? [];
        return states.some((ss) => ss.id === '3' && ss.delegation !== undefined);
      });

      const ctx = actor.getSnapshot().context;
      const sub2 = ctx.substepStates?.find((ss) => ss.id === '2');
      const sub3 = ctx.substepStates?.find((ss) => ss.id === '3');

      expect(sub2?.delegation?.tokenHash).toBeDefined();
      expect(sub3?.delegation?.tokenHash).toBeDefined();
      expect(sub2?.delegation?.childRunbookPath).toBe('/resolved/child-a.runbook.md');
      expect(sub3?.delegation?.childRunbookPath).toBe('/resolved/child-b.runbook.md');

      actor.stop();
    });
  });
});
