/**
 * Pure OUTPUTS evaluation helpers for step and frontmatter declarations.
 *
 * These functions evaluate OUTPUTS expressions and return key-value pairs.
 * No file I/O — callers persist results to state.variables or state.finalVars.
 *
 * @module helpers/step-outputs
 */

import { type ExecutionEventEmitter, getErrorMessage, logger } from '@rundown-org/core';
import type { OutputDeclaration } from '@rundown-org/parser';
import type { StepVariables } from '../services/execution-vars.js';
import { evaluateOutputExpression } from '../services/template-renderer.js';

export const ALL_OUTPUTS_FAILED_MESSAGE =
  'all OUTPUTS declarations failed to evaluate — nothing stored to context';

/**
 * Evaluate OUTPUTS declarations for a step that just completed (pass or fail).
 *
 * Naked form (no `value`) is invalid at step level and silently skipped.
 * Expression evaluation failures are non-fatal: logged + emitted as ERROR_OCCURRED.
 *
 * @param outputs - Output declarations from the step definition
 * @param effectiveVars - Template variables available at evaluation time
 * @param emitter - Optional emitter for surfacing evaluation failures
 * @returns Evaluated key-value pairs (empty if nothing evaluated)
 */
export function evaluateStepOutputs(
  outputs: readonly OutputDeclaration[],
  effectiveVars: Readonly<StepVariables>,
  emitter?: ExecutionEventEmitter,
): Record<string, string> {
  const evaluated: Record<string, string> = {};
  for (const output of outputs) {
    if (output.value === undefined) {
      void logger.warn('evaluateStepOutputs: naked form invalid at step level, skipping', {
        name: output.name,
      });
      continue;
    }
    try {
      evaluated[output.name] = evaluateOutputExpression(output.value, { ...effectiveVars });
    } catch (err) {
      const message = getErrorMessage(err);
      void logger.warn('evaluateStepOutputs: failed to evaluate output expression', {
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
  return evaluated;
}

/**
 * Evaluate frontmatter OUTPUTS declarations at runbook termination.
 *
 * Handles both forms:
 * - Naked form (`PlanPath`): reads variable by name from effectiveVars, stringified
 * - With-value form (`PlanPath "literal"`): delegates to evaluateOutputExpression
 *
 * Failures are non-fatal.
 *
 * @param outputs - Output declarations from frontmatter
 * @param effectiveVars - Template variables at termination (templateVars + machineContext.variables)
 * @param emitter - Optional emitter for surfacing evaluation failures
 * @returns Evaluated key-value pairs (empty if nothing evaluated)
 */
export function evaluateFrontmatterOutputs(
  outputs: readonly OutputDeclaration[],
  effectiveVars: Readonly<StepVariables>,
  emitter?: ExecutionEventEmitter,
): Record<string, string> {
  const evaluated: Record<string, string> = {};
  for (const output of outputs) {
    try {
      if (output.value !== undefined) {
        evaluated[output.name] = evaluateOutputExpression(output.value, { ...effectiveVars });
      } else {
        const rawVal = (effectiveVars as Record<string, unknown>)[output.name];
        if (rawVal === null || rawVal === undefined) {
          void logger.warn('evaluateFrontmatterOutputs: naked-form variable not found, skipping', {
            name: output.name,
          });
          continue;
        }
        if (
          typeof rawVal === 'string' ||
          typeof rawVal === 'number' ||
          typeof rawVal === 'boolean'
        ) {
          evaluated[output.name] = String(rawVal);
        } else {
          void logger.warn(
            'evaluateFrontmatterOutputs: naked-form variable is non-scalar, skipping',
            { name: output.name },
          );
        }
      }
    } catch (err) {
      const message = getErrorMessage(err);
      void logger.warn('evaluateFrontmatterOutputs: failed to evaluate output expression', {
        name: output.name,
        value: output.value,
        error: message,
      });
      emitter?.emit('ERROR_OCCURRED', {
        message: `Frontmatter OUTPUTS evaluation failed for "${output.name}": ${message}`,
        code: 'OUTPUTS_EVAL_FAILED',
      });
    }
  }
  return evaluated;
}
