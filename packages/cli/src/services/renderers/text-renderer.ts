/**
 * TextRenderer - Renders output events as human-readable text.
 *
 * Uses the existing print functions from `@rundown-org/core` for consistent
 * formatting with the established CLI style.
 *
 * @module renderers/text-renderer
 */

import {
  type OutputEvent,
  type OutputWriter,
  type StepPosition,
  type RunbookEventV1,
  type ActionBlockData,
  type Step,
  type Substep,
  type ResolveSourceInfo,
  getWriter,
  printMetadata,
  printActionBlock,
  printStepSeparator,
  printStepBlock,
  printRunbookComplete,
  printRunbookStopped,
  printRunbookStoppedAtStep,
  printRunbookStashed,
  printNoActiveRunbook,
  printCommandExec,
  printPolicyDenied,
  formatStepNumber,
  formatTransitionAction,
  success,
  failure,
  warning,
  info,
  dim,
} from '@rundown-org/core';
import { formatTable } from '../../helpers/table-formatter.js';
import type { OutputRenderer, RendererOptions } from './types.js';

/** Data shape for status detail rendering. */
interface StatusDetailData {
  active?: boolean;
  stashed?: boolean;
  file?: string;
  state?: string;
  prompted?: boolean;
  position?: {
    current: string;
    total: number;
    substep?: string;
    frameKey?: string;
    entry?: number;
    unresolved?: number;
  };
  step?: { name: string; description?: string };
  lastAction?: { action: string; result?: 'PASS' | 'FAIL' };
  pending?: string[];
  delegations?: { substep: string; runbook: string; state: string; childRunId?: string }[];
}

/**
 * Renders output events as human-readable text.
 *
 * Uses established CLI formatting conventions:
 * - Key-value pairs for detail views
 * - ASCII tables for lists
 * - Color-coded messages by level
 */
export class TextRenderer implements OutputRenderer {
  private writer: OutputWriter;

  /**
   * Create a new TextRenderer.
   *
   * @param options - Renderer configuration options
   */
  constructor(options: RendererOptions = {}) {
    this.writer = options.writer ?? getWriter();
  }

  /**
   * Render an output event as text.
   *
   * @param event - The output event to render
   */
  render(event: OutputEvent): void {
    switch (event.type) {
      case 'list':
        this.renderList(event);
        break;
      case 'detail':
        this.renderDetail(event);
        break;
      case 'metadata':
        printMetadata(event.metadata, this.writer);
        break;
      case 'status':
        this.renderStatus(event);
        break;
      case 'action':
        if (event.block.at) {
          printStepSeparator(event.block.at, this.writer);
        }
        printActionBlock(event.block, this.writer);
        break;
      case 'step_separator':
        printStepSeparator(formatStepNumber(event.position), this.writer);
        break;
      case 'message':
        this.renderMessage(event);
        break;
      case 'error':
        this.renderError(event);
        break;
      case 'complete':
        printRunbookComplete(event.message, this.writer);
        break;
      case 'stopped':
        printRunbookStopped(event.message, this.writer);
        break;
      case 'no_active_runbook':
        printNoActiveRunbook(this.writer);
        break;
      case 'execution_event':
        this.renderExecutionEvent(event.event);
        break;
    }
  }

  /**
   * Flush buffered output (no-op for text renderer).
   */
  flush(): void {
    // Text renderer outputs immediately, no buffering needed
  }

  /**
   * Render a list event as an ASCII table.
   * @param event - The list output event containing items and column definitions
   */
  private renderList(event: OutputEvent & { type: 'list' }): void {
    if (event.items.length === 0) {
      if (event.emptyMessage) {
        this.writer.writeLine(event.emptyMessage);
      }
      return;
    }

    // Convert ColumnDef to the format expected by formatTable
    // ColumnDef.key can be a string key or a function
    // Column expects key (string) or get (function) as separate properties
    // Use Record<string, unknown> as the generic type to avoid type narrowing issues
    type Row = Record<string, unknown>;
    const columns = event.columns.map((col) => {
      if (typeof col.key === 'function') {
        return {
          header: col.header,
          get: col.key as (row: Row) => string | number | boolean | undefined,
          align: col.align,
        };
      }
      return {
        header: col.header,
        key: col.key as keyof Row,
        align: col.align,
      };
    });

    const lines = formatTable(event.items as Row[], columns);
    this.writer.writeLines(lines);
  }

  /**
   * Render a detail event based on format type.
   *
   * Different formats receive specialized rendering:
   * - 'status': Runbook status (uses printMetadata, printStepBlock)
   * - 'scenario': Scenario details (aligned key-value pairs)
   * - 'scenario_result': Scenario run result (with color)
   * - 'echo': Echo command result (output or error)
   * - 'prompt': Prompt content wrapped in markdown fences
   * - 'check': Runbook validation result (PASS/FAIL with stats)
   * - 'custom': Generic key-value rendering
   * @param event - The detail output event with format type and data payload
   */
  private renderDetail(event: OutputEvent & { type: 'detail' }): void {
    const { data, format } = event;

    switch (format) {
      case 'status':
        this.renderStatusDetail(data);
        break;
      case 'scenario':
        this.renderScenarioDetail(data);
        break;
      case 'scenario_result':
        this.renderScenarioResult(data);
        break;
      case 'echo':
        this.renderEchoDetail(data);
        break;
      case 'prompt':
        this.renderPromptDetail(data);
        break;
      case 'check':
        this.renderCheckDetail(data);
        break;
      case 'resolve':
        this.renderResolveDetail(data);
        break;
      default:
        this.renderGenericDetail(data);
    }
  }

  /**
   * Render status response as formatted text.
   * @param data - Status data including active/stashed state, position, and step details
   */
  private renderStatusDetail(data: Record<string, unknown>): void {
    const {
      active,
      stashed,
      file,
      state,
      prompted,
      position,
      step,
      lastAction,
      pending,
      delegations,
    } = data as StatusDetailData;

    // No active runbook
    if (!active && !stashed) {
      printNoActiveRunbook(this.writer);
      return;
    }

    // Stashed only (no active)
    if (!active && stashed && position) {
      if (file || state) {
        printMetadata(
          { file: file ?? 'unknown', state: state ?? 'unknown', prompted },
          this.writer,
        );
      }
      printRunbookStashed(position, this.writer);
      return;
    }

    // Active runbook
    if (file || state) {
      printMetadata({ file: file ?? 'unknown', state: state ?? 'unknown', prompted }, this.writer);
    }

    // Print action block if lastAction exists
    if (lastAction) {
      printActionBlock(lastAction, this.writer);
    }

    // Print step block if we have position and step details
    if (position && step) {
      const stepObj = { name: step.name, description: step.description } as Step;
      printStepBlock(position, stepObj, !!prompted, this.writer);
    }
    if (position?.entry !== undefined || position?.unresolved !== undefined) {
      this.writer.writeLine('');
      if (position.entry !== undefined) {
        this.writer.writeLine(`Entry: ${String(position.entry)}`);
      }
      if (position.unresolved !== undefined) {
        this.writer.writeLine(`Unresolved: ${String(position.unresolved)}`);
      }
    }

    // Show pending steps
    if (pending && pending.length > 0) {
      this.writer.writeLine(`\nPending: ${pending.join(', ')}`);
    }

    // Show delegations
    if (delegations && delegations.length > 0) {
      this.writer.writeLine('\nDelegations:');
      for (const d of delegations) {
        let stateLabel: string;
        if (d.state === 'claimed') {
          stateLabel = `(claimed: ${d.childRunId ?? 'unknown'})`;
        } else if (d.state === 'cancelled') {
          stateLabel = '(cancelled)';
        } else {
          stateLabel = '(pending claim)';
        }
        this.writer.writeLine(`  ${d.substep}  ${d.runbook}  DELEGATED  ${stateLabel}`);
      }
    }
  }

  /**
   * Render scenario details with aligned keys.
   * @param data - Scenario data with name, description, expected result, commands, and tags
   */
  private renderScenarioDetail(data: Record<string, unknown>): void {
    const { name, description, expected, commands, tags } = data as {
      name?: string;
      description?: string;
      expected?: string;
      commands?: string[];
      tags?: string[];
    };

    // Aligned keys (12 chars = "Description:")
    if (name) {
      this.writer.writeLine(`Name:        ${name}`);
    }
    if (description) {
      this.writer.writeLine(`Description: ${description}`);
    }
    if (expected) {
      this.writer.writeLine(`Expected:    ${expected}`);
    }
    if (tags && tags.length > 0) {
      this.writer.writeLine(`Tags:        ${tags.join(', ')}`);
    }
    if (commands && commands.length > 0) {
      this.writer.writeLine('Commands:');
      for (const cmd of commands) {
        this.writer.writeLine(`  $ ${cmd}`);
      }
    }
  }

  /**
   * Render scenario run result with color.
   * @param data - Result data with pass/fail status, expected, and actual outcome
   */
  private renderScenarioResult(data: Record<string, unknown>): void {
    const { result, expected, actual } = data as {
      result?: boolean;
      expected?: string;
      actual?: string;
    };

    // Show final status line (colorized)
    if (actual) {
      const statusColor = result ? success : failure;
      this.writer.writeLine(`Scenario: ${statusColor(actual)}`);
    }

    // If failed, show expected vs actual
    if (result === false && expected && actual) {
      this.writer.writeLine(`  Expected: ${expected}`);
      this.writer.writeLine(`  Actual:   ${actual}`);
    }
  }

  /**
   * Render echo command result.
   *
   * In text mode:
   * - If there's output, print it as plain text
   * - If there's an error, print it to stderr with error formatting
   * @param data - Echo result data with optional output and error fields
   */
  private renderEchoDetail(data: Record<string, unknown>): void {
    const { output, error } = data as {
      result?: boolean;
      output?: string;
      error?: string;
      exitCode?: number;
    };

    // Print error to stderr if present
    if (error) {
      this.writer.writeError(failure(`Error: ${error}`));
      return;
    }

    // Print output as plain text if present
    if (output) {
      this.writer.writeLine(output);
    }
  }

  /**
   * Render prompt content wrapped in markdown fences.
   * @param data - Prompt data with output content to display
   */
  private renderPromptDetail(data: Record<string, unknown>): void {
    const { output } = data as { output?: string };
    if (output) {
      this.writer.writeLine('```');
      this.writer.writeLine(output);
      this.writer.writeLine('```');
    }
  }

  /**
   * Render shared PASS/FAIL + errors + warnings for structural validation results.
   *
   * Used by both `renderCheckDetail` and `renderResolveDetail` for the common
   * structural result rendering (validity line, error details, warning lines).
   * @param data - Structural result data with validity flag, stats, errors, and warnings
   * @param data.valid - Whether the structural validation passed
   * @param data.stats - Step and substep counts
   * @param data.stats.steps - Number of steps found
   * @param data.stats.substeps - Number of substeps found
   * @param data.errors - Array of validation errors with optional line numbers
   * @param data.warnings - Array of validation warnings with optional line numbers
   */
  private renderStructuralResult(data: {
    valid?: boolean;
    stats?: { steps?: number; substeps?: number };
    errors?: { line?: number; message: string }[];
    warnings?: { line?: number; message: string }[];
  }): void {
    const { valid, stats, errors, warnings } = data;

    if (valid) {
      const stepCount = stats?.steps ?? 0;
      const substepCount = stats?.substeps ?? 0;
      const statsMessage =
        substepCount > 0
          ? `PASS: ${String(stepCount)} step${stepCount !== 1 ? 's' : ''}, ${String(substepCount)} substep${substepCount !== 1 ? 's' : ''}`
          : `PASS: ${String(stepCount)} step${stepCount !== 1 ? 's' : ''}`;
      this.writer.writeLine(success(statsMessage));
    } else if (errors && errors.length > 0) {
      const errorCount = errors.length;
      this.writer.writeLine(
        failure(`FAIL: ${String(errorCount)} error${errorCount !== 1 ? 's' : ''}`),
      );
      for (const err of errors) {
        const linePrefix = err.line ? `Line ${String(err.line)}: ` : '';
        this.writer.writeLine(`  ${linePrefix}${err.message}`);
      }
    }

    if (warnings && warnings.length > 0) {
      for (const w of warnings) {
        const linePrefix = w.line ? `Line ${String(w.line)}: ` : '';
        this.writer.writeLine(warning(`  Warning: ${linePrefix}${w.message}`));
      }
    }
  }

  /**
   * Render runbook check/validation result.
   *
   * Formats as "PASS: N steps, M substeps" or "FAIL: N errors".
   * Warnings are not included in the summary line but are rendered as
   * separate lines below the summary when present.
   * @param data - Check result data with validity flag, stats, errors, and warnings
   */
  private renderCheckDetail(data: Record<string, unknown>): void {
    const { valid, stats, errors, warnings } = data as {
      valid?: boolean;
      stats?: { steps?: number; substeps?: number };
      errors?: { line?: number; message: string }[];
      warnings?: { line?: number; message: string }[];
    };

    this.renderStructuralResult({ valid, stats, errors, warnings });
  }

  /**
   * Render resolve command result.
   *
   * Shows structural validation result, resolved variables, data sources,
   * and unresolved variable warnings.
   * @param data - Resolve result data
   */
  private renderResolveDetail(data: Record<string, unknown>): void {
    const { valid, stats, errors, warnings, variables, sources, unresolved } = data as {
      valid?: boolean;
      stats?: { steps?: number; substeps?: number };
      errors?: { line?: number; message: string }[];
      warnings?: { line?: number; message: string; kind?: string }[];
      variables?: Record<string, string>;
      sources?: Record<string, ResolveSourceInfo>;
      unresolved?: string[];
    };

    // Structural result (same as check) — pass only structural warnings (no kind)
    const structuralWarnings = warnings?.filter((w) => !w.kind);
    this.renderStructuralResult({ valid, stats, errors, warnings: structuralWarnings });

    // Variables section
    if (variables && Object.keys(variables).length > 0) {
      this.writer.writeLine('');
      this.writer.writeLine('Variables:');
      const maxKeyLen = Math.max(...Object.keys(variables).map((k) => k.length));
      for (const [key, value] of Object.entries(variables)) {
        this.writer.writeLine(`  ${key.padEnd(maxKeyLen + 2)}${value}`);
      }
    }

    // Sources section
    if (sources && Object.keys(sources).length > 0) {
      this.writer.writeLine('');
      this.writer.writeLine('Sources:');
      const maxKeyLen = Math.max(...Object.keys(sources).map((k) => k.length));
      for (const [key, info] of Object.entries(sources)) {
        let desc: string;
        if (info.kind === 'array') {
          desc = `array (${String(info.items)} item${info.items !== 1 ? 's' : ''})`;
        } else {
          desc = `file (${info.path}, ${info.format})`;
        }
        this.writer.writeLine(`  ${key.padEnd(maxKeyLen + 2)}${desc}`);
      }
    }

    // Unresolved variables
    if (unresolved && unresolved.length > 0) {
      this.writer.writeLine('');
      this.writer.writeLine('Unresolved:');
      for (const name of unresolved) {
        this.writer.writeLine(warning(`  {{${name}}}`));
      }
    }

    // Warnings (excluding unresolved, which are shown above)
    if (warnings && warnings.length > 0) {
      // Filter out unresolved (shown in Unresolved section) and structural (shown via renderStructuralResult)
      const otherWarnings = warnings.filter((w) => w.kind !== undefined && w.kind !== 'unresolved');
      if (otherWarnings.length > 0) {
        for (const w of otherWarnings) {
          const linePrefix = w.line ? `Line ${String(w.line)}: ` : '';
          this.writer.writeLine(warning(`  Warning: ${linePrefix}${w.message}`));
        }
      }
    }
  }

  /**
   * Render generic key-value pairs.
   * @param data - Key-value data to render as aligned text output
   */
  private renderGenericDetail(data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) {
        // Format key with padding for alignment
        const formattedKey = `${key.charAt(0).toUpperCase() + key.slice(1)}:`.padEnd(10);
        // Format value based on type - objects use JSON, primitives use String
        let formattedValue: string;
        if (typeof value === 'object') {
          try {
            formattedValue = JSON.stringify(value);
          } catch {
            // Fallback for circular references - [object Object] is acceptable
            formattedValue = '[circular]';
          }
        } else if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ) {
          formattedValue = String(value);
        } else if (typeof value === 'bigint') {
          // BigInt cannot be serialized with JSON.stringify
          formattedValue = value.toString();
        } else {
          // symbol, function - use String for human-readable output
          // eslint-disable-next-line @typescript-eslint/no-base-to-string
          formattedValue = String(value);
        }
        this.writer.writeLine(`${formattedKey}${formattedValue}`);
      }
    }
  }

  /**
   * Render a status event.
   *
   * Handles special cases for 'stash' and 'pop' actions that require
   * position-aware formatting.
   * @param event - The status output event with result, action, and optional data
   */
  private renderStatus(event: OutputEvent & { type: 'status' }): void {
    // Handle stash action with position data specially
    if (event.action === 'stash' && event.data?.position) {
      const pos = event.data.position as StepPosition;
      printRunbookStashed(pos, this.writer);
      return;
    }

    // Handle pop action with step data - render step block
    if (event.action === 'pop' && event.data?.step && event.data.position) {
      const pos = event.data.position as StepPosition;
      const stepData = event.data.step as {
        name: string;
        description?: string;
        prompted?: boolean;
      };
      // Create a minimal step object for printStepBlock
      const step = { name: stepData.name, description: stepData.description } as Step;
      printStepBlock(pos, step, stepData.prompted ?? false, this.writer);
      return;
    }

    // Default: render message with success styling
    if (event.message) {
      this.writer.writeLine(success(event.message));
    }
  }

  /**
   * Render a message event with appropriate styling.
   * @param event - The message output event with text and severity level
   */
  private renderMessage(event: OutputEvent & { type: 'message' }): void {
    let coloredText: string;
    switch (event.level) {
      case 'success':
        coloredText = success(event.text);
        break;
      case 'warning':
        coloredText = warning(event.text);
        break;
      case 'error':
        coloredText = failure(event.text);
        break;
      case 'info':
        coloredText = info(event.text);
        break;
      case 'dim':
        coloredText = dim(event.text);
        break;
      default:
        coloredText = event.text;
    }
    this.writer.writeLine(coloredText);
  }

  /**
   * Render an error event.
   * @param event - The error output event with message and optional code
   */
  private renderError(event: OutputEvent & { type: 'error' }): void {
    this.writer.writeError(failure(`Error: ${event.message}`));
    if (event.code) {
      this.writer.writeError(dim(`Code: ${event.code}`));
    }
  }

  /**
   * Render an execution event using the existing print functions.
   *
   * Delegates to the appropriate print function based on event type,
   * maintaining consistent formatting with the established CLI style.
   *
   * @param event - The execution event to render
   */
  private renderExecutionEvent(event: RunbookEventV1): void {
    switch (event.type) {
      case 'RUNBOOK_STARTED':
        this.handleRunbookStarted(event);
        break;
      case 'STEP_ENTERED':
        this.handleStepEntered(event);
        break;
      case 'COMMAND_STARTED':
        this.handleCommandStarted(event);
        break;
      case 'COMMAND_COMPLETED':
        // Command output is printed separately during execution
        break;
      case 'STEP_TRANSITIONED':
        this.handleStepTransitioned(event);
        break;
      case 'POLICY_DENIED':
        this.handlePolicyDenied(event);
        break;
      case 'RUNBOOK_COMPLETED':
        printRunbookComplete(event.payload.message, this.writer);
        break;
      case 'RUNBOOK_STOPPED':
        printRunbookStoppedAtStep(event.payload.position, event.payload.message, this.writer);
        break;
      case 'ERROR_OCCURRED':
        this.handleErrorOccurred(event);
        break;
    }
  }

  /**
   * Handle RUNBOOK_STARTED event.
   * @param event - Runbook started event with metadata and prompted flag
   */
  private handleRunbookStarted(event: RunbookEventV1 & { type: 'RUNBOOK_STARTED' }): void {
    const { payload, runbook } = event;
    printMetadata(
      {
        file: runbook.name ?? runbook.path ?? 'unknown',
        state: payload.statePath,
        prompted: payload.prompted,
      },
      this.writer,
    );

    printActionBlock({ action: 'START' }, this.writer);
  }

  /**
   * Handle STEP_ENTERED event.
   * @param event - Step entered event with position, description, and command details
   */
  private handleStepEntered(event: RunbookEventV1 & { type: 'STEP_ENTERED' }): void {
    const { payload } = event;
    const {
      position,
      stepName,
      description,
      prompt,
      hasCommand,
      commandCode,
      commandLang,
      isSubstep,
      prompted,
    } = payload;

    // Create minimal step/substep object for rendering
    const command = hasCommand
      ? { code: commandCode ?? '', lang: commandLang ?? 'bash' }
      : undefined;
    const item = (
      isSubstep
        ? { id: stepName, description, prompt, command }
        : { name: stepName, description, prompt, command }
    ) as Step | Substep;

    printStepBlock(position, item, prompted, this.writer);
  }

  /**
   * Handle COMMAND_STARTED event.
   * @param event - Command started event with display command string
   */
  private handleCommandStarted(event: RunbookEventV1 & { type: 'COMMAND_STARTED' }): void {
    printCommandExec(event.payload.displayCommand, this.writer);
  }

  /**
   * Handle STEP_TRANSITIONED event.
   * @param event - Step transitioned event with action, from/at positions, and result
   */
  private handleStepTransitioned(event: RunbookEventV1 & { type: 'STEP_TRANSITIONED' }): void {
    const { payload } = event;

    // Print step separator before action block
    printStepSeparator(payload.at, this.writer);

    // Print action block with transition details
    const action: ActionBlockData = {
      action: formatTransitionAction(
        payload.action,
        payload.at,
        payload.retryAttempt,
        payload.retryMax,
        payload.forIndex,
      ),
      from: payload.from,
      result: payload.result,
      command: payload.command,
      at: payload.at,
      ...(payload.forIndex !== undefined
        ? { forIndex: payload.forIndex, forEnd: payload.forEnd }
        : {}),
    };
    printActionBlock(action, this.writer);
  }

  /**
   * Handle POLICY_DENIED event.
   * @param event - Policy denied event with blocked command and denial reason
   */
  private handlePolicyDenied(event: RunbookEventV1 & { type: 'POLICY_DENIED' }): void {
    printPolicyDenied(event.payload.command, event.payload.reason, this.writer);
  }

  /**
   * Handle ERROR_OCCURRED event.
   * @param event - Error event with message and optional error code
   */
  private handleErrorOccurred(event: RunbookEventV1 & { type: 'ERROR_OCCURRED' }): void {
    const { payload } = event;
    this.writer.writeLine('');
    this.writer.writeLine(`Error: ${payload.message}`);
    if (payload.code) {
      this.writer.writeLine(`Code: ${payload.code}`);
    }
  }
}
