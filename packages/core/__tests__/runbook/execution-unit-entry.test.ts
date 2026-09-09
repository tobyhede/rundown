import { describe, expect, it } from '@jest/globals';
import { assertRunId } from '../../src/runbook/run-id.js';
import { deriveExecutionUnitEntry } from '../../src/runbook/execution-unit-entry.js';
import type { ResolvedStep, RunbookState } from '../../src/runbook/types.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { InvalidRunbookStateError } from '../../src/runbook/state.js';
import { WORK_DIR } from '../../src/paths.js';
import {
  brandEffectiveVarsForTest,
  brandInitialTemplateVarsForTest,
  brandStoredOutputsForTest,
} from '../../src/testing/effective-vars.js';
import {
  makeBaseStep,
  makeCommandStep,
  makeResolvedStepWithFor,
  makeResolvedStepWithPromptedFor,
  makeResolvedStepWithSubsteps,
  makeSubstep,
} from '../helpers/step-factories.js';

import { CURRENT_SCHEMA_VERSION } from '../../src/runbook/index.js';

const runId = assertRunId(`rd_${'1'.repeat(32)}`);
const CONTEXT_ID = 'ctx-entry';
const CWD = '/project';

/**
 * One open FOR iteration frame on the run's stack.
 *
 * @param frame - Variable, iteration and inclusive range for the open loop.
 * @returns A `ForContext` for `RunbookState.forStack`.
 */
function forFrame(frame: {
  variable: string;
  iteration: number;
  start: number;
  end: number;
}): NonNullable<RunbookState['forStack']>[number] {
  return {
    stepId: '1',
    iteration: frame.iteration,
    start: frame.start,
    end: frame.end,
    variable: frame.variable,
    implicit: false,
    source: { kind: 'range' },
  };
}

/** Template vars carrying the two required built-ins plus whatever a case needs. */
function vars(extra: Record<string, string> = {}) {
  return brandInitialTemplateVarsForTest({ ContextId: CONTEXT_ID, WorkPath: WORK_DIR, ...extra });
}

/**
 * A run positioned on one execution unit, seeded with the two variables every
 * frame renders against.
 *
 * @param overrides - Fields the individual case is about.
 * @returns A `RunbookState` the entry seam can render.
 */
function state(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    prompted: false,
    id: runId,
    runbook: { source: 'project', path: 'entry-test.md' },
    runbookPath: 'entry-test.md',
    step: '1',
    stepName: 'Entry test',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    templateVars: vars(),
    steps: [],
    lifecycle: 'running',
    startedAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    activeFrameKey: buildFrameKey('1'),
    activeEntry: 1,
    frameEntryCounts: { [buildFrameKey('1')]: 1 },
    substepStates: [],
    resolvedCompletions: {},
    schemaVersion: CURRENT_SCHEMA_VERSION,
    frontmatterOutputs: [],
    ...overrides,
  };
}

/** Enter the unit a fixture run's cursor names. */
function enter(steps: readonly ResolvedStep[], target: RunbookState = state()) {
  return deriveExecutionUnitEntry({ state: target, steps, cwd: CWD });
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

const commandStep = makeCommandStep({
  description: 'Say hello to {{ who }}',
  command: { code: 'echo {{ who }}', lang: 'bash' },
});

describe('deriveExecutionUnitEntry', () => {
  describe('classification', () => {
    it('classifies a command unit runnable and renders the command once, into both places it appears', () => {
      const entered = enter([commandStep], state({ templateVars: vars({ who: 'world' }) }));

      expect(entered.kind).toBe('runnable');
      if (entered.kind !== 'runnable') throw new Error('unreachable');
      // The announced command and the executed command are the SAME expansion.
      // That is the property the one-value return delivers: a non-deterministic
      // `--helpers` helper cannot make them differ.
      expect(entered.command.code).toBe('echo world');
      expect(payloadOf(entered).commandCode).toBe('echo world');
      expect(payloadOf(entered).description).toBe('Say hello to world');
      expect(payloadOf(entered).commandLang).toBe('bash');
    });

    it('shell-escapes the command expansion but not the description', () => {
      // Two expanders, one frame. `expandLoopVariablesForCommand` escapes every
      // substitution because the result reaches a shell; `expandLoopVariables`
      // must not, because the result reaches a reader. A mutant routing both
      // through one expander shows up here.
      const entered = enter(
        [makeCommandStep({ description: 'about {{ who }}', command: { code: 'echo {{ who }}' } })],
        state({ templateVars: vars({ who: 'a b; rm -rf /' }) }),
      );

      if (entered.kind !== 'runnable') throw new Error('expected a runnable unit');
      expect(entered.command.code).toBe("echo 'a b; rm -rf /'");
      expect(payloadOf(entered).description).toBe('about a b; rm -rf /');
    });

    it('carries the rundown-injected environment on the runnable arm', () => {
      const entered = enter([commandStep]);

      if (entered.kind !== 'runnable') throw new Error('expected a runnable unit');
      expect(entered.command.rdInjected).toEqual({
        RD_WORK_PATH: WORK_DIR,
        RD_CONTEXT_ID: CONTEXT_ID,
        RD_RUN_ID: runId,
        RD_RUNBOOK_REF: 'entry-test.md',
        RD_RUNBOOK_SOURCE: 'project',
      });
    });

    it('injects the run work path even when a FOR variable shadows the name in the frame', () => {
      // `RD_WORK_PATH` is the subprocess's work directory, not whatever the loop
      // happens to bind. The frame is `effectiveVars` plus the loop's bindings,
      // so reading the env off the frame would let `FOR WorkPath IN …` rename the
      // work directory for the child — and would disagree with the artifact paths
      // the same entry announces, which come from the render context.
      const entered = enter(
        [
          makeResolvedStepWithFor({
            forClause: { variable: 'WorkPath', start: 1, end: 3 },
            substeps: [makeSubstep({ id: '1', command: { code: 'echo hi' } })],
          }),
        ],
        state({
          substep: '1',
          forStack: [forFrame({ variable: 'WorkPath', iteration: 2, start: 1, end: 3 })],
        }),
      );

      if (entered.kind !== 'runnable') throw new Error('expected a runnable unit');
      expect(entered.command.rdInjected.RD_WORK_PATH).toBe(WORK_DIR);
    });

    it('classifies a prompted run awaiting even though the unit carries a command', () => {
      const entered = enter([commandStep], state({ prompted: true }));

      expect(entered.kind).toBe('awaiting');
      // The unit still ANNOUNCES its command — a prompted operator needs to see
      // what they are being asked to run. `hasCommand` is the unit's property;
      // `awaiting` is this process's instruction.
      expect(payloadOf(entered)).toMatchObject({ hasCommand: true, prompted: true });
      expect(payloadOf(entered).commandCode).toBe('echo {{ who }}');
    });

    it('classifies a unit declaring no command awaiting, with hasCommand false', () => {
      const entered = enter([makeBaseStep({ description: 'Nothing to run' })]);

      expect(entered.kind).toBe('awaiting');
      expect(payloadOf(entered).hasCommand).toBe(false);
      expect(payloadOf(entered).commandCode).toBeUndefined();
      expect(payloadOf(entered).commandLang).toBeUndefined();
    });

    it('derives hasCommand from the parsed unit, not from the rendered text', () => {
      // The case that distinguishes the two derivations: a command whose text
      // renders to the empty string still declares a command.
      const entered = enter([makeCommandStep({ command: { code: '', lang: 'bash' } })]);

      expect(payloadOf(entered).hasCommand).toBe(true);
      expect(entered.kind).toBe('runnable');
    });
  });

  describe('position input', () => {
    it('uses a caller-supplied position instead of deriving one (RD-827 finding 3)', () => {
      // Every caller with a position already in scope (the CLI execution loop
      // computes one via `countNumberedSteps` + `buildStepPosition` for its own
      // error-reporting events) hands it in rather than making this function
      // repeat that full-array scan for the identical value. `total: 999` could
      // never arise from `countNumberedSteps([commandStep])` (which is 1), so
      // the assertion below only passes if the supplied value rode through
      // without being recomputed.
      const suppliedPosition = { current: '1', total: 999 };

      const entered = deriveExecutionUnitEntry({
        state: state(),
        steps: [commandStep],
        cwd: CWD,
        position: suppliedPosition,
      });

      expect(payloadOf(entered).position).toEqual(suppliedPosition);
    });

    it('derives its own position when the caller supplies none', () => {
      const entered = enter([commandStep], state());

      expect(payloadOf(entered).position).toMatchObject({ current: '1', total: 1 });
    });
  });

  describe('the unit the cursor resolves to', () => {
    const parentWithSubsteps = makeResolvedStepWithSubsteps({
      description: 'Fan out',
      substeps: [
        makeSubstep({
          id: '1',
          description: 'Handle {{ who }}',
          prompt: 'Substep prompt',
          command: { code: 'echo sub-{{ who }}', lang: 'sh' },
        }),
      ],
    });

    it('renders the SUBSTEP when the cursor names a live one', () => {
      const entered = enter(
        [parentWithSubsteps],
        state({ substep: '1', templateVars: vars({ who: 'alice' }) }),
      );

      // Every field off the substep, not the parent: its id as the name, its own
      // description, prompt and command.
      expect(payloadOf(entered)).toMatchObject({
        stepName: '1',
        isSubstep: true,
        description: 'Handle alice',
        prompt: 'Substep prompt',
        hasCommand: true,
        commandCode: 'echo sub-alice',
        commandLang: 'sh',
      });
    });

    it('falls back to the parent STEP when the cursor names no live substep', () => {
      const entered = enter([parentWithSubsteps], state({ substep: '9' }));

      // The parent step's name and description, and none of the substep's
      // fields — a cursor naming nothing does not borrow from substep 1.
      expect(payloadOf(entered)).toMatchObject({
        stepName: '1',
        isSubstep: false,
        description: 'Fan out',
        hasCommand: false,
      });
      expect(payloadOf(entered).prompt).toBeUndefined();
    });

    it('takes a step-level command only from a command step', () => {
      // `kind: 'command'` is what carries `command` at step level. A substeps
      // step never does, so the parent-step arm must not reach for one.
      expect(payloadOf(enter([parentWithSubsteps])).hasCommand).toBe(false);
      expect(payloadOf(enter([commandStep])).hasCommand).toBe(true);
    });
  });

  describe('the FOR frame', () => {
    const forStep = makeResolvedStepWithFor({
      forClause: { variable: 'i', start: 4, end: 9 },
      substeps: [makeSubstep({ id: '1', description: 'iteration {{ i }} of {{ Index }}' })],
    });

    it('seeds the frame from the FOR clause when no iteration is open yet', () => {
      // `forClause` is passed ONLY for a `kind: 'for'` step. Without it the frame
      // carries no `Index` and no loop variable, so both placeholders survive
      // unresolved — which is exactly what the mutants on that ternary produce.
      const entered = enter([forStep], state({ substep: '1' }));

      expect(payloadOf(entered).description).toBe('iteration 4 of 4');
    });

    it('prefers the open iteration on the FOR stack over the clause start', () => {
      const entered = enter(
        [forStep],
        state({
          substep: '1',
          forStack: [forFrame({ variable: 'i', iteration: 7, start: 4, end: 9 })],
        }),
      );

      expect(payloadOf(entered).description).toBe('iteration 7 of 7');
    });

    it('does not seed a FOR frame for a non-FOR step that happens to have substeps', () => {
      const substepsStep = makeResolvedStepWithSubsteps({
        substeps: [makeSubstep({ id: '1', description: 'index is {{ Index }}' })],
      });

      const entered = enter([substepsStep], state({ substep: '1' }));

      expect(payloadOf(entered).description).toBe('index is {{ Index }}');
    });

    it('reports the raw cursor in position while naming the resolved unit', () => {
      const entered = enter([forStep], state({ substep: '1' }));

      // Position describes where the run IS; `stepName` / `isSubstep` describe
      // what it entered. Two separate questions.
      expect(payloadOf(entered).position).toMatchObject({ current: '1', substep: '1' });
    });
  });

  describe('prompt fallback', () => {
    it('uses the substep prompt when it has one, even on a prompted-FOR step', () => {
      const entered = enter(
        [
          makeResolvedStepWithPromptedFor({
            prompt: 'FOR item IN {{ items }}',
            substeps: [makeSubstep({ id: '1', prompt: 'The substep speaks for itself' })],
          }),
        ],
        state({ substep: '1' }),
      );

      expect(payloadOf(entered).prompt).toBe('The substep speaks for itself');
    });

    it('falls back to the step-level FOR text when the substep has no prompt', () => {
      const entered = enter(
        [
          makeResolvedStepWithPromptedFor({
            prompt: 'FOR item IN {{ items }}',
            substeps: [makeSubstep({ id: '1' })],
          }),
        ],
        state({ substep: '1' }),
      );

      expect(payloadOf(entered).prompt).toBe('FOR item IN {{ items }}');
    });

    it('renders no prompt for a substep with none, even when the STEP has one', () => {
      // The step-level fallback is reserved for a prompted FOR, whose prompt IS
      // the reconstructed loop text. An ordinary step's prompt belongs to the
      // step, so a substep with none must not inherit it.
      const entered = enter(
        [
          makeResolvedStepWithSubsteps({
            prompt: 'The parent step speaks',
            substeps: [makeSubstep({ id: '1' })],
          }),
        ],
        state({ substep: '1' }),
      );

      expect(payloadOf(entered).prompt).toBeUndefined();
    });

    it('renders no prompt for a substep with none on a step that is not a prompted FOR', () => {
      const entered = enter(
        [makeResolvedStepWithSubsteps({ substeps: [makeSubstep({ id: '1' })] })],
        state({ substep: '1' }),
      );

      expect(payloadOf(entered).prompt).toBeUndefined();
    });
  });

  describe('the helper render context', () => {
    it('renders artifact-path helpers at the RUNNABLE tier, so paths carry the run id', () => {
      // `{{ path "key" }}` resolves against the render context, and the run id
      // segment is contributed only by the `runnable` tier — the `prepared` tier
      // has no run to name. An entry is always a live run, so a context built at
      // the wrong tier would silently render every artifact path one segment
      // short, pointing at a directory the run does not own.
      const entered = enter([
        makeCommandStep({ description: 'plan lives at {{ path "plan.json" }}' }),
      ]);

      expect(payloadOf(entered).description).toContain(`${WORK_DIR}/.rd-${CONTEXT_ID}/${runId}/`);
      expect(payloadOf(entered).description).toContain('plan.json');
    });
  });

  describe('the snapshot the entry is observed against', () => {
    const artifact = {
      kind: 'artifact-record' as const,
      uri: `rd://artifacts/${CONTEXT_ID}/${runId}/plan.md`,
      runId,
      contextId: CONTEXT_ID,
      runbook: { source: 'project' as const, path: 'entry-test.md' },
      key: 'plan.md',
      timestamp: '2026-08-19T00:00:00.000Z',
    };

    it('projects entered artifacts under the run work path', () => {
      const entered = enter(
        [commandStep],
        state({ snapshot: { context: { enteredArtifacts: { PlanPath: artifact } } } }),
      );

      const artifacts = payloadOf(entered).artifacts as Record<string, { path: string }>;
      // Rooted at the SAME work directory the helper context renders against:
      // one read of `WorkPath`, not two.
      expect(artifacts.PlanPath.path).toContain(`${WORK_DIR}/.rd-${CONTEXT_ID}/${runId}/plan.md`);
      expect(artifacts.PlanPath.path).toContain(CWD);
    });

    it('enters a run whose persisted snapshot is not an object at all', () => {
      // `RunbookState.snapshot` is `unknown`. A non-object there is corrupt, but
      // it is not the entry's business to refuse it — the freshness guard on the
      // service seam owns that call. Reading it must simply yield no context
      // rather than throw on a property access.
      const entered = enter([commandStep], state({ snapshot: 'not-an-object' }));

      expect(payloadOf(entered)).toMatchObject({ stepName: '1', artifacts: {} });
    });

    it('enters a run whose persisted snapshot carries no context', () => {
      const entered = enter([commandStep], state({ snapshot: { value: 'step::1' } }));

      expect(payloadOf(entered)).toMatchObject({ stepName: '1', artifacts: {} });
    });

    it('enters a run whose persisted context is not an object', () => {
      // The guard is on the value actually read. Handing a string onward would
      // reach `'enteredArtifacts' in candidate`, and `in` against a primitive
      // throws — so this is a refusal-to-read, not a nicety.
      const entered = enter([commandStep], state({ snapshot: { context: 'oops' } }));

      expect(payloadOf(entered)).toMatchObject({ stepName: '1', artifacts: {} });
    });

    it('enters a run whose persisted context is null', () => {
      const entered = enter([commandStep], state({ snapshot: { context: null } }));

      expect(payloadOf(entered)).toMatchObject({ stepName: '1', artifacts: {} });
    });

    it('enters a run that has never synced a snapshot', () => {
      // The no-snapshot fallback still has to name the cursor, because the
      // observation reads `context.step` back off it.
      const entered = enter([commandStep], state({ snapshot: undefined }));

      expect(payloadOf(entered)).toMatchObject({ stepName: '1', artifacts: {} });
    });

    it('names the unit from the run columns, never from the snapshot blob', () => {
      // The structured columns are the authority on where the run is; the blob
      // may lag. A snapshot naming a different step must not win, or the entry
      // would describe a unit the run has left.
      const entered = enter(
        [commandStep],
        state({ snapshot: { context: { step: 'stale', enteredArtifacts: {} } } }),
      );

      expect(payloadOf(entered).stepName).toBe('1');
    });
  });

  describe('inline launch', () => {
    const inlineSteps = [
      makeResolvedStepWithSubsteps({
        substeps: [makeSubstep({ id: '1', description: 'Inline child' })],
      }),
    ];
    const frameKey = buildFrameKey('1');

    /** A persisted intent naming this run's step 1 / substep 1 at the active frame. */
    function intent(overrides: Record<string, unknown> = {}) {
      return {
        parentRunId: runId,
        parentStepId: '1',
        parentStep: '1',
        parentFrameKey: frameKey,
        childRunId: assertRunId(`rd_${'2'.repeat(32)}`),
        childRunbookPath: 'child.runbook.md',
        childRunbookRef: { source: 'project', path: 'child.runbook.md' },
        contextSnapshot: {
          vars: brandEffectiveVarsForTest({}),
          ancestors: [],
          step: '1',
          substep: '1',
          at: '1.1',
        },
        ...overrides,
      };
    }

    /** Enter substep 1 with the given persisted inline-launch intent. */
    function enterWithIntent(inlineLaunchIntent: unknown, overrides: Partial<RunbookState> = {}) {
      return enter(
        inlineSteps,
        state({ substep: '1', snapshot: { context: { inlineLaunchIntent } }, ...overrides }),
      );
    }

    it('classifies inline-launch and carries the intent with its parent entry', () => {
      const entered = enterWithIntent(intent());

      expect(entered.kind).toBe('inline-launch');
      if (entered.kind !== 'inline-launch') throw new Error('unreachable');
      expect(entered.launch).toMatchObject({
        parentStepId: '1',
        parentFrameKey: frameKey,
        // Stamped from the run's own frame counter, not from the intent — the
        // intent is written before the entry it belongs to is observed.
        parentEntry: 1,
      });
      expect(payloadOf(entered).inlineLaunch).toMatchObject({ parentEntry: 1 });
    });

    it('ignores a persisted value that is not a launch intent', () => {
      const entered = enterWithIntent({ nonsense: true });

      expect(entered.kind).toBe('awaiting');
      expect(payloadOf(entered).inlineLaunch).toBeUndefined();
    });

    it('ignores an intent naming another run', () => {
      expect(
        enterWithIntent(intent({ parentRunId: assertRunId(`rd_${'9'.repeat(32)}`) })).kind,
      ).toBe('awaiting');
    });

    it('ignores an intent naming another step', () => {
      expect(enterWithIntent(intent({ parentStep: '2' })).kind).toBe('awaiting');
    });

    it('ignores an intent naming another substep', () => {
      expect(enterWithIntent(intent({ parentStepId: '2' })).kind).toBe('awaiting');
    });

    it('ignores an intent whose authored frame is no longer open', () => {
      // Openness flows from the frame stack, never from the monotonic entry
      // counter — whose keys persist after a loop advances, and would otherwise
      // re-project a stale prior-iteration intent onto the current frame.
      const entered = enterWithIntent(intent({ parentFrameKey: buildFrameKey('1', 4) }), {
        activeFrameKey: frameKey,
        frameEntryCounts: { [buildFrameKey('1')]: 1, [buildFrameKey('1', 4)]: 3 },
      });

      expect(entered.kind).toBe('awaiting');
    });

    it('does not project an intent onto a cursor that resolves to the parent step', () => {
      // `substepId` and `isSubstep` both come off the resolved unit, so a cursor
      // naming no live substep is not the substep the intent addresses.
      const entered = enter(
        inlineSteps,
        state({ substep: '9', snapshot: { context: { inlineLaunchIntent: intent() } } }),
      );

      expect(entered.kind).toBe('awaiting');
    });
  });

  describe('delegation bearers', () => {
    const frontier = [{ id: '1.1', runbook: 'child.md', token: 'rdtk_example' }];

    it('discloses the supplied bearers on the entry payload', () => {
      const entered = deriveExecutionUnitEntry({
        state: state(),
        steps: [commandStep],
        delegateFrontier: frontier,
        cwd: CWD,
      });

      expect(payloadOf(entered).delegateFrontier).toEqual(frontier);
    });

    it('carries no frontier on an ordinary entry', () => {
      expect(payloadOf(enter([commandStep])).delegateFrontier).toBeUndefined();
    });
  });

  describe('render failures', () => {
    it('refuses a run whose variables carry no ContextId as invalid persisted state', () => {
      const noContextId = state({
        templateVars: brandInitialTemplateVarsForTest({ WorkPath: WORK_DIR }),
      });

      // Typed, not bare: the CLI maps `InvalidRunbookStateError` onto the
      // finish/stop/prune recovery path, and a run that cannot render its own
      // frame is corrupt persisted state by the no-migration rule.
      expect(() => enter([commandStep], noContextId)).toThrow(InvalidRunbookStateError);
      expect(() => enter([commandStep], noContextId)).toThrow(/missing ContextId/);
    });

    it('refuses a run whose variables carry no WorkPath as invalid persisted state', () => {
      const noWorkPath = state({
        templateVars: brandInitialTemplateVarsForTest({ ContextId: CONTEXT_ID }),
      });

      expect(() => enter([commandStep], noWorkPath)).toThrow(InvalidRunbookStateError);
      expect(() => enter([commandStep], noWorkPath)).toThrow(/missing WorkPath/);
    });

    it('names the run in the refusal defect, not only in the prose', () => {
      const noWorkPath = state({
        templateVars: brandInitialTemplateVarsForTest({ ContextId: CONTEXT_ID }),
      });

      try {
        enter([commandStep], noWorkPath);
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidRunbookStateError);
        expect((error as InvalidRunbookStateError).defect).toEqual({
          runId,
          reason: 'missing_render_context',
        });
      }
    });

    it('refuses a cursor naming a step the parsed runbook does not define', () => {
      // Same class as the two render refusals above, and for the same reason: a
      // cursor that has diverged from the compiled steps is corrupt persisted
      // state, whose recovery is prune or restart. A bare `Error` here would
      // lose that typed recovery at the progression boundary.
      expect(() => enter([commandStep], state({ step: '9' }))).toThrow(InvalidRunbookStateError);
      expect(() => enter([commandStep], state({ step: '9' }))).toThrow('Step "9" not found');

      try {
        enter([commandStep], state({ step: '9' }));
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as InvalidRunbookStateError).defect).toEqual({
          runId,
          reason: 'cursor_step_not_in_runbook',
        });
      }
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
  // `packages/cli/__tests__/integration/step-entered-run-collect-agreement.test.ts`.
  // ---------------------------------------------------------------------------
  describe('STEP_ENTERED entry metadata (#816 characterisation)', () => {
    it('composes prompted from the run flag OR the prompted-FOR step kind', () => {
      // A FOR step whose bounds did not resolve is demoted to `prompted-for`:
      // substeps, no iteration machinery, the original FOR text kept as the
      // step prompt.
      const promptedForSteps = [
        makeResolvedStepWithPromptedFor({
          description: 'Fan out over an unresolved source',
          prompt: 'FOR item IN {{ items }}',
          substeps: [makeSubstep({ id: '1', description: 'Handle one item' })],
        }),
      ];

      // The run's persisted prompted flag, explicitly FALSE. Everything below is
      // about the second term.
      const entered = enter(promptedForSteps, state({ substep: '1', prompted: false }));

      expect(entered.kind).toBe('awaiting');
      // THE DIVERGENCE. This seam ORs `currentStep.kind === 'prompted-for'` into
      // the flag; core's collect-side builder read `!!advanced.prompted` alone
      // and reported `false` for this same cursor on this same step.
      //
      // CORRECT VALUE: `true`. The payload field documents whether execution is
      // prompted rather than automatic, and a prompted-FOR step IS prompted —
      // the classification above turns on exactly this term.
      expect(payloadOf(entered).prompted).toBe(true);
    });

    it('reports prompted false for a non-prompted run on an ordinary step', () => {
      // The other half of the OR, so neither term can be dropped unnoticed.
      expect(payloadOf(enter([commandStep])).prompted).toBe(false);
    });

    it('derives substepId and isSubstep from the same resolved unit', () => {
      // A cursor naming a substep the current step does not define.
      // `resolveCurrentExecutionUnit` falls back to the parent step for it, so
      // the two fields used to be derived from different sources and disagree:
      // `substepId` came straight off the raw cursor while `isSubstep` came off
      // the resolved unit, yielding a populated `substepId` alongside
      // `isSubstep: false`.
      //
      // `substepId` never reaches the payload, so the observable trace is the
      // pair below: position still reports the raw cursor, while the unit fields
      // report the step the cursor actually resolved to.
      const substepSteps = [
        makeResolvedStepWithSubsteps({
          description: 'Fan out',
          substeps: [makeSubstep({ id: '1', description: 'The only live substep' })],
        }),
      ];

      const payload = payloadOf(enter(substepSteps, state({ substep: '9' })));

      expect(payload.position).toMatchObject({ current: '1', substep: '9' });
      expect(payload.isSubstep).toBe(false);
      expect(payload.stepName).toBe('1');
      expect(payload.description).toBe('Fan out');
    });
  });
});
