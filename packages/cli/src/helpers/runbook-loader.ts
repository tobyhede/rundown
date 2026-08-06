/**
 * Shared helper for loading runbook content from state.
 *
 * The stored `runbookSrc` is raw markdown with `{{placeholders}}`, and the
 * persisted `templateVars` are re-applied via AST-level substitution with
 * context-aware escaping on each resume.
 *
 * Persisted state carries no compatibility contract: a row without
 * `templateVars` is incompatible state, not a shape to reconstruct by
 * re-parsing the stored source. Such a row is refused here and the caller is
 * told to prune and re-run.
 *
 * @module
 * @throws {Error} if runbookSrc or templateVars is missing (unusable state)
 */

import { parseRunbookDocument, type ResolvedStep } from '@rundown-org/parser';
import {
  mergeEffectiveVars,
  resolveForBounds,
  substituteRunbookVariables,
  type RunbookState,
} from '@rundown-org/core';
import { getHelperRegistry } from '../services/helper-registry.js';
import { buildRunnableRenderContext } from './render-context.js';

/**
 * Load and parse runbook steps from state.
 *
 * Parses the persisted raw `runbookSrc` and re-applies `state.templateVars` via
 * AST-level substitution.
 *
 * @param state - Runbook state containing runbookSrc and templateVars
 * @param cwd - Project directory used when resolving runbook bounds
 * @returns Parsed steps with all FOR bounds resolved
 * @throws {Error} if runbookSrc is missing (corrupted state)
 * @throws {Error} if templateVars is missing (incompatible state — prune and re-run)
 * @throws {Error} if the parsed runbook has structural errors
 * @throws {RunbookSyntaxError} if runbookSrc fails to parse as a runbook document
 *         (thrown by parseRunbookDocument)
 *
 * @remarks
 * Unresolved `{{variable}}` placeholders are not warned about here: the
 * pipeline path already reported them at startup, so repeating the warning
 * would duplicate it and leak into command output.
 *
 * @example
 * ```typescript
 * const steps = getRunbookFromState(state, cwd);
 * const currentStep = steps.find(s => s.name === state.step);
 * ```
 */
export function getRunbookFromState(state: RunbookState, cwd: string): readonly ResolvedStep[] {
  if (!state.runbookSrc) {
    throw new Error(
      `Persisted run ${state.id} is missing runbookSrc. ` +
        `This indicates corrupted state. Delete and re-run the runbook.`,
    );
  }

  if (!state.templateVars) {
    throw new Error(
      `Persisted run ${state.id} is missing templateVars. ` +
        `This indicates incompatible state. Prune the run and re-run the runbook.`,
    );
  }

  const { runbook, diagnostics } = parseRunbookDocument(state.runbookSrc, state.runbook.path);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `Runbook ${state.runbook.path} has structural errors: ${errors[0].message}. ` +
        `Delete state and re-run the runbook.`,
    );
  }

  // Substitution happens against effective variables so artifact inputs seeded
  // into RunbookState.variables remain visible after status/resume/reload.
  const effectiveVars = mergeEffectiveVars(state);
  const { runbook: resolved } = resolveForBounds(runbook, effectiveVars);
  const substituted = substituteRunbookVariables(resolved, effectiveVars, {
    helpers: getHelperRegistry(),
    context: buildRunnableRenderContext({ runId: state.id, cwd, vars: effectiveVars }),
  });
  return substituted.steps;
}
