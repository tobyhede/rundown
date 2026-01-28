import type { RunbookEventV1 } from '../types.js';
import type { ExecutionSummary } from '../../output/zod-schemas.js';

// Re-export ExecutionSummary from zod-schemas (single source of truth)
export type { ExecutionSummary };

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
   *
   * Returns a defensive copy to prevent mutation of internal state.
   */
  getEvents(): readonly RunbookEventV1[] {
    return [...this.events];
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
      events: [...this.events],
    };
  }
}
