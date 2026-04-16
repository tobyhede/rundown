/**
 * Shared OUTPUTS persistence helper for pass transitions.
 *
 * Extracted so it can be called from both the manual-pass path
 * (`executeTransition`) and the auto-execution path (`applyResultTransition`).
 *
 * @module helpers/step-outputs
 */

import {
  type ExecutionEventEmitter,
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
 * transition is already recorded. When an `emitter` is supplied, expression
 * failures additionally raise `ERROR_OCCURRED` events so `--json` consumers
 * and TTY output surface the issue (otherwise it would only appear in logs).
 *
 * @param outputs - Output declarations from the step definition
 * @param templateVars - Resolved template variables from the runbook state
 * @param cwd - Project root directory
 * @param emitter - Optional execution event emitter for surfacing failures
 */
export async function storeStepOutputs(
  outputs: readonly OutputDeclaration[],
  templateVars: Readonly<Record<string, TemplateVarValue>> | undefined,
  cwd: string,
  emitter?: ExecutionEventEmitter,
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
  let failureCount = 0;
  for (const output of outputs) {
    try {
      evaluated[output.name] = evaluateOutputExpression(output.value, { ...templateVars });
    } catch (err) {
      failureCount++;
      const message = getErrorMessage(err);
      void logger.warn('storeStepOutputs: failed to evaluate output expression', {
        name: output.name,
        value: output.value,
        error: message,
      });
      emitter?.emit('ERROR_OCCURRED', {
        message: `OUTPUTS evaluation failed for "${output.name}": ${message}`,
        code: 'OUTPUTS_EVAL_FAILED',
      });
    }
  }

  if (Object.keys(evaluated).length === 0) {
    const message =
      failureCount > 0
        ? 'all OUTPUTS declarations failed to evaluate — nothing stored to context'
        : 'no OUTPUTS to store (empty declarations)';
    void logger.warn(`storeStepOutputs: ${message}`);
    if (failureCount > 0) {
      emitter?.emit('ERROR_OCCURRED', {
        message: `storeStepOutputs: ${message}`,
        code: 'OUTPUTS_EVAL_FAILED',
      });
    }
    return;
  }
  await storeContextOutputs(cwd, contextId, evaluated);
}
