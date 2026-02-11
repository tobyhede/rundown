import {
  type Step,
  type Action,
  type Transitions,
  type TransitionObject,
  type Substep,
  type Runbook,
} from '../types.js';
import { stepIdToString } from '../step-id.js';

/**
 * Render an Action to DSL string.
 *
 * @param action - The action to render (CONTINUE, COMPLETE, STOP, GOTO, NEXT, BREAK)
 * @returns The DSL string representation of the action
 */
export function renderAction(action: Action): string {
  switch (action.type) {
    case 'CONTINUE':
      return 'CONTINUE';
    case 'COMPLETE':
      return action.message ? `COMPLETE "${action.message}"` : 'COMPLETE';
    case 'STOP':
      return action.message ? `STOP "${action.message}"` : 'STOP';
    case 'GOTO':
      return `GOTO ${stepIdToString(action.target)}`;
    case 'NEXT':
      return 'NEXT';
    case 'BREAK':
      return 'BREAK';
  }
}

/**
 * Render a single transition with its retry prefix if configured.
 */
function renderTransitionAction(transition: TransitionObject): string {
  const actionStr = renderAction(transition.action);
  if (transition.retry > 0) {
    return `RETRY ${String(transition.retry)} ${actionStr}`;
  }
  return actionStr;
}

/**
 * Render transitions block with retry prefix when configured.
 *
 * @param transitions - The transitions to render
 * @returns Markdown string with PASS/FAIL list items
 */
export function renderTransitions(transitions: Transitions): string {
  const lines: string[] = [];
  lines.push(`- PASS: ${renderTransitionAction(transitions.pass)}`);
  lines.push(`- FAIL: ${renderTransitionAction(transitions.fail)}`);
  return lines.join('\n');
}

/**
 * Render a Substep to Markdown.
 *
 * Generates an H3 header with the substep ID, description, optional
 * agent type suffix, and runbook references.
 *
 * @param substep - The Substep to render
 * @param parentStepName - The parent step name (e.g., "1", "ErrorHandler")
 * @returns Markdown H3 header string for the substep
 */
export function renderSubstep(substep: Substep, parentStepName: string): string {
  const agentSuffix = substep.agentType ? ` (${substep.agentType})` : '';
  const runbooksSuffix = substep.workflows?.length ? ` [@${substep.workflows.join(', ')}]` : '';
  return `### ${parentStepName}.${substep.id} ${substep.description}${agentSuffix}${runbooksSuffix}`;
}

/**
 * Render a Step to its Markdown representation.
 *
 * Generates complete Markdown for a step including header, child runbooks,
 * command block, prompt, transitions, substeps, and nested child runbooks.
 *
 * @param step - The Step to render
 * @returns Complete Markdown string for the step
 */
export function renderStep(step: Step): string {
  const lines: string[] = [];

  // Header - use step.name directly
  const stepId = step.name;
  lines.push(`## ${stepId}. ${step.description}`);
  lines.push('');

  // Child runbooks (step-level)
  if (step.workflows?.length) {
    for (const wf of step.workflows) {
      lines.push(` - ${wf}`);
    }
    lines.push('');
  }

  // Command
  if (step.command) {
    lines.push('```bash');
    lines.push(step.command.code);
    lines.push('```');
    lines.push('');
  }

  // Prompt
  if (step.prompt) {
    lines.push(step.prompt);
    lines.push('');
  }

  // Transitions
  if (step.transitions) {
    lines.push(renderTransitions(step.transitions));
    lines.push('');
  }

  // Substeps - use step.name directly as the parent prefix
  if (step.substeps) {
    for (const substep of step.substeps) {
      lines.push(renderSubstep(substep, step.name));
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

/**
 * Render a full Runbook object to Markdown.
 *
 * Generates complete Markdown for a runbook including title,
 * description, and all steps.
 *
 * @param runbook - The Runbook to render
 * @returns Complete Markdown string for the entire runbook
 */
export function renderRunbook(runbook: Runbook): string {
  const lines: string[] = [];

  if (runbook.title) {
    lines.push(`# ${runbook.title}`);
    lines.push('');
  }

  if (runbook.description) {
    lines.push(runbook.description);
    lines.push('');
  }

  for (const step of runbook.steps) {
    lines.push(renderStep(step));
    lines.push('');
  }

  return lines.join('\n').trim();
}
