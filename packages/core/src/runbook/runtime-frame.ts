import { isSourced, type ForClause, type ResolvedStep } from '@rundown-org/parser';
import { collectProducedNames } from './for-source-analysis.js';
import { deriveExecutionAt } from './targeting.js';
import {
  assertResolvedVariableForContext,
  isJsonArray,
  toIterableSource,
  type ForContext,
  type TemplateVarValue,
} from './types.js';
import type { VariableValue } from './effective-vars.js';

/** Runtime value allowed in per-step execution frames. */
export type ExecutionVarValue = TemplateVarValue | boolean | null;
/** Variables available while rendering a concrete step execution. */
export type StepVariables = Record<string, ExecutionVarValue>;
/** Template variables available before per-step runtime fields are added. */
export type TemplateVariables = Record<string, TemplateVarValue>;

/** Inputs needed to derive runtime variables for the current step frame. */
export interface BuildStepVariablesInput {
  readonly stepId: string;
  readonly substepId?: string;
  readonly forStack?: readonly ForContext[];
  readonly forClause?: ForClause;
  readonly templateVars?: Readonly<Record<string, TemplateVarValue>>;
}

/**
 * Build `context.vars.*` aliases for user-visible template variables.
 *
 * @template T - Value type of the source record; preserved on the returned
 *   namespaced map. Callers use this with `TemplateVarValue`,
 *   `ContextSnapshotVarValue`, or `VariableValue` depending on context.
 * @param vars - Variables to expose under the context namespace
 * @returns Namespaced context variable map
 */
export function buildContextVars<T>(vars: Readonly<Record<string, T>>): Record<string, T> {
  const contextVars: Record<string, T> = {};
  for (const [key, value] of Object.entries(vars)) {
    contextVars[`context.vars.${key}`] = value;
  }
  return contextVars;
}

/**
 * Build runtime variables for a step or FOR-loop iteration.
 *
 * @param input - Step identity, loop context, and base template variables
 * @returns Runtime variables merged with the supplied template variables
 * @throws {Error} if an unknown FOR source kind is encountered
 */
export function buildStepVariables(input: BuildStepVariablesInput): StepVariables {
  const { stepId, substepId, forStack, forClause, templateVars } = input;
  const step = substepId ? `${stepId}.${substepId}` : stepId;
  const vars: StepVariables = {
    ...(templateVars ?? {}),
    Step: step,
    step,
    'context.current.step': step,
  };
  if (substepId) {
    vars['context.current.substep'] = substepId;
  }

  if (forStack?.length) {
    const top = forStack[forStack.length - 1];
    if (!top.implicit) {
      vars.Index = String(top.iteration);
      vars.index = String(top.iteration);
      vars['context.current.index'] = String(top.iteration);
      vars['context.current.at'] = deriveExecutionAt(stepId, substepId, top.iteration);

      if (top.variable) {
        switch (top.source.kind) {
          case 'range':
            vars[top.variable] = String(top.iteration);
            break;
          case 'variable':
            assertResolvedVariableForContext(top);
            vars[top.variable] = top.currentValue;
            break;
          default: {
            const _exhaustive: never = top.source;
            throw new Error(`Unexpected source kind: ${(_exhaustive as { kind: string }).kind}`);
          }
        }
      }
    }
  } else if (forClause) {
    vars.Index = String(forClause.start);
    vars.index = String(forClause.start);
    vars['context.current.index'] = String(forClause.start);
    vars['context.current.at'] = deriveExecutionAt(stepId, substepId, forClause.start);

    if (isSourced(forClause)) {
      const value = templateVars?.[forClause.source];
      if (value !== undefined && isJsonArray(value)) {
        const clampedStart = Math.max(1, Math.min(forClause.start, value.length));
        vars.Index = String(clampedStart);
        vars.index = String(clampedStart);
        vars['context.current.index'] = String(clampedStart);
        vars['context.current.at'] = deriveExecutionAt(stepId, substepId, clampedStart);
        vars[forClause.variable] = value[clampedStart - 1] ?? '';
      } else {
        vars[forClause.variable] = '';
      }
    } else if (forClause.variable) {
      vars[forClause.variable] = String(forClause.start);
    }
  }

  if (!Object.hasOwn(vars, 'context.current.at')) {
    vars['context.current.at'] = deriveExecutionAt(stepId, substepId);
  }

  return vars;
}

/**
 * Validate that sourced FOR loops reference iterable variables.
 *
 * @remarks A FOR source produced by an earlier step's OUTPUTS or name-binding
 * ARTIFACTS is deferred to step-entry resolution and not validated here
 * (language spec §8.2).
 *
 * @param steps - Resolved steps to validate
 * @param vars - Template variables available to the runbook
 * @throws {Error} if a FOR source variable is missing or non-iterable
 */
export function validateForVariables(
  steps: readonly ResolvedStep[],
  vars: Readonly<Partial<Record<string, VariableValue>>>,
): void {
  const produced = collectProducedNames(steps);
  for (const step of steps) {
    if (step.kind === 'for' && isSourced(step.forClause)) {
      const name = step.forClause.source;
      // A source produced by an earlier step in this run resolves at step
      // entry (language spec §8.2); defer it rather than rejecting at launch.
      if (produced.has(name)) continue;
      const value = vars[name];
      if (value === undefined) {
        throw new Error(
          `FOR loop references undefined variable "{{${name}}}". Define "${name}" as an array in .rundown/config.yaml or pass --input-file with an array value.`,
        );
      }
      if (toIterableSource(value) === null) {
        throw new Error(
          `FOR loop variable "{{${name}}}" is not iterable (got ${typeof value}). Define "${name}" as an array in .rundown/config.yaml or pass --input-file with an array value.`,
        );
      }
    }
  }
}
