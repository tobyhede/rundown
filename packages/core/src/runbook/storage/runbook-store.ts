/**
 * Typed transactional repository over the SQLite runbook schema.
 *
 * One table, one writer per run (ADR 0005). `transaction()` is the sole write
 * path; read helpers use short read transactions. Every raw row is validated at
 * this edge — the persisted-state gates and the Zod structural parse — so no
 * unvalidated row escapes the store. `state_version` is owned by the structural
 * trigger in `schema.ts`, never written directly here.
 *
 * A state write is ONE conditional `UPDATE … WHERE state_version = :expected`.
 * A mismatch is reported as `concurrent_modification` and nothing else happens:
 * no retry, no backoff, no second attempt. Two of the owner's own commands
 * racing is a usage error the caller is told about, not a race the store
 * serialises on its behalf.
 *
 * @module runbook/storage/runbook-store
 */

import type { z } from 'zod';
import { makeRunbookStateSchema } from '../../schemas.js';
import { getErrorMessage } from '../../errors.js';
import type { RunbookState, Lifecycle } from '../types.js';
import { type RunId, assertRunId } from '../run-id.js';
import type { SecretHash } from '../run-secrets.js';
import { assertLoadablePersistedRun, parsePersistedRunState } from '../persisted-state-guards.js';
import type { SqlDriver, SqlTransaction, SqlReadTransaction, SyncWork } from './sql-driver.js';
import { type StateVersion, assertStateVersion } from './mutation-result.js';

/** Machine lifecycle values persisted in the `runs.lifecycle` column. */
const LIFECYCLES: readonly Lifecycle[] = ['running', 'completed', 'stopped', 'abandoned'];

/**
 * Raised when a write that the store's own classification said must land
 * affected an unexpected number of rows, or when an insert collides with a row
 * the typed API said could not exist. Either is a defect in the store or a
 * tampered database, never a condition a caller should handle at runtime.
 */
export class StoreInvariantError extends Error {
  /**
   * Construct a store-invariant violation.
   *
   * @param message - Description of the violated invariant.
   */
  constructor(message: string) {
    super(message);
    this.name = 'StoreInvariantError';
  }
}

/**
 * Assert that a conditional write affected exactly one row.
 *
 * @param changes - Row count reported by the write.
 * @param runId - Run the write targeted, for the message.
 * @throws {StoreInvariantError} When `changes` is not `1`.
 */
export function assertExactlyOneRow(changes: number, runId: RunId): void {
  if (changes !== 1) {
    throw new StoreInvariantError(
      `Expected exactly one row to change for run ${runId}, but ${String(changes)} did.`,
    );
  }
}

/** A run state read together with the `state_version` it was read at. */
export interface VersionedRunState {
  /** The validated run state. */
  readonly state: RunbookState;
  /** The row's `state_version` at read time; the expectation a later save names. */
  readonly stateVersion: StateVersion;
}

/**
 * Outcome of {@link RunbookStore.saveRun}.
 *
 * - `committed` — the one conditional `UPDATE` landed; `state` is what is now
 *   persisted.
 * - `concurrent_modification` — the row exists but its `state_version` moved
 *   since the caller read it. Nothing was written. Refused, never retried.
 * - `missing` — no row carries the id. Nothing was written.
 */
export type SaveRunResult =
  | { readonly kind: 'committed'; readonly state: RunbookState }
  | { readonly kind: 'concurrent_modification' }
  | { readonly kind: 'missing' };

/** Typed read operations available inside a store transaction. */
export interface RunbookStoreReadTxn {
  /** The underlying read transaction, for raw statements. */
  readonly tx: SqlReadTransaction;
  /**
   * Read a validated run state, or null when absent.
   *
   * @param runId - Run to read.
   * @returns The validated run state, or null.
   */
  readState(runId: RunId): RunbookState | null;
  /**
   * Read a validated run state with the version it was read at, or null when
   * absent.
   *
   * @param runId - Run to read.
   * @returns The state and its version, or null.
   */
  readStateWithVersion(runId: RunId): VersionedRunState | null;
}

/** Typed operations available inside a writing store transaction. */
export interface RunbookStoreTxn extends RunbookStoreReadTxn {
  /** The underlying writing transaction, for raw statements. */
  readonly tx: SqlTransaction;
  /**
   * Insert a brand-new run row at `state_version` 0.
   *
   * @param state - Initial run state.
   * @param ownerTokenHash - Hash of the run's Owner Token.
   */
  insertRun(state: RunbookState, ownerTokenHash: SecretHash): void;
  /**
   * Write a run's state if and only if its `state_version` still equals the
   * expectation.
   *
   * @param runId - Run to write.
   * @param expectedVersion - Version captured when the caller read the run.
   * @param next - The complete state to persist.
   * @returns Why the write did or did not land.
   */
  writeStateAtVersion(
    runId: RunId,
    expectedVersion: StateVersion,
    next: RunbookState,
  ): SaveRunResult;
  /**
   * Delete a run row. Idempotent: a missing row is not an error.
   *
   * @param runId - Run to delete.
   */
  deleteRun(runId: RunId): void;
}

/**
 * Repository over the `runs` table.
 *
 * Production code reaches this through `RunbookStateManager`; the class itself
 * is exported for core's own tests and for the later tickets (#902 lease
 * conditional update, #904 claim insert) that add transactional operations
 * beside the ones here.
 */
export class RunbookStore {
  private readonly stateSchema: z.ZodType;

  /**
   * Construct a store over a driver.
   *
   * @param driver - Capability-selected SQL driver.
   * @param cwd - Project root, for path-validated state deserialization.
   */
  constructor(
    private readonly driver: SqlDriver,
    cwd: string,
  ) {
    this.stateSchema = makeRunbookStateSchema(cwd);
  }

  /**
   * Run write work in one short transaction. The sole store write path.
   *
   * @template T - Value the work returns.
   * @param work - Synchronous callback receiving typed transaction operations.
   * @returns The work's return value once committed.
   */
  transaction<T>(work: (txn: RunbookStoreTxn) => SyncWork<T>): Promise<T> {
    return this.driver.immediate((tx) => work(this.ops(tx)));
  }

  /**
   * Run read work in one short read transaction.
   *
   * The callback receives the READ facade only: the driver's read transaction
   * exposes no `run`/`exec`, so a write cannot be smuggled onto this path.
   *
   * @template T - Value the work returns.
   * @param work - Synchronous callback receiving typed read operations.
   * @returns The work's return value.
   */
  read<T>(work: (txn: RunbookStoreReadTxn) => SyncWork<T>): Promise<T> {
    return this.driver.read((tx) => work(this.readOps(tx)));
  }

  /**
   * Create a brand-new run, owned by whoever holds the token that hashes to
   * `ownerTokenHash`.
   *
   * @param state - Initial run state.
   * @param ownerTokenHash - Hash of the Owner Token minted for this run. The
   *   token itself is never stored.
   * @returns Resolves once committed.
   * @throws {StoreInvariantError} When a row already carries `state.id` or
   *   `ownerTokenHash`. Both are minted from fresh randomness, so a collision is
   *   a caller re-inserting a run it already created, never a condition to
   *   recover from.
   */
  async createRun(state: RunbookState, ownerTokenHash: SecretHash): Promise<void> {
    try {
      await this.transaction((txn) => {
        txn.insertRun(state, ownerTokenHash);
      });
    } catch (error: unknown) {
      throw uniqueViolationAsInvariant(error, state.id);
    }
  }

  /**
   * Load a run by id, or null when absent.
   *
   * Validating: `null` means "absent", never "present but unreadable". See
   * {@link RunbookStore.readRun} for the gates a persisted row must clear.
   *
   * @param runId - Run to load.
   * @returns The validated run state, or null.
   * @throws {LegacySnapshotError} When the row carries a deprecated dynamic-step
   *   snapshot shape (`GOTO_NEXT` last action, or an `instance` field).
   * @throws {InvalidRunbookStateError} When the row carries a schema version
   *   other than `CURRENT_SCHEMA_VERSION`, is missing `templateVars` or
   *   `prompted`, or clears those gates and fails run-state schema validation.
   */
  loadRun(runId: RunId): Promise<RunbookState | null> {
    return this.driver.read((tx) => this.readRun(tx, runId));
  }

  /**
   * Load a run together with the `state_version` it was read at.
   *
   * The read half of a read-derive-save span: the version returned here is the
   * expectation {@link RunbookStore.saveRun} compares against.
   *
   * @param runId - Run to load.
   * @returns The validated state and its version, or null when absent.
   * @throws {LegacySnapshotError} When the row carries a deprecated dynamic-step
   *   snapshot shape.
   * @throws {InvalidRunbookStateError} When the row fails the persisted-state
   *   gates or the structural parse.
   */
  loadRunWithVersion(runId: RunId): Promise<VersionedRunState | null> {
    return this.driver.read((tx) => this.readRunWithVersion(tx, runId));
  }

  /**
   * Resolve an Owner Token hash to the run it owns.
   *
   * The sole authority lookup: a mutating command resolves `--token` to a run by
   * hash, and a run id authorizes nothing. The hash column is `UNIQUE`, so at
   * most one row can match.
   *
   * @param ownerTokenHash - Hash of the presented Owner Token.
   * @returns The owned run and its version, or null when no run carries the hash.
   * @throws {LegacySnapshotError} When the matching row carries a deprecated
   *   dynamic-step snapshot shape.
   * @throws {InvalidRunbookStateError} When the matching row fails the
   *   persisted-state gates or the structural parse.
   */
  findRunByOwnerTokenHash(ownerTokenHash: SecretHash): Promise<VersionedRunState | null> {
    return this.driver.read((tx) => {
      const row = tx
        .prepare('SELECT id FROM runs WHERE owner_token_hash = :hash')
        .get<{ readonly id: string }>({ hash: ownerTokenHash });
      if (row === undefined) {
        return null;
      }
      return this.readRunWithVersion(tx, assertRunId(row.id));
    });
  }

  /**
   * Persist a run's complete state if and only if nobody wrote it since the
   * caller read it.
   *
   * One conditional `UPDATE`, one outcome. A `concurrent_modification` is not
   * retried here and must not be retried by the caller either: under one writer
   * per run it means two of the owner's own commands raced, and the second is
   * told so rather than silently serialised behind the first.
   *
   * @param runId - Run to write.
   * @param expectedVersion - The `state_version` the caller read the run at.
   * @param state - The complete state to persist. `lifecycle` defaults to
   *   `running` when absent.
   * @returns `committed` with the persisted state, or a typed refusal.
   * @throws {StoreInvariantError} When `state.id` names a different run than
   *   `runId`.
   */
  saveRun(
    runId: RunId,
    expectedVersion: StateVersion,
    state: RunbookState,
  ): Promise<SaveRunResult> {
    if (state.id !== runId) {
      throw new StoreInvariantError(
        `saveRun for ${runId} was handed state belonging to ${String(state.id)}.`,
      );
    }
    return this.transaction((txn) => txn.writeStateAtVersion(runId, expectedVersion, state));
  }

  /**
   * Delete a run row. Idempotent: a missing row is not an error.
   *
   * Child rows that named this run as their parent have their linkage cleared
   * by the `runs_unlink_children` trigger in the same statement.
   *
   * @param runId - Run to delete.
   * @returns Resolves once committed.
   */
  deleteRun(runId: RunId): Promise<void> {
    return this.transaction((txn) => {
      txn.deleteRun(runId);
    });
  }

  /**
   * List all run ids.
   *
   * @returns All run ids in ascending id order.
   */
  listRunIds(): Promise<readonly RunId[]> {
    return this.driver.read((tx) => listIds(tx));
  }

  /**
   * Load every persisted run.
   *
   * All-or-nothing: one unreadable row rejects the whole listing rather than
   * being skipped, because silently omitting it would hide exactly the state a
   * caller needs to prune. See {@link RunbookStore.readRun} for the gates.
   *
   * @returns All run states in ascending id order.
   * @throws {LegacySnapshotError} When any row carries a deprecated dynamic-step
   *   snapshot shape (`GOTO_NEXT` last action, or an `instance` field).
   * @throws {InvalidRunbookStateError} When any row carries a schema version
   *   other than `CURRENT_SCHEMA_VERSION`, is missing `templateVars` or
   *   `prompted`, or clears those gates and fails run-state schema validation.
   */
  listRuns(): Promise<readonly RunbookState[]> {
    return this.driver.read((tx) => {
      const states: RunbookState[] = [];
      for (const id of listIds(tx)) {
        const state = this.readRun(tx, id);
        if (state !== null) {
          states.push(state);
        }
      }
      return states;
    });
  }

  /**
   * Reassemble a run's persisted JSON without validating it.
   *
   * Exposed for the state manager, which reframes an unparseable `state_json` as
   * its own `unparseable_json` refusal and must therefore reach the row before
   * anything validates it — a parsed value would already have been refused on
   * its behalf, under a reason it did not choose.
   *
   * @param runId - Run to read.
   * @returns The assembled state object, or null when absent.
   */
  readRunJson(runId: RunId): Promise<Record<string, unknown> | null> {
    return this.driver.read((tx) => readRunRaw(tx, runId));
  }

  /**
   * Build the typed read facade over an open read transaction.
   *
   * @param tx - Open read transaction.
   * @returns Typed read operations.
   */
  private readOps(tx: SqlReadTransaction): RunbookStoreReadTxn {
    return {
      tx,
      readState: (runId) => this.readRun(tx, runId),
      readStateWithVersion: (runId) => this.readRunWithVersion(tx, runId),
    };
  }

  /**
   * Build the typed operation facade over an open writing transaction.
   *
   * @param tx - Open writing transaction.
   * @returns Typed store operations.
   */
  private ops(tx: SqlTransaction): RunbookStoreTxn {
    return {
      ...this.readOps(tx),
      tx,
      insertRun: (state, ownerTokenHash) => {
        insertRun(tx, state, ownerTokenHash);
      },
      writeStateAtVersion: (runId, expectedVersion, next) =>
        writeStateAtVersion(tx, runId, expectedVersion, next),
      deleteRun: (runId) => {
        tx.prepare('DELETE FROM runs WHERE id = :id').run({ id: runId });
      },
    };
  }

  /**
   * Read a run with the `state_version` it was read at.
   *
   * @param tx - Open transaction.
   * @param runId - Run to read.
   * @returns The validated state and its version, or null when absent.
   * @throws {LegacySnapshotError} When the row carries a deprecated dynamic-step
   *   snapshot shape.
   * @throws {InvalidRunbookStateError} When the row fails the persisted-state
   *   gates or the structural parse.
   */
  private readRunWithVersion(tx: SqlReadTransaction, runId: RunId): VersionedRunState | null {
    const row = tx
      .prepare('SELECT state_version FROM runs WHERE id = :id')
      .get<{ readonly state_version: number }>({ id: runId });
    if (row === undefined) {
      return null;
    }
    const state = this.readRun(tx, runId);
    return state === null ? null : { state, stateVersion: assertStateVersion(row.state_version) };
  }

  /**
   * Read and validate a run row inside an open transaction.
   *
   * `assertLoadablePersistedRun` gates the raw row, then
   * `parsePersistedRunState` performs the structural parse and reframes its
   * failure, so this reader and `RunbookStateManager.load` refuse the same
   * shapes with the same message and the same error class.
   *
   * @param tx - Open transaction.
   * @param runId - Run to read.
   * @returns The validated run state, or null.
   * @throws {LegacySnapshotError} When the row carries a deprecated dynamic-step
   *   snapshot shape (`GOTO_NEXT` last action, or an `instance` field).
   * @throws {InvalidRunbookStateError} When the row carries a schema version
   *   other than `CURRENT_SCHEMA_VERSION`, is missing `templateVars` or
   *   `prompted`, or clears those gates and fails run-state schema validation.
   */
  private readRun(tx: SqlReadTransaction, runId: RunId): RunbookState | null {
    const raw = readRunRaw(tx, runId);
    if (raw === null) {
      return null;
    }
    assertLoadablePersistedRun(raw, runId);
    return parsePersistedRunState(raw, runId, this.stateSchema);
  }
}

/**
 * Read every run id in ascending order.
 *
 * @param tx - Open transaction.
 * @returns All run ids.
 */
function listIds(tx: SqlReadTransaction): readonly RunId[] {
  return tx
    .prepare('SELECT id FROM runs ORDER BY id')
    .all<{ readonly id: string }>()
    .map((row) => assertRunId(row.id));
}

/**
 * Insert a new run row at `state_version` 0.
 *
 * @param tx - Open writing transaction.
 * @param state - Initial run state.
 * @param ownerTokenHash - Hash of the run's Owner Token.
 */
function insertRun(tx: SqlTransaction, state: RunbookState, ownerTokenHash: SecretHash): void {
  tx.prepare(
    `INSERT INTO runs (id, lifecycle, owner_token_hash, state_version, state_json, created_at, updated_at)
     VALUES (:id, :lifecycle, :ownerTokenHash, 0, :stateJson, :startedAt, :updatedAt)`,
  ).run({
    id: state.id,
    lifecycle: state.lifecycle ?? 'running',
    ownerTokenHash,
    stateJson: serializeStateJson(state),
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
  });
}

/**
 * Write run state under the one conditional `UPDATE`.
 *
 * @param tx - Open writing transaction.
 * @param runId - Run to write.
 * @param expectedVersion - Version captured at read.
 * @param next - New state.
 * @returns Why the write did or did not land.
 */
function writeStateAtVersion(
  tx: SqlTransaction,
  runId: RunId,
  expectedVersion: StateVersion,
  next: RunbookState,
): SaveRunResult {
  const changes = tx
    .prepare(
      `UPDATE runs
          SET state_json = :stateJson,
              lifecycle  = :lifecycle,
              updated_at = :updatedAt
        WHERE id = :id
          AND state_version = :expectedVersion`,
    )
    .run({
      id: runId,
      stateJson: serializeStateJson(next),
      lifecycle: next.lifecycle ?? 'running',
      updatedAt: next.updatedAt,
      expectedVersion,
    }).changes;
  if (changes === 1) {
    return { kind: 'committed', state: next };
  }
  const present = tx
    .prepare('SELECT 1 AS present FROM runs WHERE id = :id')
    .get<{ readonly present: 1 }>({ id: runId });
  return present === undefined ? { kind: 'missing' } : { kind: 'concurrent_modification' };
}

/**
 * Reassemble a run row into its full state object, unvalidated.
 *
 * @param tx - Open transaction.
 * @param runId - Run to read.
 * @returns The assembled object, or null when absent.
 */
function readRunRaw(tx: SqlReadTransaction, runId: RunId): Record<string, unknown> | null {
  const row = tx
    .prepare('SELECT lifecycle, state_json FROM runs WHERE id = :id')
    .get<{ readonly lifecycle: string; readonly state_json: string }>({ id: runId });
  if (row === undefined) {
    return null;
  }
  const raw = JSON.parse(row.state_json) as Record<string, unknown>;
  raw.lifecycle = assertLifecycle(row.lifecycle);
  return raw;
}

/**
 * Serialize a run state to `state_json`, excluding `lifecycle`, whose home is
 * its own column.
 *
 * @param state - Run state.
 * @returns JSON string for the `state_json` column.
 */
function serializeStateJson(state: RunbookState): string {
  const { lifecycle: _lc, ...rest } = state;
  return JSON.stringify(rest);
}

/**
 * Validate a lifecycle string read from the column.
 *
 * @param value - Raw lifecycle string.
 * @returns The validated lifecycle.
 * @throws {Error} When the value is not a known lifecycle.
 */
function assertLifecycle(value: string): Lifecycle {
  if (!LIFECYCLES.includes(value as Lifecycle)) {
    throw new Error(`Invalid persisted lifecycle: ${JSON.stringify(value)}`);
  }
  return value as Lifecycle;
}

/**
 * Reframe a SQLite UNIQUE violation on `runs` as a {@link StoreInvariantError}.
 *
 * Any other error passes through untouched. The message names the column, not
 * the value: the colliding value on `owner_token_hash` is a hash of a secret
 * and has no business in an error envelope.
 *
 * @param error - The thrown value.
 * @param runId - Run the insert was for.
 * @returns The invariant error for a UNIQUE violation, else `error` itself.
 */
function uniqueViolationAsInvariant(error: unknown, runId: RunId): unknown {
  const match = /UNIQUE constraint failed: runs\.(\w+)/.exec(getErrorMessage(error));
  if (match === null) {
    return error;
  }
  const column = match[1];
  return new StoreInvariantError(
    column === 'owner_token_hash'
      ? `A run already carries the owner token hash minted for ${runId}.`
      : `A run with id ${runId} already exists.`,
  );
}
