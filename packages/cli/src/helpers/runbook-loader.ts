/**
 * Shared helper for loading runbook content from state.
 *
 * When `templateVars` is present in state (new flow), the stored `runbookSrc`
 * contains raw markdown with `{{placeholders}}`. Variables are re-applied via
 * AST-level substitution with context-aware escaping on each resume.
 *
 * For backward compatibility, old state files (pre-expanded `runbookSrc`,
 * no `templateVars`) continue to work — the expanded content is parsed directly.
 *
 * @module
 * @throws {Error} if runbookSrc is missing (indicates corrupted state)
 */

import { parseRunbookDocument, areAllStepsResolved, type ResolvedStep } from '@rundown-org/parser';
import { resolveForBounds, substituteRunbookVariables, type RunbookState } from '@rundown-org/core';
import { getHelperRegistry } from '../services/helper-registry.js';

/**
 * Load and parse runbook steps from state.
 *
 * When `templateVars` is present in state, variables are re-applied via AST-level
 * substitution. Any unresolved template variables emit a warning to stderr.
 *
 * @param state - Runbook state containing runbookSrc and optionally templateVars
 * @param cwd - Project directory used when resolving runbook bounds
 * @returns Parsed steps with all FOR bounds resolved
 * @throws {Error} if runbookSrc is missing (corrupted state)
 * @throws {Error} if persisted state contains unresolved FOR bounds or runbook references
 * @throws {RunbookSyntaxError} if runbookSrc fails to parse as a runbook document
 *         (thrown by parseRunbookDocument)
 *
 * @remarks
 * When `state.templateVars` is present and substitution leaves unresolved
 * `{{variable}}` placeholders, a deduplicated warning per variable is written
 * to stderr via `console.warn`.
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
      `State file ${state.id} is missing runbookSrc. ` +
        `This indicates corrupted state. Delete and re-run the runbook.`,
    );
  }

  // Check for parser diagnostics
  const checkDiagnostics = (
    diagnostics: readonly { severity: string; message: string }[],
  ): void => {
    const errors = diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      throw new Error(
        `Runbook ${state.runbook.path} has structural errors: ${errors[0].message}. ` +
          `Delete state and re-run the runbook.`,
      );
    }
  };

  // New flow: raw runbookSrc + templateVars → parse, resolve FOR bounds, substitute.
  //
  // Substitution happens against `state.templateVars` (typed as InitialTemplateVars)
  // — the immutable seeded inputs. Step OUTPUTS (state.variables, typed as
  // StoredOutputs) are *not* applied here: load-time substitution rewrites the
  // parsed AST, but OUTPUTS only become visible after a step has executed.
  // Runtime expansion in packages/cli/src/services/execution.ts re-merges via
  // mergeEffectiveVars to include OUTPUTS for descriptions, prompts, and
  // downstream OUTPUTS expressions.
  if (state.templateVars) {
    const { runbook, diagnostics } = parseRunbookDocument(state.runbookSrc, state.runbook.path);
    checkDiagnostics(diagnostics);
    const { runbook: resolved } = resolveForBounds(runbook, state.templateVars);
    const substituted = substituteRunbookVariables(resolved, state.templateVars, {
      cwd,
      helpers: getHelperRegistry(),
    });
    // Unresolved variable warnings were already shown at startup via the pipeline path.
    // Suppress them here to avoid duplicating warnings and leaking into command output.
    return substituted.steps;
  }

  // Fallback for state files with pre-expanded runbookSrc and no templateVars.
  const { runbook, diagnostics } = parseRunbookDocument(state.runbookSrc, state.runbook.path);
  checkDiagnostics(diagnostics);

  if (!areAllStepsResolved(runbook.steps)) {
    throw new Error(
      `Runbook ${state.runbook.path} has unresolved FOR bounds or runbook references in pre-expanded state. ` +
        `This indicates invalid state. Delete and re-run the runbook.`,
    );
  }

  return runbook.steps;
}
