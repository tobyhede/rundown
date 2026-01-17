import type { Step, Substep } from '../runbook/types.js';
import { isNumberedStepName } from '../runbook/step-utils.js';
import type { RunbookMetadata, StepPosition, ActionBlockData } from './types.js';
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
 * Format step position as n/N or n/* for dynamic runbooks.
 *
 * Formats a StepPosition into a human-readable string like "1/5" or "2.1/5".
 * For dynamic runbooks (total is '{N}'), shows asterisk to indicate unbounded.
 * For named steps (non-numeric like "RECOVER"), omits the total.
 *
 * @param pos - The StepPosition to format
 * @returns Formatted position string (e.g., "1/5", "2.1/5", "1.2/*", "RECOVER")
 */
export function formatPosition(pos: StepPosition): string {
  const stepPart = pos.substep ? `${pos.current}.${pos.substep}` : pos.current;
  // For named steps (non-numeric), don't show total
  if (!isNumberedStepName(pos.current)) {
    return stepPart;
  }
  // For dynamic runbooks, show instance number + asterisk to indicate unbounded
  if (pos.total === '{N}') {
    return `${stepPart}/${pos.current}*`;
  }
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
 * Outputs runbook metadata including file path, state, and optional prompt status.
 *
 * @param meta - The RunbookMetadata to display
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printMetadata(
  meta: RunbookMetadata,
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
 * Print runbook complete message to stdout.
 *
 * Outputs a message indicating the runbook has completed successfully.
 *
 * @param message - Optional completion message to display
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printRunbookComplete(
  message?: string,
  writer: OutputWriter = getWriter()
): void {
  writer.writeLine(`Runbook:  ${success('COMPLETE')}`);
}

/**
 * Print runbook stopped message to stdout.
 *
 * Outputs a message indicating the runbook has been stopped.
 *
 * @param message - Optional stop message to display
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printRunbookStopped(
  message?: string,
  writer: OutputWriter = getWriter()
): void {
  writer.writeLine(`Runbook:  ${failure('STOP')}`);
}

/**
 * Print runbook stopped message with step position to stdout.
 *
 * Outputs a message indicating the runbook was stopped at a specific step.
 *
 * @param pos - The step position where the runbook was stopped
 * @param message - Optional stop message to display
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printRunbookStoppedAtStep(
  pos: StepPosition,
  message?: string,
  writer: OutputWriter = getWriter()
): void {
  writer.writeLine(`Runbook:  ${failure('STOP')}`);
}

/**
 * Print runbook stashed message to stdout.
 *
 * Outputs a message indicating the runbook has been stashed at the given position.
 *
 * @param pos - The step position where the runbook was stashed
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printRunbookStashed(
  pos: StepPosition,
  writer: OutputWriter = getWriter()
): void {
  writer.writeLine('');
  writer.writeLine(`Step:     ${info(formatPosition(pos))}`);
  writer.writeLine('');
  writer.writeLine(`Runbook:  ${warning('STASHED')}`);
}

/**
 * Print no active runbook message to stdout.
 *
 * Outputs a message indicating there is no currently active runbook.
 *
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printNoActiveRunbook(
  writer: OutputWriter = getWriter()
): void {
  writer.writeLine(dim('No active runbook.'));
}

/**
 * Print no runbooks message to stdout.
 *
 * Outputs a message indicating there are no runbooks available.
 *
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printNoRunbooks(writer: OutputWriter = getWriter()): void {
  writer.writeLine(dim('No runbooks.'));
}

/**
 * Print runbook list entry to stdout.
 *
 * Outputs a single line for a runbook in the list format.
 *
 * @param id - The runbook state ID
 * @param status - The current status (e.g., 'running', 'stopped')
 * @param step - The current step position
 * @param file - The runbook source file path
 * @param title - Optional runbook title
 * @param writer - OutputWriter to use (defaults to global writer)
 */
export function printRunbookListEntry(
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
