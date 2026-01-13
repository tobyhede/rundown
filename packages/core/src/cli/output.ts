import type { Step } from '../workflow/types.js';
import type { WorkflowMetadata, StepPosition, ActionBlockData } from './types.js';
import { renderStepForCLI } from './render.js';

const SEPARATOR = '-----';

/**
 * Format step position as n/N.
 *
 * Formats a StepPosition into a human-readable string like "1/5" or "2.1/5".
 *
 * @param pos - The StepPosition to format
 * @returns Formatted position string (e.g., "1/5", "2.1/5")
 */
export function formatPosition(pos: StepPosition): string {
  const stepPart = pos.substep
    ? `${pos.current}.${pos.substep}`
    : pos.current;
  return `${stepPart}/${String(pos.total)}`;
}

/**
 * Print separator line to stdout.
 *
 * Outputs a visual separator ("-----") for CLI output formatting.
 */
export function printSeparator(): void {
  console.log(SEPARATOR);
}

/**
 * Print metadata block to stdout.
 *
 * Outputs workflow metadata including file path, state, and optional prompt status.
 *
 * @param meta - The WorkflowMetadata to display
 */
export function printMetadata(meta: WorkflowMetadata): void {
  console.log(`File:     ${meta.file}`);
  console.log(`State:    ${meta.state}`);
  if (meta.prompted) {
    console.log(`Prompt:   Yes`);
  }
}

/**
 * Print action block to stdout.
 *
 * Outputs the action taken, optional source step position, and optional result.
 *
 * @param data - The ActionBlockData containing action details
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
 * Print step block to stdout.
 *
 * Outputs the step position and rendered step content.
 *
 * @param pos - The current step position
 * @param step - The Step to render and display
 */
export function printStepBlock(pos: StepPosition, step: Step): void {
  console.log('');
  console.log(`Step:     ${formatPosition(pos)}`);
  console.log('');
  console.log(renderStepForCLI(step));
}

/**
 * Print command execution prefix to stdout.
 *
 * Outputs the command that is about to be executed with a shell prompt prefix.
 *
 * @param command - The shell command to display
 */
export function printCommandExec(command: string): void {
  console.log('');
  console.log(`$ ${command}`);
  console.log('');
}

/**
 * Print workflow complete message to stdout.
 *
 * Outputs a message indicating the workflow has completed successfully.
 *
 * @param message - Optional completion message to display
 */
export function printWorkflowComplete(message?: string): void {
  console.log('');
  if (message) {
    console.log(`Workflow complete: ${message}`);
  } else {
    console.log('Workflow complete.');
  }
}

/**
 * Print workflow stopped message to stdout.
 *
 * Outputs a message indicating the workflow has been stopped.
 *
 * @param message - Optional stop message to display
 */
export function printWorkflowStopped(message?: string): void {
  console.log('');
  if (message) {
    console.log(`Workflow stopped: ${message}`);
  } else {
    console.log('Workflow stopped.');
  }
}

/**
 * Print workflow stopped message with step position to stdout.
 *
 * Outputs a message indicating the workflow was stopped at a specific step.
 *
 * @param pos - The step position where the workflow was stopped
 * @param message - Optional stop message to display
 */
export function printWorkflowStoppedAtStep(pos: StepPosition, message?: string): void {
  console.log('');
  const stepStr = pos.substep
    ? `${pos.current}.${pos.substep}`
    : pos.current;
  if (message) {
    console.log(`Workflow stopped at step ${stepStr}: ${message}`);
  } else {
    console.log(`Workflow stopped at step ${stepStr}.`);
  }
}

/**
 * Print workflow stashed message to stdout.
 *
 * Outputs a message indicating the workflow has been stashed at the given position.
 *
 * @param pos - The step position where the workflow was stashed
 */
export function printWorkflowStashed(pos: StepPosition): void {
  console.log('');
  console.log(`Step:     ${formatPosition(pos)}`);
  console.log('');
  console.log('Workflow stashed.');
}

/**
 * Print no active workflow message to stdout.
 *
 * Outputs a message indicating there is no currently active workflow.
 */
export function printNoActiveWorkflow(): void {
  console.log('No active workflow.');
}

/**
 * Print no workflows message to stdout.
 *
 * Outputs a message indicating there are no workflows available.
 */
export function printNoWorkflows(): void {
  console.log('No workflows.');
}

/**
 * Print workflow list entry to stdout.
 *
 * Outputs a single line for a workflow in the list format.
 *
 * @param id - The workflow state ID
 * @param status - The current status (e.g., 'running', 'stopped')
 * @param step - The current step position
 * @param file - The workflow source file path
 * @param title - Optional workflow title
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
