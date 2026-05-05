import type { RunbookEventV1 } from '../types.js';
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
import { formatTransitionAction } from '../../runbook/transition-kernel.js';

/**
 * Renders runbook events to terminal output via existing print functions.
 *
 * CLISubscriber maintains backward compatibility with the current CLI output
 * format by wrapping existing print functions. It translates event payloads
 * into the format expected by these functions.
 *
 * @example
 * ```typescript
 * const emitter = new ExecutionEventEmitter('wf-123', {
 *   source: 'project',
 *   path: 'my-runbook.runbook.md',
 * });
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
    this.writer = writer ?? getWriter();
  }

  /**
   * Handle an event and render it to the terminal.
   *
   * @param event - The event to handle
   * @throws {Error} If the event type is not recognized (exhaustiveness check)
   */
  handle = (event: RunbookEventV1): void => {
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
        this.handleCommandCompleted(event);
        break;
      case 'STEP_TRANSITIONED':
        this.handleStepTransitioned(event);
        break;
      case 'POLICY_DENIED':
        this.handlePolicyDenied(event);
        break;
      case 'RUNBOOK_COMPLETED':
        this.handleRunbookCompleted(event);
        break;
      case 'RUNBOOK_STOPPED':
        this.handleRunbookStopped(event);
        break;
      case 'ERROR_OCCURRED':
        this.handleErrorOccurred(event);
        break;
      default: {
        // Exhaustiveness check - TypeScript errors if a case is missing
        const _exhaustive: never = event;
        throw new Error(`Unhandled event type: ${(_exhaustive as RunbookEventV1).type}`);
      }
    }
  };

  private handleRunbookStarted(event: RunbookEventV1 & { type: 'RUNBOOK_STARTED' }): void {
    const { payload, runbook } = event;

    // Print metadata - use canonical runbook path for file, statePath for state
    const meta: RunbookMetadata = {
      file: runbook.path,
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
      delegateFrontier,
    } = payload;

    // Create minimal step/substep object for rendering
    // Include actual command code for prompted mode display
    const command = hasCommand
      ? { code: commandCode ?? '', lang: commandLang ?? 'bash' }
      : undefined;
    const item = (
      isSubstep
        ? { id: stepName, description, prompt, command }
        : { name: stepName, description, prompt, command }
    ) as Step | Substep;

    // Pass `prompted` flag to control command display
    printStepBlock(position, item, prompted, this.writer);

    if (delegateFrontier && delegateFrontier.length > 0) {
      const count = delegateFrontier.length;
      this.writer.writeLine(`Delegates ${String(count)} substep${count === 1 ? '' : 's'}:`);
      for (const entry of delegateFrontier) {
        this.writer.writeLine(`  ${entry.id}  ${entry.runbook}  ${entry.token}`);
      }
    }
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

    // Print step separator before action block (matches fallback path)
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
