import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { ResolvedStep, RunbookState, Transitions } from '../../src/runbook/types.js';
import {
  brandInitialTemplateVarsForTest,
  brandStoredOutputsForTest,
} from '../helpers/effective-vars.js';

/**
 * Default `Transitions` for fixture steps.
 *
 * `Transitions` is required on every variant of `ResolvedStep` (via
 * `ExecutionUnitFields`). The delegation primitives under test do not
 * read this field, so a minimal CONTINUE/CONTINUE pair is used to
 * satisfy the type without imposing fixture-side branching logic.
 */
export const DEFAULT_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
};

/**
 * Minimal step shape consumed by delegation primitives in tests.
 *
 * The delegation primitives read only `name`, `kind`, and (for
 * substeps/for/prompted-for variants) `substeps[].id` and `forClause.kind`.
 * `transitions` is required by the structural `ResolvedStep` shape so it
 * is filled with a default CONTINUE pair (see {@link DEFAULT_TRANSITIONS}).
 *
 * Replaces a prior `as unknown as readonly Step[]` double-cast which
 * hid schema drift (and silently admitted the `'prompted-for'` kind that
 * `Step` does not include — only `ResolvedStep` does).
 *
 * Each fixture casts a `TestStep[]` to `readonly ResolvedStep[]` at the
 * boundary; the cast is a structurally honest single widening (TestStep
 * carries every field `ResolvedStep` declares as required, including
 * `transitions`), not the previous `unknown` round-trip.
 */
type TestStep =
  | {
      readonly kind: 'base';
      readonly name: string;
      readonly description: string;
      readonly transitions: Transitions;
    }
  | {
      readonly kind: 'substeps';
      readonly name: string;
      readonly description: string;
      readonly transitions: Transitions;
      readonly substeps: ReadonlyArray<{
        readonly id: string;
        readonly description: string;
        readonly transitions: Transitions;
      }>;
    }
  | {
      readonly kind: 'for';
      readonly name: string;
      readonly description: string;
      readonly transitions: Transitions;
      readonly forClause: {
        readonly kind?: 'range';
        readonly variable: string;
        readonly start: number;
        readonly end: number;
      };
      readonly substeps: ReadonlyArray<{
        readonly id: string;
        readonly description: string;
        readonly transitions: Transitions;
      }>;
    }
  | {
      readonly kind: 'prompted-for';
      readonly name: string;
      readonly description: string;
      readonly transitions: Transitions;
      readonly substeps: ReadonlyArray<{
        readonly id: string;
        readonly description: string;
        readonly transitions: Transitions;
      }>;
    };

/** Build a fixture substep with the default transitions. */
function makeTestSubstep(id: string): {
  readonly id: string;
  readonly description: string;
  readonly transitions: Transitions;
} {
  return { id, description: `Substep ${id}`, transitions: DEFAULT_TRANSITIONS };
}

/** Helper: create minimal RunbookState for testing. */
export function makeState(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id: 'run-1',
    runbook: 'parent.md',
    runbookPath: 'parent.md',
    step: '1',
    stepName: 'Main step',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [{ id: '1', status: 'running' }],
    startedAt: '2026-02-27T10:00:00.000Z',
    updatedAt: '2026-02-27T10:00:00.000Z',
    substepStates: [
      { id: '1', frameKey: buildFrameKey('1'), status: 'pending' },
      { id: '2', frameKey: buildFrameKey('1'), status: 'pending' },
    ],
    templateVars: brandInitialTemplateVarsForTest({ env: 'staging' }),
    ...overrides,
  } as RunbookState;
}

/** Helper: create minimal Step[] for testing. */
export function makeSteps(
  stepName = '1',
  substepIds: string[] = ['1', '2'],
): readonly ResolvedStep[] {
  const steps: TestStep[] = [
    {
      kind: 'substeps',
      name: stepName,
      description: 'Test step',
      transitions: DEFAULT_TRANSITIONS,
      substeps: substepIds.map(makeTestSubstep),
    },
  ];
  return steps as readonly ResolvedStep[];
}

/** Helper: create steps without substeps. */
export function makeSimpleSteps(stepName = '1'): readonly ResolvedStep[] {
  const steps: TestStep[] = [
    {
      kind: 'base',
      name: stepName,
      description: 'Simple step',
      transitions: DEFAULT_TRANSITIONS,
    },
  ];
  return steps as readonly ResolvedStep[];
}

/** Helper: create FOR steps with substeps (supports three-level step IDs). */
export function makeForSteps(
  stepName = '1',
  substepIds: string[] = ['1', '2'],
): readonly ResolvedStep[] {
  const steps: TestStep[] = [
    {
      kind: 'for',
      name: stepName,
      description: 'FOR step',
      transitions: DEFAULT_TRANSITIONS,
      forClause: { variable: 'i', start: 1, end: 10 },
      substeps: substepIds.map(makeTestSubstep),
    },
  ];
  return steps as readonly ResolvedStep[];
}

/** Helper: create prompted-for steps with substeps (supports three-level step IDs). */
export function makePromptedForSteps(
  stepName = '1',
  substepIds: string[] = ['1', '2'],
): readonly ResolvedStep[] {
  const steps: TestStep[] = [
    {
      kind: 'prompted-for',
      name: stepName,
      description: 'Prompted-FOR step',
      transitions: DEFAULT_TRANSITIONS,
      substeps: substepIds.map(makeTestSubstep),
    },
  ];
  return steps as readonly ResolvedStep[];
}
