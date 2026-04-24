import type { Step, StepWithCommand, StepWithFor, StepHavingSubsteps } from '../src/ast.js';

/**
 * Narrows `step` to `StepWithCommand`. Throws if `step.kind !== 'command'`.
 *
 * Used in tests where the test setup guarantees a command step but the
 * parser return type is the broader `Step` union.
 *
 * @param step - The Step to narrow
 * @throws Error if `step.kind !== 'command'`
 */
export function assertStepWithCommand(step: Step): asserts step is StepWithCommand {
  if (step.kind !== 'command') {
    throw new Error(`expected kind 'command', got '${step.kind}'`);
  }
}

/**
 * Narrows `step` to `StepHavingSubsteps` (i.e. `StepWithSubsteps | StepWithFor`).
 * Throws if `step.kind` is neither `'substeps'` nor `'for'`.
 *
 * Used where a test inspects `step.substeps` without caring whether the
 * step is a FOR loop or a plain substeps step.
 *
 * @param step - The Step to narrow
 * @throws Error if `step.kind` is neither `'substeps'` nor `'for'`
 */
export function assertStepHasSubsteps(step: Step): asserts step is StepHavingSubsteps {
  if (step.kind !== 'substeps' && step.kind !== 'for') {
    throw new Error(`expected kind 'substeps' or 'for', got '${step.kind}'`);
  }
}

/**
 * Narrows `step` to `StepWithFor`. Throws if `step.kind !== 'for'`.
 *
 * Used where a test specifically inspects `step.forClause` — a field
 * that only exists on the `'for'` variant.
 *
 * @param step - The Step to narrow
 * @throws Error if `step.kind !== 'for'`
 */
export function assertStepWithFor(step: Step): asserts step is StepWithFor {
  if (step.kind !== 'for') {
    throw new Error(`expected kind 'for', got '${step.kind}'`);
  }
}
