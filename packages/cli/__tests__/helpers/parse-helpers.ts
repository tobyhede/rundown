// __tests__/helpers/parse-helpers.ts
// Test-only narrowing helpers around parser output.

import { areAllStepsResolved, parseRunbookDocument } from '@rundown-org/parser';
import type {
  ResolvedRunbook,
  ResolvedStep,
  ResolvedStepHavingSubsteps,
  ResolvedStepWithFor,
  Runbook,
  StepWithCommand,
} from '@rundown-org/parser';

/**
 * Parse a markdown string and return a `ResolvedRunbook`.
 *
 * Tests in `cli` consume `substituteRunbookVariables` and the renderer,
 * which expect `ResolvedRunbook` (no unresolved FOR bounds, no unresolved
 * runbook refs). `parseRunbookDocument` returns the broader `Runbook`
 * type. This helper centralises the narrowing — fixtures without FOR
 * loops are structurally `ResolvedRunbook` already, so the assertion
 * succeeds and the cast is safe.
 *
 * @param markdown - Runbook source text
 * @returns A resolved runbook view of the parsed AST
 * @throws If any step is not resolved (unresolved FOR bounds or runbook refs).
 *   Callers that intentionally test unresolved input should call
 *   `parseRunbookDocument` directly and cast as appropriate.
 */
export function parseResolvedRunbook(markdown: string): ResolvedRunbook {
  const { runbook } = parseRunbookDocument(markdown);
  return assertResolvedRunbook(runbook);
}

/**
 * Narrow a `Runbook` to a `ResolvedRunbook` for tests whose fixtures
 * contain no unresolved FOR bounds and no unresolved runbook refs.
 *
 * @param runbook - A parsed runbook
 * @returns The same runbook narrowed to `ResolvedRunbook`
 * @throws If any step still carries unresolved bounds.
 */
export function assertResolvedRunbook(runbook: Runbook): ResolvedRunbook {
  if (!areAllStepsResolved(runbook.steps)) {
    throw new Error('parseResolvedRunbook: runbook contains unresolved FOR bounds or runbook refs');
  }
  return runbook as ResolvedRunbook;
}

/**
 * Narrow `step` to `StepWithCommand`. Throws on any other kind.
 *
 * Used in tests where the test fixture deliberately produces a command
 * step, but `result.steps[0]` is typed as the wider `ResolvedStep` union.
 *
 * @throws If `step.kind !== 'command'`
 */
export function assertStepWithCommand(
  step: ResolvedStep | undefined,
): asserts step is StepWithCommand {
  if (step?.kind !== 'command') {
    throw new Error(`Expected ResolvedStep kind 'command', got '${step?.kind ?? 'undefined'}'`);
  }
}

/**
 * Narrow `step` to a step that owns substeps (substeps / for / prompted-for).
 *
 * Used in tests that need typed `.substeps` access without caring whether
 * the step is a FOR loop or a plain substeps step.
 *
 * @throws If `step` is `undefined` or its kind is not substep-bearing
 */
export function assertResolvedStepHasSubsteps(
  step: ResolvedStep | undefined,
): asserts step is ResolvedStepHavingSubsteps {
  if (!step || (step.kind !== 'substeps' && step.kind !== 'for' && step.kind !== 'prompted-for')) {
    throw new Error(
      `Expected ResolvedStep kind 'substeps' | 'for' | 'prompted-for', got '${step?.kind ?? 'undefined'}'`,
    );
  }
}

/**
 * Narrow `step` to `ResolvedStepWithFor` (resolved FOR clause with bounds).
 *
 * @throws If `step.kind !== 'for'`
 */
export function assertResolvedStepWithFor(
  step: ResolvedStep | undefined,
): asserts step is ResolvedStepWithFor {
  if (step?.kind !== 'for') {
    throw new Error(`Expected ResolvedStep kind 'for', got '${step?.kind ?? 'undefined'}'`);
  }
}
