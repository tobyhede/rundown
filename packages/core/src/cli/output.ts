import type { Step, Substep } from '../workflow/types.js';
import type { WorkflowMetadata, StepPosition, ActionBlockData } from './types.js';
import type { OutputWriter } from './writer.js';
import { getWriter } from './context.js';
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
  const stepPart = pos.substep ? `${pos.current}.${pos.substep}` : pos.current;
  return `${stepPart}/${String(pos.total)}`;
}

/**
 * Print separator line to stdout.
 *
 * Outputs a visual separator ("-----") for CLI output formatting.
 *
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printSeparator(writer: OutputWriter = getWriter()): void {
  writer.writeLine(SEPARATOR);
}

/**
 * Print metadata block to stdout.
 *
 * Outputs workflow metadata including file path, state, and optional prompt status.
 *
 * @param meta - The WorkflowMetadata to display
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printMetadata(
  meta: WorkflowMetadata,
  writer: OutputWriter = getWriter()
): void {
  writer.writeLine(`File:     ${meta.file}`);
  writer.writeLine(`State:    ${meta.state}`);
  if (meta.prompted) {
    writer.writeLine(`Prompt:   Yes`);
  }
}

/**
 * Print action block to stdout.
 *
 * Outputs the action taken, optional source step position, and optional result.
 *
 * @param data - The ActionBlockData containing action details
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printActionBlock(
  data: ActionBlockData,
  writer: OutputWriter = getWriter()
): void {
  writer.writeLine(`Action:   ${data.action}`);
  if (data.from) {
    writer.writeLine(`From:     ${formatPosition(data.from)}`);
  }
  if (data.result) {
    writer.writeLine(`Result:   ${data.result}`);
  }
}

/**
 * Print step or substep block to stdout.
 *
 * Outputs the step position and rendered content for the current item.
 * For dynamic items, substitutes {N} and {n} with the actual instance/substep numbers.
 *
 * @param pos - The current step position
 * @param item - The Step or Substep to render and display
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printStepBlock(
  pos: StepPosition,
  item: Step | Substep,
  writer: OutputWriter = getWriter()
): void {
  writer.writeLine('');
  writer.writeLine(`Step:     ${formatPosition(pos)}`);
  writer.writeLine('');
  writer.writeLine(renderStepForCLI(item, pos.current, pos.substep));
}

/**
 * Print command execution prefix to stdout.
 *
 * Outputs the command that is about to be executed with a shell prompt prefix.
 *
 * @param command - The shell command to display
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printCommandExec(
  command: string,
  writer: OutputWriter = getWriter()
): void {
  writer.writeLine('');
  writer.writeLine(`$ ${command}`);
  writer.writeLine('');
}

/**
 * Print workflow complete message to stdout.
 *
 * Outputs a message indicating the workflow has completed successfully.
 *
 * @param message - Optional completion message to display
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printWorkflowComplete(
  message?: string,
  writer: OutputWriter = getWriter()
): void {
  writer.writeLine('');
  if (message) {
    writer.writeLine(`Workflow complete: ${message}`);
  } else {
    writer.writeLine('Workflow complete.');
  }
}

/**
 * Print workflow stopped message to stdout.
 *
 * Outputs a message indicating the workflow has been stopped.
 *
 * @param message - Optional stop message to display
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printWorkflowStopped(
  message?: string,
  writer: OutputWriter = getWriter()
): void {
  writer.writeLine('');
  if (message) {
    writer.writeLine(`Workflow stopped: ${message}`);
  } else {
    writer.writeLine('Workflow stopped.');
  }
}

/**
 * Print workflow stopped message with step position to stdout.
 *
 * Outputs a message indicating the workflow was stopped at a specific step.
 *
 * @param pos - The step position where the workflow was stopped
 * @param message - Optional stop message to display
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printWorkflowStoppedAtStep(
  pos: StepPosition,
  message?: string,
  writer: OutputWriter = getWriter()
): void {
  writer.writeLine('');
  const stepStr = pos.substep ? `${pos.current}.${pos.substep}` : pos.current;
  if (message) {
    writer.writeLine(`Workflow stopped at step ${stepStr}: ${message}`);
  } else {
    writer.writeLine(`Workflow stopped at step ${stepStr}.`);
  }
}

/**
 * Print workflow stashed message to stdout.
 *
 * Outputs a message indicating the workflow has been stashed at the given position.
 *
 * @param pos - The step position where the workflow was stashed
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printWorkflowStashed(
  pos: StepPosition,
  writer: OutputWriter = getWriter()
): void {
  writer.writeLine('');
  writer.writeLine(`Step:     ${formatPosition(pos)}`);
  writer.writeLine('');
  writer.writeLine('Workflow stashed.');
}

/**
 * Print no active workflow message to stdout.
 *
 * Outputs a message indicating there is no currently active workflow.
 *
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printNoActiveWorkflow(
  writer: OutputWriter = getWriter()
): void {
  writer.writeLine('No active workflow.');
}

/**
 * Print no workflows message to stdout.
 *
 * Outputs a message indicating there are no workflows available.
 *
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printNoWorkflows(writer: OutputWriter = getWriter()): void {
  writer.writeLine('No workflows.');
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
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printWorkflowListEntry(
  id: string,
  status: string,
  step: string,
  file: string,
  title?: string,
  writer: OutputWriter = getWriter()
): void {
  const titleStr = title ? `  [${title}]` : '';
  writer.writeLine(`${id}  ${status}  ${step}  ${file}${titleStr}`);
}
