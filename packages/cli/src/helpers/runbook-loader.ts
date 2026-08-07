/**
 * Shared helper for loading runbook content from state.
 *
 * The stored `runbookSrc` is raw markdown with `{{placeholders}}`, and the
 * persisted `templateVars` are re-applied via AST-level substitution with
 * context-aware escaping on each resume.
 *
 * Persisted state carries no compatibility contract: a row without
 * `templateVars` is incompatible state, not a shape to reconstruct by
 * re-parsing the stored source. That refusal is **not** enforced here — it
 * belongs at the JSON boundary (`RunbookStateManager.load`), which rejects such
 * a row before the value is ever typed as a `RunbookState`. By the time this
 * module sees a state, `templateVars` is a required field that is present.
 *
 * The throw contract lives on {@link getRunbookFromState} and is not restated
 * here, so the two cannot drift apart.
 *
 * @module
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
 * @throws {Error} if `runbookSrc` is missing (corrupted state)
 * @throws {Error} if the parsed runbook has error-severity structural diagnostics;
 *         the message reports the first such diagnostic
 * @throws {Error} if the effective variables lack `ContextId` or `WorkPath`
 *         (thrown by `buildRunnableRenderContext`)
 * @throws {Error} if a FOR bound variable is defined but resolves to a
 *         non-integer or out-of-range value (thrown by `resolveForBounds`)
 * @throws {RunbookSyntaxError} if `runbookSrc` fails to parse as a runbook
 *         document (thrown by `parseRunbookDocument`), or if loop-only controls
 *         reference a prompted FOR step (thrown by `resolveForBounds`)
 *
 * There is deliberately no `templateVars` throw: the field is required on
 * `RunbookState` and the refusal is enforced at the JSON boundary. Callers in
 * other front ends must not skip their own validation on the strength of a
 * guard this function does not have.
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

  // No `templateVars` guard here: the field is required on `RunbookState`, and
  // the refusal belongs at the JSON boundary where the invariant can actually
  // be violated — `RunbookStateManager.load` rejects a persisted row without it
  // before the value is ever typed as a `RunbookState`.
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
