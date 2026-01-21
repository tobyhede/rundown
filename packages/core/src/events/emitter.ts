import type { RunbookEventV1, RunbookRef, PayloadFor } from './types.js';

/**
 * Subscriber callback type for event emissions.
 */
type EventSubscriber = (event: RunbookEventV1) => void;

/**
 * Synchronous event emitter for runbook execution events.
 *
 * Automatically populates envelope fields (v, ts, seq) and routes
 * events to all subscribed listeners. Provides type-safe emit() with
 * payload inference based on event type.
 *
 * @example
 * ```typescript
 * const emitter = new ExecutionEventEmitter('wf-123', { name: 'my-runbook' });
 * const unsub = emitter.subscribe((event) => console.log(event.type));
 *
 * emitter.emit('RUNBOOK_STARTED', {
 *   title: 'My Runbook',
 *   prompted: false,
 *   statePath: '.claude/rundown/runs/wf-123.json'
 * });
 *
 * unsub(); // Stop listening
 * ```
 */
export class ExecutionEventEmitter {
  private seq: number = 0;
  private subscribers: Set<EventSubscriber> = new Set();

  /**
   * Create a new event emitter for a runbook execution.
   *
   * @param runbookId - Unique identifier for this runbook execution
   * @param runbook - Runbook identification (name and/or path)
   */
  constructor(
    private readonly runbookId: string,
    private readonly runbook: RunbookRef
  ) {}

  /**
   * Emit an event to all subscribers.
   *
   * Automatically populates envelope fields:
   * - v: '1' (schema version)
   * - ts: ISO timestamp (UTC)
   * - seq: monotonically incrementing sequence number
   * - runbookId: the runbook execution ID
   * - runbook: the runbook reference
   *
   * @param type - Event type discriminator
   * @param payload - Event-specific payload (type-inferred)
   * @template T - Event type literal
   */
  emit<T extends RunbookEventV1['type']>(
    type: T,
    payload: PayloadFor<T>
  ): void {
    this.seq++;

    const event: RunbookEventV1 = {
      v: '1',
      type,
      ts: new Date().toISOString(),
      runbookId: this.runbookId,
      runbook: this.runbook,
      seq: this.seq,
      payload: payload as never,
    };

    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  /**
   * Subscribe to events.
   *
   * Returns an unsubscribe function that removes this listener.
   *
   * @param subscriber - Callback to invoke for each emitted event
   * @returns Unsubscribe function
   */
  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * Clear all subscribers.
   *
   * Useful for cleanup or testing.
   */
  clear(): void {
    this.subscribers.clear();
  }
}
