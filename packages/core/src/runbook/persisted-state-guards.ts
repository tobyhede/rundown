/**
 * The gates every reader of persisted run state runs before validating it, and
 * the schema version they are written against.
 *
 * A leaf module on purpose. Both readers of persisted run state need these
 * gates — `RunbookStateManager.load` before it validates a run file, and
 * `RunbookStore.readRun` before it validates a run row inside an open
 * transaction — and `runbook/state.ts` already depends on
 * `runbook/storage/runbook-store.ts` for `guardOptions`. Housing the constant,
 * the errors, and the checks here keeps the store's dependency pointing at a
 * leaf instead of closing a runtime import cycle, and makes the two call sites
 * share one order, one taxonomy, and one message by construction rather than by
 * convention.
 *
 * `runbook/state.ts` re-exports both error classes, so it stays the import site
 * every existing consumer names. There is exactly one definition of each: a
 * second copy would give the CLI's `instanceof` classification two identities to
 * miss.
 *
 * @module runbook/persisted-state-guards
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
 * Thrown when a persisted state file uses the deprecated dynamic-step snapshot
 * shape (`GOTO_NEXT` last action or `instance` field), which the current
 * runtime rejects per the no-migration rule.
 *
 * A dedicated class so consumers (e.g. the CLI's orphaned-active-stack
 * recovery) classify by type rather than matching message wording.
 */
export class LegacySnapshotError extends Error {
  /**
   * Structured facts about the refusal, lifted from the throw site.
   *
   * Surfaces as RD-309's `context` so a consumer never has to parse the run id
   * out of `message`. `undefined` only where a construction site supplies none
   * — every production throw site does.
   */
  readonly defect: InvalidRunStateDefect | undefined;

  /**
   * Create a new LegacySnapshotError.
   *
   * @param message - Human-readable description of the rejected legacy shape
   * @param defect - Structured facts about the refused run
   */
  constructor(message: string, defect?: InvalidRunStateDefect) {
    super(message);
    this.name = 'LegacySnapshotError';
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

/**
 * Reject a raw persisted run row that the current runtime must not load.
 *
 * The single implementation of the pre-validation gates, run in this order:
 *
 * 1. a `GOTO_NEXT` `lastAction` — a dynamic-step snapshot
 * 2. a top-level `instance` field — the other dynamic-step snapshot shape
 * 3. a `schemaVersion` that is not {@link CURRENT_SCHEMA_VERSION}
 *
 * Order is part of the contract, not an accident: a legacy row also fails the
 * version check, and the legacy message is the actionable one ("restart from the
 * entrypoint") where the version message only names the run. Reversing the gates
 * would silently downgrade what a user with a pre-v1 run is told.
 *
 * Both readers of persisted state call this before their own schema parse —
 * `RunbookStateManager.load` on the file it just read, `RunbookStore.readRun` on
 * the row it just reassembled inside an open transaction — so a shape one
 * refuses can never be parsed and mutated through the other.
 *
 * The parse alone is not a substitute for any of the three, for two different
 * reasons. The run schema leaves `schemaVersion` optional on purpose (so `load`
 * can parse an invalid file far enough to report it usefully), so gate 3 is the
 * only thing standing between a foreign version and a successful read. The two
 * legacy shapes the parse does reject — measured: `invalid_union` / "No matching
 * discriminator" for `GOTO_NEXT`, `unrecognized_keys ["instance"]` for the other
 * — it rejects as a bare `ZodError` carrying a schema dump. That is neither of
 * the two classes the CLI's recovery paths classify on, so an ungated read turns
 * "restart from the entrypoint" into an unrecoverable internal fault.
 *
 * @param raw - The reassembled state object exactly as persisted, unvalidated
 * @param id - Run id, quoted into the message so the caller knows which run to prune
 * @throws {LegacySnapshotError} When the row carries a deprecated dynamic-step
 *   snapshot shape
 * @throws {InvalidRunbookStateError} When the row carries a schema version other
 *   than {@link CURRENT_SCHEMA_VERSION}
 */
export function assertLoadablePersistedRun(raw: Record<string, unknown>, id: string): void {
  const lastAction = raw.lastAction;
  if (
    typeof lastAction === 'object' &&
    lastAction !== null &&
    (lastAction as Record<string, unknown>).type === 'GOTO_NEXT'
  ) {
    throw new LegacySnapshotError(
      'This runbook used dynamic-step snapshots (GOTO_NEXT), which are no longer supported. ' +
        'Please restart execution from the runbook entrypoint.',
      { runId: id, reason: 'legacy_dynamic_step_snapshot' },
    );
  }
  if (raw.instance !== undefined) {
    throw new LegacySnapshotError(
      'This runbook used dynamic-step snapshots (instance field), which are no longer supported. ' +
        'Please restart execution from the runbook entrypoint.',
      { runId: id, reason: 'legacy_dynamic_step_snapshot' },
    );
  }
  assertCurrentSchemaVersion(raw.schemaVersion, id);
}
