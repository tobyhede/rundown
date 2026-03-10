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

import { parseRunbookDocument, type Step } from '@rundown-org/core';
import type { RunbookState } from '@rundown-org/core';
import {
  substituteRunbookVariables,
  expandForClauseVariables,
  warnUnresolvedRunbookVariables,
} from '../services/template-renderer.js';

/**
 * Load and parse runbook steps from state.
 *
 * When `templateVars` is present in state, variables are re-applied via AST-level
 * substitution. Any unresolved template variables emit a warning to stderr.
 *
 * @param state - Runbook state containing runbookSrc and optionally templateVars
 * @param _cwd - Unused, kept for signature compatibility
 * @returns Parsed steps from runbookSrc (with variables substituted if templateVars present)
 * @throws {Error} if runbookSrc is missing (corrupted state)
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
export function getRunbookFromState(state: RunbookState, _cwd: string): readonly Step[] {
  if (!state.runbookSrc) {
    throw new Error(
      `State file ${state.id} is missing runbookSrc. ` +
        `This indicates corrupted state. Delete and re-run the runbook.`,
    );
  }
  // New flow: raw runbookSrc + templateVars → pre-expand FOR clauses, parse, substitute
  if (state.templateVars) {
    const sourceKeys = new Set(Object.keys(state.sources ?? {}));
    const forExpanded = expandForClauseVariables(state.runbookSrc, state.templateVars, sourceKeys);
    const runbook = parseRunbookDocument(forExpanded, state.runbook);
    const substituted = substituteRunbookVariables(runbook, state.templateVars);
    const forVars = new Set<string>();
    for (const step of substituted.steps) {
      if (step.kind === 'for') {
        if (step.forClause.variable) forVars.add(step.forClause.variable);
        forVars.add('Index');
        forVars.add('index');
      }
    }
    warnUnresolvedRunbookVariables(substituted, {
      suppressedVariables: forVars.size > 0 ? forVars : undefined,
    });
    return substituted.steps;
  }

  const runbook = parseRunbookDocument(state.runbookSrc, state.runbook);

  // Backward compat: old state files have pre-expanded runbookSrc, no templateVars
  return runbook.steps;
}
