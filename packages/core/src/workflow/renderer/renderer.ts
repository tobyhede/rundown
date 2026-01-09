import { type Step, type Action, type Transitions, type Substep, type Workflow, type NonRetryAction } from '../types.js';
import { stepIdToString } from '../step-id.js';

/**
 * Render an Action to its DSL string representation
 */
export function renderAction(action: Action): string {
  if (action.type === 'RETRY') {
    const actionStr = renderNonRetryAction(action.then);
    return `RETRY ${String(action.max)} ${actionStr}`;
  }
  return renderNonRetryAction(action);
}

function renderNonRetryAction(action: NonRetryAction): string {
  switch (action.type) {
    case 'CONTINUE':
      return 'CONTINUE';
    case 'COMPLETE':
      return 'COMPLETE';
    case 'STOP':
      return action.message ? `STOP "${action.message}"` : 'STOP';
    case 'GOTO':
      return `GOTO ${stepIdToString(action.target)}`;
  }
}

/**
 * Render Transitions to Markdown list items
 */
export function renderTransitions(transitions: Transitions): string {
  const lines: string[] = [];
  lines.push(`- PASS: ${renderAction(transitions.pass.action)}`);
  lines.push(`- FAIL: ${renderAction(transitions.fail.action)}`);
  return lines.join('\n');
}

/**
 * Render a Substep to Markdown
 * @param substep - The substep to render
 * @param parentStepNumber - The parent step number (undefined for dynamic parent)
 */
export function renderSubstep(substep: Substep, parentStepNumber: number | undefined): string {
  const prefix = parentStepNumber !== undefined ? String(parentStepNumber) : '{N}';
  const agentSuffix = substep.agentType ? ` (${substep.agentType})` : '';
  const workflowSuffix = substep.workflows?.length ? ` [@${substep.workflows.join(', ')}]` : '';
  return `### ${prefix}.${substep.id} ${substep.description}${agentSuffix}${workflowSuffix}`;
}

/**
 * Render a Step to its Markdown representation
 */
export function renderStep(step: Step): string {
  const lines: string[] = [];

  // Header - use {N} for dynamic, number for static
  const stepId = step.isDynamic ? '{N}' : String(step.number);
  lines.push(`## ${stepId}. ${step.description}`);
  lines.push('');

  // Workflows (step-level)
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

  // Substeps - pass undefined for dynamic parent
  if (step.substeps) {
    const parentNum = step.isDynamic ? undefined : step.number;
    for (const substep of step.substeps) {
      lines.push(renderSubstep(substep, parentNum));
      lines.push('');
    }
  }

  // Nested Workflow (deprecated but kept for backwards compatibility)
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  if (step.nestedWorkflow) {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    lines.push(`@${step.nestedWorkflow}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Render a full Workflow object to Markdown
 */
export function renderWorkflow(workflow: Workflow): string {
  const lines: string[] = [];

  if (workflow.title) {
    lines.push(`# ${workflow.title}`);
    lines.push('');
  }

  if (workflow.description) {
    lines.push(workflow.description);
    lines.push('');
  }

  for (const step of workflow.steps) {
    lines.push(renderStep(step));
    lines.push('');
  }

  return lines.join('\n').trim();
}
