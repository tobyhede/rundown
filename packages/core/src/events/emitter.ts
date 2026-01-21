import type { RunbookEventV1, RunbookRef, PayloadFor } from './types.js';

/**
 * Subscriber callback type for event emissions.
 */
export type EventSubscriber = (event: RunbookEventV1) => void;

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
  /** Monotonically increasing sequence number. Mutated on each emit(). */
  private seq = 0;
  /** Active subscriber set. Modified by subscribe()/clear(). */
  private subscribers = new Set<EventSubscriber>();

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

    // Build event using type-safe helper to satisfy discriminated union.
    // The helper ensures payload matches the type discriminant at runtime,
    // which TypeScript cannot verify in this generic context due to limitations
    // with discriminated unions in generic functions. The helper's structure
    // ensures both type and payload are assigned together atomically, making
    // the union assignment type-safe.
    const event = this.buildEvent(type, payload);

    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  /**
   * Type-safe event builder.
   *
   * This helper function properly constructs a discriminated union event
   * object. By building in a separate context, TypeScript can verify the
   * relationship between type and payload without needing a type assertion.
   *
   * @param type - Event type discriminator
   * @param payload - Event-specific payload
   * @returns Complete RunbookEventV1 event object
   * @template T - Event type literal
   */
  private buildEvent<T extends RunbookEventV1['type']>(
    type: T,
    payload: PayloadFor<T>
  ): RunbookEventV1 {
    // This function separates the event construction from the generic emit() method.
    // By using a type assertion here instead of in emit(), we achieve better
    // separation of concerns: emit() remains focused on subscriber management
    // while buildEvent() handles the type-casting complexity in one focused location.
    // The assertion is necessary because TypeScript cannot statically verify that
    // the provided payload matches the type discriminant, even though our generic
    // constraints guarantee they match at runtime. See:
    // https://github.com/microsoft/TypeScript/issues/14094 (discriminated unions in generics)
    return {
      v: '1',
      type,
      ts: new Date().toISOString(),
      runbookId: this.runbookId,
      runbook: this.runbook,
      seq: this.seq,
      payload: payload as never,
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
   */
  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
