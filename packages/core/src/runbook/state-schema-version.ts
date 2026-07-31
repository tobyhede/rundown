/**
 * The persisted-state schema version, and the single gate that rejects state
 * carrying any other one.
 *
 * A leaf module on purpose. Both readers of persisted run state need this gate
 * — `RunbookStateManager.load` before it validates a run file, and
 * `RunbookStore.readRun` before it validates a run row inside an open
 * transaction — and `runbook/state.ts` already depends on
 * `runbook/storage/runbook-store.ts` for `guardOptions`. Housing the constant,
 * the error, and the check here keeps the store's dependency pointing at a leaf
 * instead of closing a runtime import cycle, and makes the two gates share one
 * message by construction rather than by convention.
 *
 * @module runbook/state-schema-version
 */

import type { InvalidRunStateDefect } from '../errors/rundown-error.js';

/**
 * Current persisted state schema version for the v1 release.
 *
 * Every newly derived state is stamped with this version; every read of
 * persisted state rejects any other one. Exported so callers deriving state
 * outside the manager — and the tests pinning that guarantee — name the version
 * rather than hard-coding `1`.
 */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Thrown when a persisted state file does not match the current schema contract.
 */
export class InvalidRunbookStateError extends Error {
  /**
   * Structured facts about the refusal, lifted from the throw site.
   *
   * Surfaces as RD-309's `context` so a consumer never has to parse the run id
   * out of `message`. `undefined` only where a construction site supplies none
   * — every production throw site does.
   */
  readonly defect: InvalidRunStateDefect | undefined;

  /**
   * Create a new InvalidRunbookStateError.
   *
   * @param message - Human-readable description of why the state is invalid
   * @param defect - Structured facts about the refused run
   */
  constructor(message: string, defect?: InvalidRunStateDefect) {
    super(message);
    this.name = 'InvalidRunbookStateError';
    this.defect = defect;
  }
}

/**
 * Reject persisted runbook state that does not carry {@link CURRENT_SCHEMA_VERSION}.
 *
 * Persisted state is never migrated: a foreign version — or an absent one, which
 * is the only other shape the store's deliberately-optional `schemaVersion` field
 * lets through — is refused so the caller can finish, stop, prune, or restart.
 * Silently parsing it would adapt data the no-migration rule forbids adapting.
 *
 * Building the RD-309 defect here rather than at the call sites is the same
 * consolidation as the message: the found version rides in `schemaVersion` and
 * nowhere else — the message never states it, so a consumer could not recover it
 * at all — and one gate cannot drop it on one of its two callers.
 *
 * @param schemaVersion - The `schemaVersion` field as persisted, unvalidated
 * @param id - Run id, quoted into the message so the caller knows which run to prune
 * @throws {InvalidRunbookStateError} When `schemaVersion` is not the current version
 */
export function assertCurrentSchemaVersion(schemaVersion: unknown, id: string): void {
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new InvalidRunbookStateError(
      `Invalid runbook state for "${id}": invalid schemaVersion; expected schema version ${String(CURRENT_SCHEMA_VERSION)}.`,
      { runId: id, reason: 'invalid_schema_version', schemaVersion },
    );
  }
}
