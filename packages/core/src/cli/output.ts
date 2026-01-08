import type { Step } from '../workflow/types.js';
import type { WorkflowMetadata, StepPosition, ActionBlockData } from './types.js';
import { renderStepForCLI } from './render.js';

const SEPARATOR = '-----';

/**
 * Format step position as n/N
 */
export function formatPosition(pos: StepPosition): string {
  const stepPart = pos.substep
    ? `${String(pos.current)}.${pos.substep}`
    : String(pos.current);
  return `${stepPart}/${String(pos.total)}`;
}

/**
 * Print separator line
 */
export function printSeparator(): void {
  console.log(SEPARATOR);
}

/**
 * Print metadata block
 */
export function printMetadata(meta: WorkflowMetadata): void {
  console.log(`File:     ${meta.file}`);
  console.log(`State:    ${meta.state}`);
  if (meta.prompted) {
    console.log(`Prompt:   Yes`);
  }
}

/**
 * Print action block (Action, optional From, optional Result)
 */
export function printActionBlock(data: ActionBlockData): void {
  console.log(`Action:   ${data.action}`);
  if (data.from) {
    console.log(`From:     ${formatPosition(data.from)}`);
  }
  if (data.result) {
    console.log(`Result:   ${data.result}`);
  }
}

/**
 * Print step block (position + content)
 */
export function printStepBlock(pos: StepPosition, step: Step): void {
  console.log('');
  console.log(`Step:     ${formatPosition(pos)}`);
  console.log('');
  console.log(renderStepForCLI(step));
}

/**
 * Print command execution prefix (default mode only)
 */
export function printCommandExec(command: string): void {
  console.log('');
  console.log(`$ ${command}`);
  console.log('');
}

/**
 * Print workflow complete message
 */
export function printWorkflowComplete(): void {
  console.log('');
  console.log('Workflow complete.');
}

/**
 * Print workflow stopped message
 */
export function printWorkflowStopped(): void {
  console.log('');
  console.log('Workflow stopped.');
}

/**
 * Print workflow stopped message with step position
 */
export function printWorkflowStoppedAtStep(pos: StepPosition): void {
  console.log('');
  const stepStr = pos.substep
    ? `${String(pos.current)}.${pos.substep}`
    : String(pos.current);
  console.log(`Workflow stopped at step ${stepStr}.`);
}

/**
 * Print workflow stashed message (includes step position)
 */
export function printWorkflowStashed(pos: StepPosition): void {
  console.log('');
  console.log(`Step:     ${formatPosition(pos)}`);
  console.log('');
  console.log('Workflow stashed.');
}

/**
 * Print no active workflow message
 */
export function printNoActiveWorkflow(): void {
  console.log('No active workflow.');
}

/**
 * Print no workflows message
 */
export function printNoWorkflows(): void {
  console.log('No workflows.');
}

/**
 * Print workflow list entry
 */
export function printWorkflowListEntry(
  id: string,
  status: string,
  step: string,
  file: string,
  title?: string
): void {
  const titleStr = title ? `  [${title}]` : '';
  console.log(`${id}  ${status}  ${step}  ${file}${titleStr}`);
}
