import type { Step, Substep } from '../workflow/types.js';
import type { WorkflowMetadata, StepPosition, ActionBlockData } from './types.js';
import type { OutputWriter } from './writer.js';
import { getWriter } from './context.js';
import { renderStepForCLI } from './render.js';
import {
  success,
  failure,
  warning,
  info,
  dim,
  colorizeStatus,
  colorizeResult,
} from './colors.js';

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
  writer.writeLine(dim(SEPARATOR));
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
  writer.writeLine(`State:    ${colorizeStatus(meta.state)}`);
  if (meta.prompted) {
    writer.writeLine(`Prompt:   ${success('Yes')}`);
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
  writer.writeLine(`Action:   ${info(data.action)}`);
  if (data.from) {
    writer.writeLine(`From:     ${formatPosition(data.from)}`);
  }
  if (data.result) {
    writer.writeLine(`Result:   ${colorizeResult(data.result)}`);
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
  writer.writeLine(`Step:     ${info(formatPosition(pos))}`);
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
    writer.writeLine(`${success('Runbook:')}  ${success('COMPLETE')} (${message})`);
  } else {
    writer.writeLine(`${success('Runbook:')}  ${success('COMPLETE')}`);
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
    writer.writeLine(`${failure('Runbook:')}  ${failure('STOPPED')} (${message})`);
  } else {
    writer.writeLine(`${failure('Runbook:')}  ${failure('STOPPED')}`);
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
    writer.writeLine(`${failure('Runbook:')}  ${failure('STOPPED')} (step ${stepStr}: ${message})`);
  } else {
    writer.writeLine(`${failure('Runbook:')}  ${failure('STOPPED')} (step ${stepStr})`);
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
  writer.writeLine(`Step:     ${info(formatPosition(pos))}`);
  writer.writeLine('');
  writer.writeLine(`${warning('Runbook:')}  ${warning('STASHED')}`);
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
  writer.writeLine(dim('No active runbook.'));
}

/**
 * Print no workflows message to stdout.
 *
 * Outputs a message indicating there are no workflows available.
 *
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printNoWorkflows(writer: OutputWriter = getWriter()): void {
  writer.writeLine(dim('No runbooks.'));
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
  writer.writeLine(`${id}  ${colorizeStatus(status)}  ${step}  ${file}${titleStr}`);
}
