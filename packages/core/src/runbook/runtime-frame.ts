import { isSourced, type ForClause, type ResolvedStep } from '@rundown-org/parser';
import { deriveExecutionAt } from './targeting.js';
import {
  assertResolvedVariableForContext,
  isJsonArray,
  isJsonArrayStream,
  type ForContext,
  type TemplateVarValue,
} from './types.js';

export type ExecutionVarValue = TemplateVarValue | boolean | null;
export type StepVariables = Record<string, ExecutionVarValue>;
export type TemplateVariables = Record<string, TemplateVarValue>;

export interface BuildStepVariablesInput {
  readonly stepId: string;
  readonly substepId?: string;
  readonly forStack?: readonly ForContext[];
  readonly forClause?: ForClause;
  readonly templateVars?: Readonly<Record<string, TemplateVarValue>>;
}

export function buildContextVars(
  vars: Readonly<Record<string, TemplateVarValue>>,
): Record<string, TemplateVarValue> {
  const contextVars: Record<string, TemplateVarValue> = {};
  for (const [key, value] of Object.entries(vars)) {
    contextVars[`context.vars.${key}`] = value;
  }
  return contextVars;
}

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

export function validateForVariables(
  steps: readonly ResolvedStep[],
  vars: Readonly<Partial<Record<string, TemplateVarValue>>>,
): void {
  for (const step of steps) {
    if (step.kind === 'for' && isSourced(step.forClause)) {
      const name = step.forClause.source;
      const value = vars[name];
      if (value === undefined) {
        throw new Error(
          `FOR loop references undefined variable "{{${name}}}". Define "${name}" as an array in .rundown/config.yaml or pass --input-file with an array value.`,
        );
      }
      if (!isJsonArray(value) && !isJsonArrayStream(value)) {
        throw new Error(
          `FOR loop variable "{{${name}}}" is not iterable (got ${typeof value}). Define "${name}" as an array in .rundown/config.yaml or pass --input-file with an array value.`,
        );
      }
    }
  }
}
