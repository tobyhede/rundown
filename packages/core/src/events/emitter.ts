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
 *   statePath: '.rundown/runs/wf-123.json'
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
   * @param type - Event type discriminator
   * @param payload - Event-specific payload (type-inferred)
   * @template T - Event type literal
   */
  emit<T extends RunbookEventV1['type']>(type: T, payload: PayloadFor<T>): void {
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
    payload: PayloadFor<T>,
  ): RunbookEventV1 {
    // This function separates the event construction from the generic emit() method.
    // By using a type assertion here instead of in emit(), we achieve better
    // separation of concerns: emit() remains focused on subscriber management
    // while buildEvent() handles the type-casting complexity in one focused location.
    // The assertion is necessary because TypeScript cannot statically verify that
    // the provided payload matches the type discriminant, even though our generic
    // constraints guarantee they match at runtime. See:
    // https://github.com/microsoft/TypeScript/issues/14094 (discriminated unions in generics)

    // Development-mode validation: verify payload has required fields for event type.
    // This catches type mismatches that the 'as Extract<...>' assertion bypasses.
    // Zero cost in production since the entire block is tree-shaken.
    if (process.env.NODE_ENV !== 'production') {
      this.validatePayload(type, payload);
    }

    return {
      v: '1',
      type,
      ts: new Date().toISOString(),
      runbookId: this.runbookId,
      runbook: this.runbook,
      seq: this.seq,
      payload,
    } as Extract<RunbookEventV1, { type: T }>;
  }

  /**
   * Validate that payload contains required fields for the given event type.
   * Only called in development mode. Throws if validation fails.
   *
   * @param type - Event type discriminator
   * @param payload - Payload to validate
   * @throws {Error} If payload is missing required fields for the event type
   */
  private validatePayload<T extends RunbookEventV1['type']>(type: T, payload: PayloadFor<T>): void {
    // Define required fields for each event type
    const requiredFields: Record<RunbookEventV1['type'], string[]> = {
      RUNBOOK_STARTED: ['prompted', 'statePath'],
      STEP_ENTERED: ['position', 'stepName', 'hasCommand', 'isSubstep', 'prompted'],
      COMMAND_STARTED: ['command', 'displayCommand', 'position'],
      COMMAND_COMPLETED: ['command', 'success', 'exitCode', 'position'],
      STEP_TRANSITIONED: ['action', 'from', 'at', 'result'],
      POLICY_DENIED: ['command', 'reason', 'position'],
      RUNBOOK_COMPLETED: ['finalPosition'],
      RUNBOOK_STOPPED: ['position'],
      ERROR_OCCURRED: ['message'],
    };

    // TypeScript guarantees `required` is defined via Record<RunbookEventV1['type'], string[]>.
    // All event types must be keys in requiredFields - adding a new event type without
    // updating this record causes a compile-time error.
    const required = requiredFields[type];
    const payloadObj = payload as unknown as Record<string, unknown>;
    const missing = required.filter(
      (field) => !(field in payloadObj) || payloadObj[field] === undefined,
    );

    if (missing.length > 0) {
      throw new Error(
        `Invalid payload for ${type}: missing required fields: ${missing.join(', ')}`,
      );
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
