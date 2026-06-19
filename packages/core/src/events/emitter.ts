import type { RunbookEventV1, RunbookRef, RunbookEventInput } from './types.js';

/**
 * Subscriber callback type for event emissions.
 */
export type EventSubscriber = (event: RunbookEventV1) => void;

/**
 * Synchronous event emitter for runbook execution events.
 *
 * Automatically populates envelope fields (v, ts, seq) and routes
 * events to all subscribed listeners. Accepts a pre-correlated
 * `{ type, payload }` pair so the type/payload relationship is checked at
 * every call site without a type assertion.
 *
 * @example
 * ```typescript
 * const emitter = new ExecutionEventEmitter('wf-123', {
 *   source: 'project',
 *   path: 'my-runbook.runbook.md',
 * });
 * const unsub = emitter.subscribe((event) => console.log(event.type));
 *
 * emitter.emit({
 *   type: 'RUNBOOK_STARTED',
 *   payload: {
 *     title: 'My Runbook',
 *     prompted: false,
 *     statePath: '.rundown/runs/wf-123.json',
 *   },
 * });
 *
 * unsub(); // Stop listening
 * ```
 */
export class ExecutionEventEmitter {
  /** Monotonically increasing sequence number. Mutated on each emit(). */
  private seq = 0;
  /** Active subscriber set. Modified by subscribe()/clear(). */
  private subscribers = new Set<EventSubscriber>();

  /**
   * Create a new event emitter for a runbook execution.
   *
   * @param runbookId - Unique identifier for this runbook execution
   * @param runbook - Canonical local-disk runbook reference
   */
  constructor(
    private readonly runbookId: string,
    private readonly runbook: RunbookRef,
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
   * Subscribers are invoked synchronously in registration order. Exceptions
   * thrown by a subscriber callback are not caught and propagate to the caller
   * of `emit` (a throwing subscriber also prevents later subscribers from
   * running); callers that cannot tolerate this must guard their subscribers.
   *
   * @param input - Pre-correlated `{ type, payload }` event pair
   * @throws {Error} Re-throws any error thrown by a subscriber callback
   */
  emit(input: RunbookEventInput): void {
    this.seq++;

    const event = this.buildEvent(input);

    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  /**
   * Build a complete event by spreading the pre-correlated input pair into the
   * envelope.
   *
   * The `type`/`payload` correlation already lives in the {@link RunbookEventInput}
   * value, so spreading it preserves the discriminated-union relationship and
   * TypeScript proves assignability to {@link RunbookEventV1} member-by-member
   * with no type assertion.
   *
   * @param input - Pre-correlated `{ type, payload }` event pair
   * @returns Complete RunbookEventV1 event object
   */
  private buildEvent(input: RunbookEventInput): RunbookEventV1 {
    return {
      v: '1',
      ts: new Date().toISOString(),
      runbookId: this.runbookId,
      runbook: this.runbook,
      seq: this.seq,
      ...input,
    };
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

  /**
   * Get the current number of subscribers.
   * Useful for testing.
   *
   * @returns The number of active subscribers
   */
  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
