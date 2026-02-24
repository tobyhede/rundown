import type { Step, Action, Transitions, TransitionObject, Substep, Runbook } from '../types.js';
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
  const passAgg = transitions.all ? ' ALL' : ' ANY';
  const failAgg = transitions.all ? ' ANY' : ' ALL';
  lines.push(`- PASS${passAgg}: ${renderTransitionAction(transitions.pass)}`);
  lines.push(`- FAIL${failAgg}: ${renderTransitionAction(transitions.fail)}`);
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
  const lines: string[] = [];
  lines.push(`### ${parentStepName}.${substep.id} ${substep.description}${agentSuffix}`);
  if (substep.workflows?.length) {
    lines.push('');
    for (const wf of substep.workflows) {
      lines.push(`- ${wf}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render a FOR clause to its DSL bullet-point string.
 *
 * Handles all FOR variants: named/unnamed ranges, implicit start,
 * and data-source references (full and windowed).
 *
 * @param forClause - The FOR clause to render
 * @returns DSL string (e.g., "- FOR pass IN 1 TO 2")
 */
function renderForClause(forClause: NonNullable<Step['forClause']>): string {
  if (forClause.source !== undefined) {
    if (forClause.start === 1 && forClause.end === undefined) {
      return `- FOR ${forClause.variable} IN {{ ${forClause.source} }}`;
    }
    return `- FOR ${forClause.variable} IN ${String(forClause.start)} TO ${String(forClause.end)} OF {{ ${forClause.source} }}`;
  }

  if (forClause.variable) {
    if (forClause.start === 1) {
      return `- FOR ${forClause.variable} IN ${String(forClause.end)}`;
    }
    return `- FOR ${forClause.variable} IN ${String(forClause.start)} TO ${String(forClause.end)}`;
  }

  if (forClause.start === 1) {
    return `- FOR ${String(forClause.end)}`;
  }
  return `- FOR ${String(forClause.start)} TO ${String(forClause.end)}`;
}

/**
 * Detect whether a step's single substep is a synthetic workflow-only substep
 * created by the parser's shorthand canonicalization.
 *
 * Returns the substep if all five conditions hold:
 * 1. Step has exactly one substep
 * 2. Substep ID is "1"
 * 3. Substep has workflows
 * 4. Substep has no command, transitions, or agentType
 * 5. Substep description is empty
 *
 * @param step - The step to inspect
 * @returns The shorthand substep, or null if not shorthand
 */
function getShorthandWorkflowSubstep(step: Step): Substep | null {
  if (step.substeps?.length !== 1) return null;
  const candidate = step.substeps[0];
  if (candidate.id !== '1') return null;
  if (!candidate.workflows?.length) return null;
  if (candidate.command || candidate.transitions || candidate.agentType) return null;
  if (candidate.description !== '') return null;
  return candidate;
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

  if (step.forClause) {
    lines.push(renderForClause(step.forClause));
  }

  // Transitions
  if (step.transitions) {
    lines.push(renderTransitions(step.transitions));
  }

  if (step.forClause || step.transitions) {
    lines.push('');
  }

  const shorthandSubstep = getShorthandWorkflowSubstep(step);
  if (shorthandSubstep) {
    if (shorthandSubstep.prompt) {
      lines.push(shorthandSubstep.prompt);
      lines.push('');
    }
    for (const wf of shorthandSubstep.workflows ?? []) {
      lines.push(`- ${wf}`);
    }
    lines.push('');
    return lines.join('\n').trim();
  }

  // Prompt
  if (step.prompt) {
    lines.push(step.prompt);
    lines.push('');
  }

  // Command
  if (step.command) {
    lines.push('```bash');
    lines.push(step.command.code);
    lines.push('```');
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
