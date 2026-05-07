import { stepHasSubsteps } from '@rundown-org/parser';
import type {
  BaseStep,
  ParsedSubstep,
  ResolvedStepWithSubsteps,
  ResolvedStepWithFor,
  ResolvedStepWithPromptedFor,
  Step,
  StepHavingSubsteps,
  StepWithCommand,
  Substep,
  Transitions,
} from '@rundown-org/parser';
import type { ContextSnapshot, StepDelegation } from '../../src/runbook/types.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import { brandEffectiveVarsForTest } from './effective-vars.js';

/**
 * Assertion helper: narrows a `Step | undefined` to `StepHavingSubsteps`.
 *
 * Use in tests that need type-safe access to `.substeps` after parsing or
 * rendering, without casting.
 *
 * @param step - The step to check; may be `undefined` (e.g. from array index)
 * @throws If `step` is `undefined` or does not have substeps
 */
export function assertHasSubsteps(step: Step | undefined): asserts step is StepHavingSubsteps {
  if (!step || !stepHasSubsteps(step)) {
    throw new Error('Expected step to have substeps');
  }
}

/**
 * Default pass/fail transitions: PASS CONTINUE, FAIL STOP.
 *
 * @param overrides - Optional partial overrides for individual pass/fail handlers.
 * @returns A `Transitions` object with sensible test defaults.
 */
export function makeTransitions(overrides: Partial<Transitions> = {}): Transitions {
  return {
    pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
    fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    ...overrides,
  };
}

/**
 * Build a resolved `Substep` with required `transitions` populated.
 *
 * @param partial - Overrides for any Substep field.
 * @returns A valid `Substep` for use in `ResolvedStepWith*` fixtures.
 * @remarks Default `id` is `'1'`. When composing multiple substeps in a single parent, pass
 * distinct ids to avoid uniqueness conflicts in id-keyed lookups.
 */
export function makeSubstep(partial: Partial<Substep> = {}): Substep {
  return {
    id: '1',
    description: 'Substep',
    transitions: makeTransitions(),
    ...partial,
  };
}

/**
 * Build a parsed `ParsedSubstep` (may reference unresolved runbook refs).
 *
 * Use when the code under test receives parser output directly (e.g.
 * renderer tests). Prefer `makeSubstep` for anything past resolution.
 *
 * @param partial - Overrides for any ParsedSubstep field.
 * @returns A valid `ParsedSubstep` with required fields filled.
 * @remarks Default `id` is `'1'`. When composing multiple substeps in a single parent, pass
 * distinct ids to avoid uniqueness conflicts in id-keyed lookups.
 */
export function makeParsedSubstep(partial: Partial<ParsedSubstep> = {}): ParsedSubstep {
  return {
    id: '1',
    description: 'Substep',
    transitions: makeTransitions(),
    ...partial,
  };
}

/**
 * Build a `BaseStep` (prompt-only / empty step).
 *
 * @param partial - Overrides for any BaseStep field except `kind` (set internally).
 * @returns A valid `BaseStep` with required fields filled.
 * @remarks Default `name` is `'1'`. When composing multiple steps in a test, pass distinct names
 * to avoid conflicts in name-keyed lookups.
 */
export function makeBaseStep(partial: Omit<Partial<BaseStep>, 'kind'> = {}): BaseStep {
  return {
    name: '1',
    description: 'Step',
    transitions: makeTransitions(),
    ...partial,
    kind: 'base',
  };
}

/**
 * Build a `StepWithCommand` (step with an executable command).
 *
 * @param partial - Overrides for any StepWithCommand field except `kind` (set internally).
 * @returns A valid `StepWithCommand` with required fields filled.
 * @remarks Default `name` is `'1'`. When composing multiple steps in a test, pass distinct names
 * to avoid conflicts in name-keyed lookups.
 */
export function makeCommandStep(
  partial: Omit<Partial<StepWithCommand>, 'kind'> = {},
): StepWithCommand {
  return {
    name: '1',
    description: 'Command step',
    transitions: makeTransitions(),
    command: { code: 'true' },
    ...partial,
    kind: 'command',
  };
}

/**
 * Build a `ResolvedStepWithSubsteps` with zero or more substeps.
 *
 * @param partial - Overrides for any ResolvedStepWithSubsteps field except `kind` (set internally).
 * @returns A valid `ResolvedStepWithSubsteps` with required fields filled.
 * @remarks Default `name` is `'1'`. When composing multiple steps in a test, pass distinct names
 * to avoid conflicts in name-keyed lookups.
 */
export function makeResolvedStepWithSubsteps(
  partial: Omit<Partial<ResolvedStepWithSubsteps>, 'kind'> = {},
): ResolvedStepWithSubsteps {
  return {
    name: '1',
    description: 'Step with substeps',
    transitions: makeTransitions(),
    substeps: [],
    ...partial,
    kind: 'substeps',
  };
}

/**
 * Build a `ResolvedStepWithFor` (FOR loop with concrete bounds).
 *
 * Default forClause is a numeric range `{ variable: 'i', start: 1, end: 10 }`.
 *
 * @param partial - Overrides for any ResolvedStepWithFor field except `kind` (set internally).
 * @returns A valid `ResolvedStepWithFor` with required fields filled.
 * @remarks Default `name` is `'1'`. When composing multiple steps in a test, pass distinct names
 * to avoid conflicts in name-keyed lookups.
 */
export function makeResolvedStepWithFor(
  partial: Omit<Partial<ResolvedStepWithFor>, 'kind'> = {},
): ResolvedStepWithFor {
  return {
    name: '1',
    description: 'FOR step',
    transitions: makeTransitions(),
    forClause: { variable: 'i', start: 1, end: 10 },
    substeps: [],
    ...partial,
    kind: 'for',
  };
}

/**
 * Build a `ResolvedStepWithPromptedFor` (FOR demoted to prompt-only).
 *
 * @param partial - Overrides for any ResolvedStepWithPromptedFor field except `kind` (set internally).
 * @returns A valid `ResolvedStepWithPromptedFor` with required fields filled.
 * @remarks Default `name` is `'1'`. When composing multiple steps in a test, pass distinct names
 * to avoid conflicts in name-keyed lookups.
 */
export function makeResolvedStepWithPromptedFor(
  partial: Omit<Partial<ResolvedStepWithPromptedFor>, 'kind'> = {},
): ResolvedStepWithPromptedFor {
  return {
    name: '1',
    description: 'Prompted-FOR step',
    transitions: makeTransitions(),
    substeps: [],
    ...partial,
    kind: 'prompted-for',
  };
}

/**
 * Build a `ContextSnapshot` with a branded empty `EffectiveVars`.
 *
 * @param partial - Overrides for snapshot fields.
 * @returns A valid `ContextSnapshot` with required fields filled.
 */
export function makeContextSnapshot(partial: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    vars: brandEffectiveVarsForTest({}),
    ancestors: [],
    ...partial,
  };
}

/**
 * Build a `StepDelegation` with a branded empty `contextSnapshot`.
 *
 * @param partial - Overrides for any StepDelegation field.
 * @returns A valid `StepDelegation` with required fields filled.
 */
export function makeStepDelegation(partial: Partial<StepDelegation> = {}): StepDelegation {
  return {
    tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
    childRunbookPath: 'child.md',
    childRunbookRef: { source: 'project', path: 'child.md' },
    contextSnapshot: makeContextSnapshot(),
    childRunId: null,
    createdAt: '2026-02-27T10:00:00.000Z',
    cancelledAt: null,
    ...partial,
  };
}
