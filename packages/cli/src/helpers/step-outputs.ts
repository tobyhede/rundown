/**
 * Shared OUTPUTS persistence helper for pass transitions.
 *
 * Extracted so it can be called from both the manual-pass path
 * (`executeTransition`) and the auto-execution path (`applyResultTransition`).
 *
 * @module helpers/step-outputs
 */

import {
  getErrorMessage,
  logger,
  storeContextOutputs,
  type TemplateVarValue,
} from '@rundown-org/core';
import type { OutputDeclaration } from '@rundown-org/parser';
import { evaluateOutputExpression } from '../services/template-renderer.js';

/**
 * Evaluate and store OUTPUTS declarations for a step that just passed.
 *
 * Silently skips if `templateVars` is missing or if any expression fails to
 * evaluate. Failures are non-fatal — OUTPUTS storage is best-effort; the pass
 * transition is already recorded.
 *
 * @param outputs - Output declarations from the step definition
 * @param templateVars - Resolved template variables from the runbook state
 * @param cwd - Project root directory
 */
export async function storeStepOutputs(
  outputs: readonly OutputDeclaration[],
  templateVars: Readonly<Record<string, TemplateVarValue>> | undefined,
  cwd: string,
): Promise<void> {
  if (!templateVars) {
    void logger.warn('storeStepOutputs: templateVars not available, skipping OUTPUTS storage');
    return;
  }
  const contextId = typeof templateVars.ContextId === 'string' ? templateVars.ContextId : undefined;
  if (!contextId) {
    void logger.warn(
      'storeStepOutputs: ContextId variable is not defined, skipping OUTPUTS storage',
    );
    return;
  }

  const evaluated: Record<string, string> = {};
  for (const output of outputs) {
    try {
      evaluated[output.name] = evaluateOutputExpression(output.value, { ...templateVars });
    } catch (err) {
      void logger.warn('storeStepOutputs: failed to evaluate output expression', {
        name: output.name,
        value: output.value,
        error: getErrorMessage(err),
      });
    }
  }

  if (Object.keys(evaluated).length === 0) {
    void logger.warn(
      'storeStepOutputs: all OUTPUTS declarations failed to evaluate — nothing stored to context',
    );
    return;
  }
  await storeContextOutputs(cwd, contextId, evaluated);
}
