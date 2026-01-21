import type {
  RunbookEventV1,
  StepPosition,
} from '../types.js';

/**
 * Execution summary for JSON output.
 */
export interface ExecutionSummary {
  /** Runbook state ID. Present after RUNBOOK_STARTED event. */
  readonly runbookId?: string;

  /** Runbook path or name. Present after RUNBOOK_STARTED event. */
  readonly runbook?: string;

  /** Execution status. Always present: 'running' until terminal event. */
  readonly status: 'complete' | 'stopped' | 'running';

  /** Number of step transitions completed. Always present. */
  readonly stepsExecuted: number;

  /** Total commands executed. Always present. */
  readonly commandsRun: number;

  /** Commands that failed (non-zero exit). Always present. */
  readonly commandsFailed: number;

  /** Final step position. Present after RUNBOOK_COMPLETED or RUNBOOK_STOPPED. */
  readonly finalPosition?: StepPosition;

  /** Completion/stop message. Present if provided in terminal event. */
  readonly message?: string;

  /** All collected events. Always present. */
  readonly events: readonly RunbookEventV1[];
}

/**
 * JSON subscriber that collects events for programmatic output.
 *
 * Use for MCP responses, --json flag, or testing.
 */
export class JSONSubscriber {
  /** Collected events. Mutated by handle()/clear(). */
  private events: RunbookEventV1[] = [];

  /**
   * Handle an execution event by collecting it.
   */
  handle = (event: RunbookEventV1): void => {
    this.events.push(event);
  };

  /**
   * Get all collected events.
   */
  getEvents(): readonly RunbookEventV1[] {
    return this.events;
  }

  /**
   * Get events of a specific type.
   */
  getEventsByType<T extends RunbookEventV1['type']>(
    type: T
  ): Extract<RunbookEventV1, { type: T }>[] {
    return this.events.filter(
      (e): e is Extract<RunbookEventV1, { type: T }> => e.type === type
    );
  }

  /**
   * Clear collected events.
   */
  clear(): void {
    this.events = [];
  }

  /**
   * Build execution summary from collected events.
   */
  getSummary(): ExecutionSummary {
    const transitions = this.getEventsByType('STEP_TRANSITIONED');
    const commands = this.getEventsByType('COMMAND_COMPLETED');
    const completeEvent = this.getEventsByType('RUNBOOK_COMPLETED').at(0);
    const stoppedEvent = this.getEventsByType('RUNBOOK_STOPPED').at(0);
    const startedEvent = this.getEventsByType('RUNBOOK_STARTED').at(0);

    const status: 'complete' | 'stopped' | 'running' = completeEvent ? 'complete' : stoppedEvent ? 'stopped' : 'running';
    const finalPosition = completeEvent ? completeEvent.payload.finalPosition : stoppedEvent?.payload.position;
    const message = completeEvent ? completeEvent.payload.message : stoppedEvent?.payload.message;

    return {
      runbookId: startedEvent?.runbookId,
      runbook: startedEvent?.runbook.path ?? startedEvent?.runbook.name,
      status,
      stepsExecuted: transitions.length,
      commandsRun: commands.length,
      commandsFailed: commands.filter((c) => !c.payload.success).length,
      finalPosition,
      message,
      events: this.events,
    };
  }
}
