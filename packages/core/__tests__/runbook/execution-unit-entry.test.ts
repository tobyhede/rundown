import { describe, expect, it } from '@jest/globals';
import type { ResolvedStep } from '@rundown-org/parser';
import { assertRunId } from '../../src/runbook/run-id.js';
import { deriveExecutionUnitEntry } from '../../src/runbook/execution-unit-entry.js';
import type { RunbookState } from '../../src/runbook/types.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { InvalidRunbookStateError } from '../../src/runbook/state.js';
import {
  brandInitialTemplateVarsForTest,
  brandStoredOutputsForTest,
} from '../../src/testing/effective-vars.js';

const runId = assertRunId(`rd_${'1'.repeat(32)}`);

/** Build a pass/fail transition pair for a step or substep. */
function tx() {
  return {
    pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
    fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
  } as const;
}

/**
 * A run positioned on one execution unit, with the two variables a frame renders
 * against.
 *
 * @param overrides - Fields the individual case is about.
 * @returns A `RunbookState` the entry seam can render.
 */
function state(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id: runId,
    runbook: { source: 'project', path: 'entry-test.md' },
    runbookPath: 'entry-test.md',
    step: '1',
    stepName: 'Entry test',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    templateVars: brandInitialTemplateVarsForTest({
      ContextId: 'ctx-entry',
      WorkPath: '.rundown/work',
    }),
    steps: [],
    lifecycle: 'running',
    startedAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    activeFrameKey: buildFrameKey('1'),
    activeEntry: 1,
    frameEntryCounts: { [buildFrameKey('1')]: 1 },
    substepStates: [],
    resolvedCompletions: {},
    schemaVersion: 1,
    frontmatterOutputs: [],
    ...overrides,
  };
}

/** Enter the unit a fixture run's cursor names. */
function enter(steps: ResolvedStep[], target: RunbookState = state()) {
  return deriveExecutionUnitEntry({ state: target, steps, cwd: '/project' });
}

/**
 * The single `STEP_ENTERED` payload an entry announces.
 *
 * @param entry - Result of {@link enter}.
 * @returns The payload, as a bag of fields.
 */
function payloadOf(entry: ReturnType<typeof enter>): Record<string, unknown> {
  expect(entry.effects).toHaveLength(1);
  const event = entry.effects[0].event;
  if (event.type !== 'STEP_ENTERED') throw new Error(`expected STEP_ENTERED, got ${event.type}`);
  return event.payload as unknown as Record<string, unknown>;
}

const commandStep: ResolvedStep = {
  kind: 'command',
  name: '1',
  description: 'Say hello to {{ who }}',
  command: { code: 'echo {{ who }}', lang: 'bash' },
  transitions: tx(),
} as unknown as ResolvedStep;

describe('deriveExecutionUnitEntry', () => {
  describe('classification', () => {
    it('classifies a command unit runnable and renders the command once, into both places it appears', () => {
      const entered = enter(
        [commandStep],
        state({
          templateVars: brandInitialTemplateVarsForTest({
            ContextId: 'ctx-entry',
            WorkPath: '.rundown/work',
            who: 'world',
          }),
        }),
      );

      expect(entered.kind).toBe('runnable');
      if (entered.kind !== 'runnable') throw new Error('unreachable');
      // The announced command and the executed command are the SAME expansion.
      // That is the property the one-value return delivers: a non-deterministic
      // `--helpers` helper cannot make them differ.
      expect(entered.command.code).toBe('echo world');
      expect(payloadOf(entered).commandCode).toBe('echo world');
      expect(payloadOf(entered).description).toBe('Say hello to world');
    });

    it('carries the rundown-injected environment on the runnable arm', () => {
      const entered = enter([commandStep]);

      if (entered.kind !== 'runnable') throw new Error('expected a runnable unit');
      expect(entered.command.rdInjected).toEqual({
        RD_WORK_PATH: '.rundown/work',
        RD_CONTEXT_ID: 'ctx-entry',
        RD_RUN_ID: runId,
        RD_RUNBOOK_REF: 'entry-test.md',
        RD_RUNBOOK_SOURCE: 'project',
      });
    });

    it('classifies a prompted run awaiting even though the unit carries a command', () => {
      const entered = enter([commandStep], state({ prompted: true }));

      expect(entered.kind).toBe('awaiting');
      // The unit still ANNOUNCES its command — a prompted operator needs to see
      // what they are being asked to run. `hasCommand` is the unit's property;
      // `awaiting` is this process's instruction.
      expect(payloadOf(entered)).toMatchObject({ hasCommand: true, prompted: true });
    });

    it('classifies a unit declaring no command awaiting, with hasCommand false', () => {
      const noCommand: ResolvedStep = {
        kind: 'base',
        name: '1',
        description: 'Nothing to run',
        transitions: tx(),
      } as unknown as ResolvedStep;

      const entered = enter([noCommand]);

      expect(entered.kind).toBe('awaiting');
      expect(payloadOf(entered).hasCommand).toBe(false);
    });

    it('derives hasCommand from the parsed unit, not from the rendered text', () => {
      // A command whose every token is an unresolved variable still renders to
      // SOMETHING, so this case does not distinguish the two derivations. The
      // one that does is a command that renders to the empty string.
      const emptyRender: ResolvedStep = {
        kind: 'command',
        name: '1',
        description: 'Runs an empty command',
        command: { code: '', lang: 'bash' },
        transitions: tx(),
      } as unknown as ResolvedStep;

      const entered = enter([emptyRender]);

      expect(payloadOf(entered).hasCommand).toBe(true);
      expect(entered.kind).toBe('runnable');
    });
  });

  describe('render failures', () => {
    it('refuses a run whose variables carry no ContextId as invalid persisted state', () => {
      const noContextId = state({
        templateVars: brandInitialTemplateVarsForTest({ WorkPath: '.rundown/work' }),
      });

      // Typed, not bare: the CLI maps `InvalidRunbookStateError` onto the
      // finish/stop/prune recovery path, and a run that cannot render its own
      // frame is corrupt persisted state by the no-migration rule.
      expect(() => enter([commandStep], noContextId)).toThrow(InvalidRunbookStateError);
      expect(() => enter([commandStep], noContextId)).toThrow(/missing ContextId/);
    });

    it('refuses a run whose variables carry no WorkPath as invalid persisted state', () => {
      const noWorkPath = state({
        templateVars: brandInitialTemplateVarsForTest({ ContextId: 'ctx-entry' }),
      });

      expect(() => enter([commandStep], noWorkPath)).toThrow(InvalidRunbookStateError);
      expect(() => enter([commandStep], noWorkPath)).toThrow(/missing WorkPath/);
    });

    it('refuses a cursor naming a step the parsed runbook does not define', () => {
      expect(() => enter([commandStep], state({ step: '9' }))).toThrow('Step "9" not found');
    });
  });

  // ---------------------------------------------------------------------------
  // #816 characterisation — the two divergences the CLI execution loop's builder
  // used to own, now pinned against the one seam that renders every entry.
  //
  // These moved here from `packages/cli/__tests__/services/execution-loop.test.ts`
  // when the loop stopped rendering (#819). They assert the SAME values on the
  // same fixtures; only the subject changed, from a mocked loop to the real
  // derivation. The end-to-end contrast against `rundown collect` lives in
  // `packages/cli/__tests__/integration/step-entered-divergence-characterisation.test.ts`.
  // ---------------------------------------------------------------------------
  describe('STEP_ENTERED entry metadata (#816 characterisation)', () => {
    it('composes prompted from the run flag OR the prompted-FOR step kind', () => {
      // A FOR step whose bounds did not resolve is demoted to `prompted-for`:
      // substeps, no iteration machinery, the original FOR text kept as the
      // step prompt.
      const promptedForSteps: ResolvedStep[] = [
        {
          kind: 'prompted-for',
          name: '1',
          description: 'Fan out over an unresolved source',
          prompt: 'FOR item IN {{ items }}',
          substeps: [{ id: '1', description: 'Handle one item', transitions: tx() }],
          transitions: tx(),
        } as unknown as ResolvedStep,
      ];

      // The run's persisted prompted flag, explicitly FALSE. Everything below is
      // about the second term.
      const entered = enter(promptedForSteps, state({ substep: '1', prompted: false }));

      expect(entered.kind).toBe('awaiting');
      // THE DIVERGENCE. This seam ORs `currentStep.kind === 'prompted-for'` into
      // the flag; core's collect-side builder reads `!!advanced.prompted` alone
      // and reports `false` for this same cursor on this same step.
      //
      // CORRECT VALUE: `true`. The payload field documents whether execution is
      // prompted rather than automatic, and a prompted-FOR step IS prompted —
      // the classification above turns on exactly this term. So the collect path
      // under-reports, and #820's move makes the composed value the one both
      // paths derive.
      expect(payloadOf(entered).prompted).toBe(true);
      // The substep carries no prompt of its own, so the step-level FOR text is
      // what the operator is shown.
      expect(payloadOf(entered).prompt).toBe('FOR item IN {{ items }}');
    });

    it('takes substepId from the raw cursor and isSubstep from the resolved unit', () => {
      // A cursor naming a substep the current step does not define.
      // `resolveCurrentExecutionUnit` falls back to the parent step for it, so
      // the two fields are derived from different sources and disagree.
      const substepSteps: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Fan out',
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'The only live substep', transitions: tx() }],
          transitions: tx(),
        } as unknown as ResolvedStep,
      ];

      const entered = enter(substepSteps, state({ substep: '9' }));
      const payload = payloadOf(entered);

      // THE DIVERGENCE, inside one builder rather than between two: `substepId`
      // comes straight off the raw cursor while `isSubstep` comes off the
      // resolved execution unit, so a cursor naming no live substep yields a
      // populated `substepId` alongside `isSubstep: false`. `substepId` never
      // reaches the payload, which is why the position is asserted instead — it
      // is the cursor's only observable trace.
      //
      // CORRECT VALUE: `substepId: undefined` with `isSubstep: false`. Both
      // describe the same question — is the unit being entered a substep? — so
      // both must come from the resolved unit. This matters beyond tidiness:
      // the frontier seams gate credential disclosure on `isSubstep`, and
      // `deriveStepEnteredEffect`'s cursor guard fires on `substepId`, so the
      // two fields answering differently splits one decision across two seams.
      expect(payload.position).toMatchObject({ current: '1', substep: '9' });
      expect(payload.isSubstep).toBe(false);
      // The name confirms the fallback landed on the parent step: the substep
      // arm would have used the substep's own id.
      expect(payload.stepName).toBe('1');
      expect(payload.description).toBe('Fan out');
    });
  });
});
