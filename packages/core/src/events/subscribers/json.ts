import type {
  RunbookEventV1,
  StepPosition,
} from '../types.js';

/**
 * Execution summary for JSON output.
 */
export interface ExecutionSummary {
  readonly runbookId?: string;
  readonly runbook?: string;
  readonly status: 'complete' | 'stopped' | 'running';
  readonly stepsExecuted: number;
  readonly commandsRun: number;
  readonly commandsFailed: number;
  readonly finalPosition?: StepPosition;
  readonly message?: string;
  readonly events: readonly RunbookEventV1[];
}

/**
 * JSON subscriber that collects events for programmatic output.
 *
 * Use for MCP responses, --json flag, or testing.
 */
export class JSONSubscriber {
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
    const started = this.getEventsByType('RUNBOOK_STARTED')[0];
    const complete = this.getEventsByType('RUNBOOK_COMPLETED')[0];
    const stopped = this.getEventsByType('RUNBOOK_STOPPED')[0];
    const transitions = this.getEventsByType('STEP_TRANSITIONED');
    const commands = this.getEventsByType('COMMAND_COMPLETED');

    return {
      runbookId: started?.runbookId,
      runbook: started?.runbook.path ?? started?.runbook.name,
      status: complete ? 'complete' : stopped ? 'stopped' : 'running',
      stepsExecuted: transitions.length,
      commandsRun: commands.length,
      commandsFailed: commands.filter((c) => !c.payload.success).length,
      finalPosition: complete?.payload.finalPosition ?? stopped?.payload.position,
      message: complete?.payload.message ?? stopped?.payload.message,
      events: this.events,
    };
  }
}
