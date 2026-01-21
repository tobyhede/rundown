import type { RunbookEventV1, StepPosition } from '../types.js';
import type { OutputWriter } from '../../cli/writer.js';
import {
  printMetadata,
  printActionBlock,
  printStepBlock,
  printRunbookComplete,
  printRunbookStoppedAtStep,
  printCommandExec,
  printPolicyDenied,
  printStepSeparator,
} from '../../cli/output.js';
import type { RunbookMetadata, ActionBlockData } from '../../cli/types.js';
import type { Step, Substep } from '../../runbook/types.js';
import { getWriter } from '../../cli/context.js';

/**
 * Renders runbook events to terminal output via existing print functions.
 *
 * CLISubscriber maintains backward compatibility with the current CLI output
 * format by wrapping existing print functions. It translates event payloads
 * into the format expected by these functions.
 *
 * @example
 * ```typescript
 * const emitter = new ExecutionEventEmitter('wf-123', { name: 'my-runbook' });
 * const subscriber = new CLISubscriber();
 * emitter.subscribe((event) => subscriber.handle(event));
 * ```
 */
export class CLISubscriber {
  private writer: OutputWriter;

  /**
   * Create a new CLI subscriber.
   *
   * @param writer - OutputWriter to use (defaults to global writer)
   */
  constructor(writer?: OutputWriter) {
    this.writer = writer || getWriter();
  }

  /**
   * Handle an event and render it to the terminal.
   *
   * @param event - The event to handle
   */
  handle = (event: RunbookEventV1): void => {
    switch (event.type) {
      case 'RUNBOOK_STARTED':
        this.handleRunbookStarted(event as RunbookEventV1 & { type: 'RUNBOOK_STARTED' });
        break;
      case 'STEP_ENTERED':
        this.handleStepEntered(event as RunbookEventV1 & { type: 'STEP_ENTERED' });
        break;
      case 'COMMAND_STARTED':
        this.handleCommandStarted(event as RunbookEventV1 & { type: 'COMMAND_STARTED' });
        break;
      case 'COMMAND_COMPLETED':
        this.handleCommandCompleted(event as RunbookEventV1 & { type: 'COMMAND_COMPLETED' });
        break;
      case 'STEP_TRANSITIONED':
        this.handleStepTransitioned(event as RunbookEventV1 & { type: 'STEP_TRANSITIONED' });
        break;
      case 'POLICY_DENIED':
        this.handlePolicyDenied(event as RunbookEventV1 & { type: 'POLICY_DENIED' });
        break;
      case 'RUNBOOK_COMPLETED':
        this.handleRunbookCompleted(event as RunbookEventV1 & { type: 'RUNBOOK_COMPLETED' });
        break;
      case 'RUNBOOK_STOPPED':
        this.handleRunbookStopped(event as RunbookEventV1 & { type: 'RUNBOOK_STOPPED' });
        break;
      case 'ERROR_OCCURRED':
        this.handleErrorOccurred(event as RunbookEventV1 & { type: 'ERROR_OCCURRED' });
        break;
    }
  }

  private handleRunbookStarted(event: RunbookEventV1 & { type: 'RUNBOOK_STARTED' }): void {
    const { payload, runbook } = event;

    // Print metadata - use runbook name/path for file, statePath for state
    const meta: RunbookMetadata = {
      file: runbook.name ?? runbook.path ?? 'unknown',
      state: payload.statePath,
      prompted: payload.prompted,
    };
    printMetadata(meta, this.writer);

    // Print action block
    const action: ActionBlockData = {
      action: 'START',
    };
    printActionBlock(action, this.writer);
  }

  private handleStepEntered(event: RunbookEventV1 & { type: 'STEP_ENTERED' }): void {
    const { payload } = event;
    const { position, stepName, description, prompt, hasCommand, commandCode, commandLang, isSubstep, prompted } = payload;

    // Create minimal step/substep object for rendering
    // Include actual command code for prompted mode display
    const command = hasCommand ? { code: commandCode ?? '', lang: commandLang ?? 'bash' } : undefined;
    const item = (isSubstep
      ? { id: stepName, description, prompt, command }
      : { name: stepName, description, prompt, command }
    ) as Step | Substep;

    // Pass `prompted` flag to control command display
    printStepBlock(position, item, prompted, this.writer);
  }

  private handleCommandStarted(event: RunbookEventV1 & { type: 'COMMAND_STARTED' }): void {
    const { payload } = event;
    printCommandExec(payload.displayCommand, this.writer);
  }

  private handleCommandCompleted(_event: RunbookEventV1 & { type: 'COMMAND_COMPLETED' }): void {
    // Command completed is typically just the output from command execution
    // No specific output needed here as the command output is printed separately
  }

  private handleStepTransitioned(event: RunbookEventV1 & { type: 'STEP_TRANSITIONED' }): void {
    const { payload } = event;

    // Print action block with transition details
    const action: ActionBlockData = {
      action: payload.action,
      from: payload.from,
      result: payload.result,
      command: payload.command,
      at: payload.to,
    };
    printActionBlock(action, this.writer);
  }

  private handlePolicyDenied(event: RunbookEventV1 & { type: 'POLICY_DENIED' }): void {
    const { payload } = event;
    printPolicyDenied(payload.command, payload.reason, this.writer);
  }

  private handleRunbookCompleted(event: RunbookEventV1 & { type: 'RUNBOOK_COMPLETED' }): void {
    printRunbookComplete(event.payload.message, this.writer);
  }

  private handleRunbookStopped(event: RunbookEventV1 & { type: 'RUNBOOK_STOPPED' }): void {
    printRunbookStoppedAtStep(event.payload.position, event.payload.message, this.writer);
  }

  private handleErrorOccurred(event: RunbookEventV1 & { type: 'ERROR_OCCURRED' }): void {
    const { payload } = event;
    this.writer.writeLine('');
    this.writer.writeLine(`Error: ${payload.message}`);
    if (payload.code) {
      this.writer.writeLine(`Code: ${payload.code}`);
    }
  }
}
