import type { Step, Action, Transitions, TransitionObject, Substep, Runbook } from '../types.js';
import type { ForClause } from '@rundown-org/parser';
import { stepIdToString } from '../step-id.js';
import { renderCodeFence, renderHeading } from './primitives.js';

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
    case 'DEFER':
      return 'DEFER';
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
  const passAgg = transitions.modifierImplicit ? '' : transitions.all ? ' ALL' : ' ANY';
  const failAgg = transitions.modifierImplicit ? '' : transitions.all ? ' ANY' : ' ALL';
  lines.push(`- PASS${passAgg}: ${renderTransitionAction(transitions.pass)}`);
  lines.push(`- FAIL${failAgg}: ${renderTransitionAction(transitions.fail)}`);
  return lines.join('\n');
}

/**
 * Render a Substep to Markdown.
 *
 * Generates an H3 header with the substep ID, description,
 * and runbook references.
 *
 * @param substep - The Substep to render
 * @param parentStepName - The parent step name (e.g., "1", "ErrorHandler")
 * @returns Markdown H3 header string for the substep
 */
export function renderSubstep(substep: Substep, parentStepName: string): string {
  const lines: string[] = [];
  lines.push(renderHeading(3, `${parentStepName}.${substep.id}`, substep.description));
  if (substep.runbooks?.length) {
    lines.push('');
    for (const runbookPath of substep.runbooks) {
      lines.push(`- ${runbookPath}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render a FOR clause to its DSL bullet-point string.
 *
 * Handles all FOR variants: named/unnamed ranges, implicit start,
 * and data-source references (full and windowed). If transitions are
 * present, they are appended as indented nested bullets.
 *
 * @param forClause - The FOR clause to render
 * @returns Array of DSL strings (e.g., ["- FOR pass IN 1 TO 2", "  - PASS ANY: CONTINUE"])
 */
function renderForClause(forClause: ForClause): string[] {
  const lines: string[] = [];

  if (forClause.source !== undefined) {
    if (forClause.start === 1 && forClause.end === undefined) {
      lines.push(`- FOR ${forClause.variable} IN {{ ${forClause.source} }}`);
    } else {
      lines.push(
        `- FOR ${forClause.variable} IN ${String(forClause.start)} TO ${String(forClause.end)} OF {{ ${forClause.source} }}`,
      );
    }
  } else if (forClause.variable) {
    if (forClause.start === 1) {
      lines.push(`- FOR ${forClause.variable} IN ${String(forClause.end)}`);
    } else {
      lines.push(
        `- FOR ${forClause.variable} IN ${String(forClause.start)} TO ${String(forClause.end)}`,
      );
    }
  } else {
    if (forClause.start === 1) {
      lines.push(`- FOR ${String(forClause.end)}`);
    } else {
      lines.push(`- FOR ${String(forClause.start)} TO ${String(forClause.end)}`);
    }
  }

  const transitions = (forClause as { transitions?: Transitions }).transitions;
  if (transitions) {
    const passAgg = transitions.modifierImplicit ? '' : transitions.all ? ' ALL' : ' ANY';
    const failAgg = transitions.modifierImplicit ? '' : transitions.all ? ' ANY' : ' ALL';
    lines.push(`  - PASS${passAgg}: ${renderTransitionAction(transitions.pass)}`);
    lines.push(`  - FAIL${failAgg}: ${renderTransitionAction(transitions.fail)}`);
  }

  return lines;
}

function getShorthandRunbookSubsteps(step: Step): readonly Substep[] | undefined {
  if (step.kind !== 'substeps' && step.kind !== 'for') return undefined;
  if (step.substepsDerivedFromRunbookList !== true) return undefined;
  return step.substeps;
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
  lines.push(renderHeading(2, stepId, step.description, '. '));
  lines.push('');

  if (step.kind === 'for') {
    lines.push(...renderForClause(step.forClause));
  }

  // Transitions
  if (step.transitions) {
    lines.push(renderTransitions(step.transitions));
  }

  if (step.kind === 'for' || step.transitions) {
    lines.push('');
  }

  const shorthandSubsteps = getShorthandRunbookSubsteps(step);
  if (shorthandSubsteps?.length) {
    const firstPrompt = shorthandSubsteps[0]?.prompt;
    if (firstPrompt) {
      lines.push(firstPrompt);
      lines.push('');
    }
    for (const shorthandSubstep of shorthandSubsteps) {
      const runbookPath = shorthandSubstep.runbooks?.[0];
      if (!runbookPath) continue;
      lines.push(`- ${runbookPath}`);
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
  if (step.kind === 'command') {
    lines.push(renderCodeFence(step.command.code, step.command.lang ?? 'bash'));
    lines.push('');
  }

  // Substeps - use step.name directly as the parent prefix
  if (step.kind === 'substeps' || step.kind === 'for') {
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
