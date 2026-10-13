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
 * The execution lease (#902) rides the same version. Setting it is one
 * conditional `UPDATE` that moves `state_version`. Clearing it is explicit:
 * only {@link RunbookStore.saveRunResolvingLease} — the owner's decision or the
 * attempt's finish — clears the lease its expected version carries, and the
 * finish of a leased attempt commits only at the version its lease produced.
 * Every other state write ({@link RunbookStore.saveRun}) is refused on a leased
 * row, so no incidental writer can erase an Interrupted marker.
 *
 * @module runbook/storage/runbook-store
 */

import type { z } from 'zod';
import { makeRunbookStateSchema } from '../../schemas.js';
import { getErrorMessage } from '../../errors.js';
import type { RunbookState, Lifecycle } from '../types.js';
import { type RunId, assertRunId } from '../run-id.js';
import type { SecretHash } from '../run-secrets.js';
import {
  assertLoadablePersistedRun,
  InvalidRunbookStateError,
  parsePersistedRunState,
} from '../persisted-state-guards.js';
import type { SqlDriver, SqlTransaction, SqlReadTransaction, SyncWork } from './sql-driver.js';
import { type StateVersion, assertStateVersion } from './mutation-result.js';
import type { ExecutionLease, ExecutionLeaseHolder } from '../execution-lease.js';
import type { ChildKind, ChildLinkage } from '../child-linkage.js';
import type { FrameKey } from '../targeting.js';

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
  /**
   * The execution lease the row carried at that version, or null. A save at
   * `stateVersion` clears it, so a seam that writes must have decided about it.
   */
  readonly lease: ExecutionLease | null;
  /**
   * The parent coordinate the row records, or null for a top-level run. Written
   * once when a child row is inserted (#903) and never changed afterwards.
   */
  readonly linkage: ChildLinkage | null;
}

/**
 * One row of {@link RunbookStore.listRunsWithVersion}: validated, or the error
 * its validation raised.
 */
export type ListedRun =
  | { readonly kind: 'valid'; readonly run: VersionedRunState }
  | { readonly kind: 'invalid'; readonly runId: RunId; readonly error: unknown };

/** A run named together with the `state_version` the caller read it at. */
export interface RunAtVersion {
  /** The run. */
  readonly runId: RunId;
  /** The version the caller read it at. */
  readonly stateVersion: StateVersion;
}

/**
 * Outcome of {@link RunbookStore.deleteRunAtVersion}.
 *
 * - `deleted` — the row and every inline descendant were still at the
 *   versions the caller read and are gone.
 * - `concurrent_modification` — the row exists but its `state_version`, or
 *   the set or version of its inline descendants, moved since the caller read
 *   them (a write, an execution lease taken, a child launched). Nothing was
 *   deleted. Refused, never retried.
 * - `missing` — no row carries the id. Nothing was deleted.
 */
export type DeleteRunResult =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'concurrent_modification' }
  | { readonly kind: 'missing' };

/** Input to {@link RunbookStore.claimDelegationChild}. */
export interface ClaimDelegationChildInput<R> {
  /** The parent whose reservation the claim names. */
  readonly parentRunId: RunId;
  /**
   * Decide, on the parent as read inside the claim's transaction, whether the
   * reservation may still be claimed: `undefined` to insert, or the refusal.
   * Synchronous and pure, so the decision and the insert see one state.
   */
  readonly verify: (parent: VersionedRunState | null) => R | undefined;
  /** The child's initialised state, carrying the reservation's preallocated id. */
  readonly state: RunbookState;
  /** Hash of the child's own Owner Token. */
  readonly ownerTokenHash: SecretHash;
  /** The parent coordinate; its `kind` must be `delegation`. */
  readonly linkage: ChildLinkage;
}

/**
 * Outcome of {@link RunbookStore.claimDelegationChild}.
 *
 * - `claimed` — the child row is inserted under the preallocated id.
 * - `already_claimed` — a row already carries that id: the primary key
 *   refused a second claim. Nothing was written.
 * - `refused` — the parent check refused; nothing was written.
 */
export type ClaimDelegationChildResult<R> =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'already_claimed' }
  | { readonly kind: 'refused'; readonly refusal: R };

/**
 * Outcome of {@link RunbookStore.acquireExecutionLease}.
 *
 * - `acquired` — the lease is set; `stateVersion` (equal to `lease.attempt`) is
 *   the only version the attempt's finish may commit at.
 * - `held` — a lease is already set at the expected version. Nothing written.
 * - `concurrent_modification` — the version moved since the caller read the
 *   run. Nothing written. Refused, never retried.
 * - `missing` — no row carries the id. Nothing written.
 */
export type AcquireExecutionLeaseResult =
  | {
      readonly kind: 'acquired';
      readonly lease: ExecutionLease;
      readonly stateVersion: StateVersion;
    }
  | { readonly kind: 'held'; readonly lease: ExecutionLease }
  | { readonly kind: 'concurrent_modification' }
  | { readonly kind: 'missing' };

/**
 * Outcome of {@link RunbookStore.saveRunResolvingLease}.
 *
 * - `committed` — the one conditional `UPDATE` landed; `state` is what is now
 *   persisted and the row carries no lease.
 * - `concurrent_modification` — the row exists but its `state_version` moved
 *   since the caller read it. Nothing was written. Refused, never retried.
 * - `missing` — no row carries the id. Nothing was written.
 */
export type SaveRunResult =
  | { readonly kind: 'committed'; readonly state: RunbookState }
  | { readonly kind: 'concurrent_modification' }
  | { readonly kind: 'missing' };

/**
 * Outcome of {@link RunbookStore.saveRun}: every {@link SaveRunResult} arm, plus
 *
 * - `execution_leased` — the row is still at the expected version but holds an
 *   execution lease, which this write is not entitled to clear. Nothing was
 *   written.
 */
export type LeaseRefusingSaveResult =
  | SaveRunResult
  | { readonly kind: 'execution_leased'; readonly lease: ExecutionLease };

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
   * Insert a brand-new Inline Child row at `state_version` 0, carrying its
   * linkage and no Owner Token hash of its own.
   *
   * @param state - Initial child run state.
   * @param linkage - The parent coordinate; its `kind` must be `inline`.
   */
  insertInlineChildRun(state: RunbookState, linkage: ChildLinkage): void;
  /**
   * Write a run's state if and only if its `state_version` still equals the
   * expectation and it holds no execution lease.
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
  ): LeaseRefusingSaveResult;
  /**
   * Write a run's state if and only if its `state_version` still equals the
   * expectation, clearing the execution lease that version carries. Only the
   * owner's decision or the leased attempt's finish may write this way.
   *
   * @param runId - Run to write.
   * @param expectedVersion - Version captured when the caller read the run.
   * @param next - The complete state to persist.
   * @returns Why the write did or did not land.
   */
  writeStateResolvingLease(
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
   * Create an Inline Child (#903): a run its parent's Owner Token authorizes,
   * so its row carries no token hash and records its linkage instead.
   *
   * Written by the parent owner's command, which is the only writer of either
   * row; the child never writes its parent.
   *
   * @param state - Initial child run state, carrying the preallocated child id.
   * @param linkage - The parent coordinate; its `kind` must be `inline`.
   * @returns Resolves once committed.
   * @throws {StoreInvariantError} When a row already carries `state.id`, or the
   *   linkage is not `inline`.
   * @throws {Error} When the linkage names a parent no row carries (the
   *   foreign key).
   */
  async createInlineChildRun(state: RunbookState, linkage: ChildLinkage): Promise<void> {
    try {
      await this.transaction((txn) => {
        txn.insertInlineChildRun(state, linkage);
      });
    } catch (error: unknown) {
      throw uniqueViolationAsInvariant(error, state.id);
    }
  }

  /**
   * Claim a Delegation (#904): in one transaction, read the parent, let the
   * caller decide on it whether the reservation is still claimable, and
   * insert the child row under the reservation's preallocated id with its own
   * Owner Token hash, its linkage and the claiming agent.
   *
   * The child's id is the row's primary key, so a second claim of the same
   * reservation is refused by the insert itself (`already_claimed`), whoever
   * races whom. The parent row is read, never written: the child never writes
   * its parent (ADR 0005).
   *
   * @template R - The caller's refusal type.
   * @param input - The parent, the check, and the child row.
   * @returns `claimed`, `already_claimed`, or the check's refusal.
   * @throws {StoreInvariantError} When the linkage is not `delegation`, or the
   *   child's owner token hash is already carried by another row.
   * @throws {InvalidRunbookStateError} When the parent row fails the
   *   persisted-state gates or the structural parse.
   */
  async claimDelegationChild<R>(
    input: ClaimDelegationChildInput<R>,
  ): Promise<ClaimDelegationChildResult<R>> {
    if (input.linkage.kind !== 'delegation') {
      throw new StoreInvariantError(
        `Delegation child ${input.state.id} was handed ${input.linkage.kind} linkage.`,
      );
    }
    try {
      return await this.transaction((txn): ClaimDelegationChildResult<R> => {
        const refusal = input.verify(txn.readStateWithVersion(input.parentRunId));
        if (refusal !== undefined) return { kind: 'refused', refusal };
        try {
          insertChildRun(txn.tx, input.state, input.ownerTokenHash, input.linkage);
        } catch (error: unknown) {
          if (/UNIQUE constraint failed: runs\.id\b/.test(getErrorMessage(error))) {
            return { kind: 'already_claimed' };
          }
          throw error;
        }
        return { kind: 'claimed' };
      });
    } catch (error: unknown) {
      throw uniqueViolationAsInvariant(error, input.state.id);
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
        .prepare(`SELECT ${VERSIONED_ROW_COLUMNS} FROM runs WHERE owner_token_hash = :hash`)
        .get<VersionedRunRow>({ hash: ownerTokenHash });
      return row === undefined ? null : this.validateVersionedRow(row);
    });
  }

  /**
   * Persist a run's complete state if and only if nobody wrote it since the
   * caller read it and it holds no execution lease.
   *
   * One conditional `UPDATE`, one outcome. A `concurrent_modification` is not
   * retried here and must not be retried by the caller either: under one writer
   * per run it means two of the owner's own commands raced, and the second is
   * told so rather than silently serialised behind the first. A held lease is
   * refused `execution_leased`: this write is not the decision about it.
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
  ): Promise<LeaseRefusingSaveResult> {
    assertStateBelongsTo(runId, state);
    return this.transaction((txn) => txn.writeStateAtVersion(runId, expectedVersion, state));
  }

  /**
   * Persist the owner's decision or a leased attempt's finish, clearing the
   * execution lease the expected version carries.
   *
   * The one write that may clear a lease. The caller must have decided about
   * the lease it read at `expectedVersion`: the lifecycle seam applies the
   * lease rule before deriving, and a finish commits only at the version its
   * own lease produced. Otherwise identical to {@link RunbookStore.saveRun}.
   *
   * @param runId - Run to write.
   * @param expectedVersion - The `state_version` the caller read the run at.
   * @param state - The complete state to persist. `lifecycle` defaults to
   *   `running` when absent.
   * @returns `committed` with the persisted state, or a typed refusal.
   * @throws {StoreInvariantError} When `state.id` names a different run than
   *   `runId`.
   */
  saveRunResolvingLease(
    runId: RunId,
    expectedVersion: StateVersion,
    state: RunbookState,
  ): Promise<SaveRunResult> {
    assertStateBelongsTo(runId, state);
    return this.transaction((txn) => txn.writeStateResolvingLease(runId, expectedVersion, state));
  }

  /**
   * Set the run's execution lease immediately before an external effect.
   *
   * One conditional `UPDATE`: it lands only when the row is still at
   * `expectedVersion` and carries no lease. It moves `state_version` to
   * `expectedVersion + 1`, which becomes the lease's `attempt`. The effect must
   * not start unless this returns `acquired`.
   *
   * @param runId - Run whose effect is about to start.
   * @param expectedVersion - The version the caller read the run at.
   * @param holder - The process starting the effect.
   * @returns The acquired lease and its version, or why it was not set.
   * @throws {StoreInvariantError} When the set landed but the row does not read
   *   back at the attempt's version.
   */
  acquireExecutionLease(
    runId: RunId,
    expectedVersion: StateVersion,
    holder: ExecutionLeaseHolder,
  ): Promise<AcquireExecutionLeaseResult> {
    return this.transaction((txn) =>
      acquireLease(txn.tx, runId, expectedVersion, holder, new Date().toISOString()),
    );
  }

  /**
   * List every run row with the version and lease it was read at, in one read.
   *
   * Each row is validated on its own: an unreadable row is reported in place
   * as `invalid` with the error it raised, so a lenient caller can skip it and
   * a strict one can refuse, without either taking a second read. State,
   * version and lease of every entry come from the same snapshot.
   *
   * @returns One entry per row, in ascending id order.
   */
  listRunsWithVersion(): Promise<readonly ListedRun[]> {
    return this.driver.read((tx) =>
      tx
        .prepare(`SELECT ${VERSIONED_ROW_COLUMNS} FROM runs ORDER BY id`)
        .all<VersionedRunRow>()
        .map((row): ListedRun => {
          try {
            return { kind: 'valid', run: this.validateVersionedRow(row) };
          } catch (error: unknown) {
            return { kind: 'invalid', runId: assertRunId(row.id), error };
          }
        }),
    );
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
   * Delete a run row — and with it, by the `runs_unlink_children` trigger, its
   * Inline Children transitively (#903) — if and only if every row the delete
   * removes is still at the version the caller read it at.
   *
   * One conditional delete, one outcome. A caller that decided about the runs
   * it read — including the execution lease each version carries — deletes
   * exactly those runs, never one that moved since (say, an inline child whose
   * next command took the lease) and never an inline descendant it did not
   * read. The inline chain is re-read inside the same writing transaction, so
   * the comparison and the delete see one state. Child linkage of runs that
   * are not inline is cleared by the trigger as for {@link RunbookStore.deleteRun}.
   *
   * @param runId - Run to delete.
   * @param expectedVersion - The `state_version` the caller read the run at.
   * @param expectedInlineDescendants - Every inline descendant of the run, each
   *   with the version the caller read it at; empty when it read none.
   * @returns `deleted`, or why nothing was deleted.
   */
  deleteRunAtVersion(
    runId: RunId,
    expectedVersion: StateVersion,
    expectedInlineDescendants: readonly RunAtVersion[],
  ): Promise<DeleteRunResult> {
    return this.transaction((txn): DeleteRunResult => {
      const root = txn.tx
        .prepare('SELECT state_version FROM runs WHERE id = :id')
        .get<{ readonly state_version: number }>({ id: runId });
      if (root === undefined) return { kind: 'missing' };
      if (
        root.state_version !== expectedVersion ||
        !inlineChainMatches(readInlineDescendants(txn.tx, runId), expectedInlineDescendants)
      ) {
        return { kind: 'concurrent_modification' };
      }
      assertExactlyOneRow(
        txn.tx.prepare('DELETE FROM runs WHERE id = :id').run({ id: runId }).changes,
        runId,
      );
      return { kind: 'deleted' };
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
   * Reassemble a run's persisted JSON without validating its shape.
   *
   * For test fixtures that round-trip state the gates would refuse. The JSON
   * itself must parse: unparseable `state_json` is refused here as everywhere.
   *
   * @param runId - Run to read.
   * @returns The assembled state object, or null when absent.
   * @throws {InvalidRunbookStateError} When `state_json` is not valid JSON.
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
      insertInlineChildRun: (state, linkage) => {
        insertInlineChildRun(tx, state, linkage);
      },
      writeStateAtVersion: (runId, expectedVersion, next) =>
        writeStateRefusingLease(tx, runId, expectedVersion, next),
      writeStateResolvingLease: (runId, expectedVersion, next) =>
        writeStateResolvingLease(tx, runId, expectedVersion, next),
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
      .prepare(`SELECT ${VERSIONED_ROW_COLUMNS} FROM runs WHERE id = :id`)
      .get<VersionedRunRow>({ id: runId });
    return row === undefined ? null : this.validateVersionedRow(row);
  }

  /**
   * Validate one versioned row read in a single statement.
   *
   * The state and its version come from the same row read, so they cannot
   * describe two different writes.
   *
   * @param row - The row as read.
   * @returns The validated state and its version.
   * @throws {LegacySnapshotError} When the row carries a deprecated dynamic-step
   *   snapshot shape.
   * @throws {InvalidRunbookStateError} When the row fails the persisted-state
   *   gates or the structural parse.
   */
  private validateVersionedRow(row: VersionedRunRow): VersionedRunState {
    const runId = assertRunId(row.id);
    return {
      state: this.validateRaw(assembleRaw(row, runId), runId),
      stateVersion: assertStateVersion(row.state_version),
      lease: leaseFromRow(row),
      linkage: linkageFromRow(row),
    };
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
    return raw === null ? null : this.validateRaw(raw, runId);
  }

  /**
   * Gate and structurally parse an assembled run object.
   *
   * @param raw - The assembled, unvalidated state object.
   * @param runId - Run the object was read for.
   * @returns The validated run state.
   * @throws {LegacySnapshotError} When the object carries a deprecated
   *   dynamic-step snapshot shape.
   * @throws {InvalidRunbookStateError} When the object fails the persisted-state
   *   gates or the structural parse.
   */
  private validateRaw(raw: Record<string, unknown>, runId: RunId): RunbookState {
    assertLoadablePersistedRun(raw, runId);
    return parsePersistedRunState(raw, runId, this.stateSchema);
  }
}

/**
 * Read a run's Inline Children, transitively, with their versions.
 *
 * Exactly the rows the `runs_unlink_children` trigger deletes with the run.
 *
 * @param tx - Open transaction.
 * @param runId - The run whose inline descendants to read.
 * @returns Each inline descendant and its `state_version`.
 */
function readInlineDescendants(tx: SqlReadTransaction, runId: RunId): readonly RunAtVersion[] {
  return tx
    .prepare(
      `WITH RECURSIVE inline_descendants(id) AS (
         SELECT id FROM runs WHERE parent_run_id = :id AND parent_kind = 'inline'
         UNION
         SELECT runs.id FROM runs
           JOIN inline_descendants ON runs.parent_run_id = inline_descendants.id
          WHERE runs.parent_kind = 'inline'
       )
       SELECT runs.id, runs.state_version FROM runs
         JOIN inline_descendants ON runs.id = inline_descendants.id`,
    )
    .all<{ readonly id: string; readonly state_version: number }>({ id: runId })
    .map((row) => ({
      runId: assertRunId(row.id),
      stateVersion: assertStateVersion(row.state_version),
    }));
}

/**
 * Whether the inline chain as stored is exactly the one the caller read: the
 * same runs, each at the same version.
 *
 * @param stored - The inline descendants as read inside the delete.
 * @param expected - The inline descendants as the caller read them.
 * @returns True when both name the same runs at the same versions.
 */
function inlineChainMatches(
  stored: readonly RunAtVersion[],
  expected: readonly RunAtVersion[],
): boolean {
  if (stored.length !== expected.length) return false;
  const expectedVersions = new Map(expected.map((run) => [run.runId, run.stateVersion]));
  return stored.every((run) => expectedVersions.get(run.runId) === run.stateVersion);
}

/** The lease column group. */
const LEASE_COLUMNS = 'lease_attempt, lease_pid, lease_start_id, lease_started_at';

/** The child-linkage column group. */
const LINKAGE_COLUMNS =
  'parent_run_id, parent_step, parent_frame_key, parent_entry, parent_kind, claim_agent_id';

/** Columns a versioned read selects: everything a validated, versioned state needs. */
const VERSIONED_ROW_COLUMNS = `id, state_version, lifecycle, state_json, ${LEASE_COLUMNS}, ${LINKAGE_COLUMNS}`;

/** The child-linkage column group as read. All-or-none under the table's `CHECK`. */
type LinkageRow = {
  readonly parent_run_id: string | null;
  readonly parent_step: string | null;
  readonly parent_frame_key: string | null;
  readonly parent_entry: number | null;
  readonly parent_kind: string | null;
  readonly claim_agent_id: string | null;
};

/** The lease column group as read. All-or-none under the table's `CHECK`. */
type LeaseRow = {
  readonly lease_attempt: number | null;
  readonly lease_pid: number | null;
  readonly lease_start_id: string | null;
  readonly lease_started_at: string | null;
};

/** One `runs` row as a versioned read selects it. */
type VersionedRunRow = PersistedRunRow &
  LeaseRow &
  LinkageRow & {
    readonly id: string;
    readonly state_version: number;
  };

/**
 * Read the lease column group, or null when no lease is set.
 *
 * @param row - The lease columns as read.
 * @returns The lease, or null.
 */
function leaseFromRow(row: LeaseRow): ExecutionLease | null {
  if (row.lease_attempt === null || row.lease_pid === null || row.lease_started_at === null) {
    return null;
  }
  return {
    attempt: row.lease_attempt,
    pid: row.lease_pid,
    startId: row.lease_start_id,
    startedAt: row.lease_started_at,
  };
}

/**
 * Read the child-linkage column group, or null for a top-level run.
 *
 * @param row - The linkage columns as read.
 * @returns The linkage, or null.
 * @throws {StoreInvariantError} When the kind is outside the closed union — a
 *   tampered schema, since the column's `CHECK` pins it.
 */
function linkageFromRow(row: LinkageRow): ChildLinkage | null {
  if (
    row.parent_run_id === null ||
    row.parent_step === null ||
    row.parent_frame_key === null ||
    row.parent_entry === null ||
    row.parent_kind === null
  ) {
    return null;
  }
  return {
    kind: assertChildKind(row.parent_kind),
    parentRunId: assertRunId(row.parent_run_id),
    parentStep: row.parent_step,
    parentFrameKey: row.parent_frame_key as FrameKey,
    parentEntry: row.parent_entry,
    ...(row.claim_agent_id !== null ? { claimedBy: row.claim_agent_id } : {}),
  };
}

/**
 * Narrow a persisted `parent_kind` to {@link ChildKind}.
 *
 * @param value - The column value.
 * @returns The kind.
 * @throws {StoreInvariantError} When the value is not a known kind.
 */
function assertChildKind(value: string): ChildKind {
  if (value !== 'inline' && value !== 'delegation') {
    throw new StoreInvariantError(`Invalid persisted parent kind: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Set a run's execution lease under one conditional `UPDATE`.
 *
 * @param tx - Open writing transaction.
 * @param runId - Run to lease.
 * @param expectedVersion - Version the caller read the run at.
 * @param holder - Process starting the effect.
 * @param startedAt - ISO-8601 time the lease is set.
 * @returns The acquired lease, or why it was not set.
 * @throws {StoreInvariantError} When the set landed but the row does not read
 *   back at the attempt's version — a tampered schema, not a race.
 */
function acquireLease(
  tx: SqlTransaction,
  runId: RunId,
  expectedVersion: StateVersion,
  holder: ExecutionLeaseHolder,
  startedAt: string,
): AcquireExecutionLeaseResult {
  const attempt = expectedVersion + 1;
  const changes = tx
    .prepare(
      `UPDATE runs
          SET lease_attempt = :attempt, lease_pid = :pid,
              lease_start_id = :startId, lease_started_at = :startedAt
        WHERE id = :id
          AND state_version = :expectedVersion
          AND lease_attempt IS NULL`,
    )
    .run({
      id: runId,
      attempt,
      pid: holder.pid,
      startId: holder.startId,
      startedAt,
      expectedVersion,
    }).changes;
  const row = tx
    .prepare(`SELECT state_version, ${LEASE_COLUMNS} FROM runs WHERE id = :id`)
    .get<LeaseRow & { readonly state_version: number }>({ id: runId });
  if (row === undefined) return { kind: 'missing' };
  const lease = leaseFromRow(row);
  if (changes === 1) {
    // The trigger moved the version to exactly the attempt; anything else is a
    // tampered schema, not a race.
    if (row.state_version !== attempt || lease === null) {
      throw new StoreInvariantError(
        `Lease for run ${runId} set attempt ${String(attempt)} but the row reads version ${String(row.state_version)}.`,
      );
    }
    return { kind: 'acquired', lease, stateVersion: assertStateVersion(attempt) };
  }
  if (lease !== null && row.state_version === expectedVersion) return { kind: 'held', lease };
  return { kind: 'concurrent_modification' };
}

/** The columns a run state is reassembled from. */
type PersistedRunRow = {
  readonly lifecycle: string;
  readonly state_json: string;
};

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
 * Insert a new Inline Child row at `state_version` 0: no Owner Token hash, and
 * the linkage group set in the same statement.
 *
 * @param tx - Open writing transaction.
 * @param state - Initial child run state.
 * @param linkage - The parent coordinate.
 * @throws {StoreInvariantError} When the linkage is not `inline`.
 */
function insertInlineChildRun(
  tx: SqlTransaction,
  state: RunbookState,
  linkage: ChildLinkage,
): void {
  if (linkage.kind !== 'inline') {
    throw new StoreInvariantError(
      `Inline child ${state.id} was handed ${linkage.kind} linkage; only an inline child carries no token.`,
    );
  }
  insertChildRun(tx, state, null, linkage);
}

/**
 * Insert a new Child Run row at `state_version` 0 with its linkage group, its
 * Owner Token hash (`null` for an Inline Child) and, for a Delegation, the
 * claiming agent.
 *
 * @param tx - Open writing transaction.
 * @param state - Initial child run state.
 * @param ownerTokenHash - Hash of the child's own Owner Token, or `null`.
 * @param linkage - The parent coordinate.
 */
function insertChildRun(
  tx: SqlTransaction,
  state: RunbookState,
  ownerTokenHash: SecretHash | null,
  linkage: ChildLinkage,
): void {
  tx.prepare(
    `INSERT INTO runs (id, lifecycle, owner_token_hash,
       parent_run_id, parent_step, parent_frame_key, parent_entry, parent_kind, claim_agent_id,
       state_version, state_json, created_at, updated_at)
     VALUES (:id, :lifecycle, :ownerTokenHash,
       :parentRunId, :parentStep, :parentFrameKey, :parentEntry, :parentKind, :claimAgentId,
       0, :stateJson, :startedAt, :updatedAt)`,
  ).run({
    id: state.id,
    lifecycle: state.lifecycle ?? 'running',
    ownerTokenHash,
    parentRunId: linkage.parentRunId,
    parentStep: linkage.parentStep,
    parentFrameKey: linkage.parentFrameKey,
    parentEntry: linkage.parentEntry,
    parentKind: linkage.kind,
    claimAgentId: linkage.claimedBy ?? null,
    stateJson: serializeStateJson(state),
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
  });
}

/**
 * Refuse a state handed to a write for another run.
 *
 * @param runId - Run the write targets.
 * @param state - State to persist.
 * @throws {StoreInvariantError} When `state.id` names a different run.
 */
function assertStateBelongsTo(runId: RunId, state: RunbookState): void {
  if (state.id !== runId) {
    throw new StoreInvariantError(
      `saveRun for ${runId} was handed state belonging to ${String(state.id)}.`,
    );
  }
}

/** Named parameters bound by both state writes. */
type StateWriteParams = {
  readonly id: RunId;
  readonly stateJson: string;
  readonly lifecycle: Lifecycle;
  readonly updatedAt: string;
  readonly expectedVersion: StateVersion;
};

/**
 * The bound parameters of a state write.
 *
 * @param runId - Run to write.
 * @param expectedVersion - Version captured at read.
 * @param next - New state.
 * @returns Named parameters for the conditional `UPDATE`.
 */
function stateWriteParams(
  runId: RunId,
  expectedVersion: StateVersion,
  next: RunbookState,
): StateWriteParams {
  return {
    id: runId,
    stateJson: serializeStateJson(next),
    lifecycle: next.lifecycle ?? 'running',
    updatedAt: next.updatedAt,
    expectedVersion,
  };
}

/**
 * Write run state under the one conditional `UPDATE`, clearing the execution
 * lease the expected version carries. The decision's and the finish's write.
 *
 * @param tx - Open writing transaction.
 * @param runId - Run to write.
 * @param expectedVersion - Version captured at read.
 * @param next - New state.
 * @returns Why the write did or did not land.
 */
function writeStateResolvingLease(
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
              updated_at = :updatedAt,
              lease_attempt = NULL, lease_pid = NULL,
              lease_start_id = NULL, lease_started_at = NULL
        WHERE id = :id
          AND state_version = :expectedVersion`,
    )
    .run(stateWriteParams(runId, expectedVersion, next)).changes;
  if (changes === 1) {
    return { kind: 'committed', state: next };
  }
  const present = tx
    .prepare('SELECT 1 AS present FROM runs WHERE id = :id')
    .get<{ readonly present: 1 }>({ id: runId });
  return present === undefined ? { kind: 'missing' } : { kind: 'concurrent_modification' };
}

/**
 * Write run state under the one conditional `UPDATE`, only on a row that holds
 * no execution lease. Every write that is not a decision about the lease.
 *
 * @param tx - Open writing transaction.
 * @param runId - Run to write.
 * @param expectedVersion - Version captured at read.
 * @param next - New state.
 * @returns Why the write did or did not land.
 */
function writeStateRefusingLease(
  tx: SqlTransaction,
  runId: RunId,
  expectedVersion: StateVersion,
  next: RunbookState,
): LeaseRefusingSaveResult {
  const changes = tx
    .prepare(
      `UPDATE runs
          SET state_json = :stateJson,
              lifecycle  = :lifecycle,
              updated_at = :updatedAt
        WHERE id = :id
          AND state_version = :expectedVersion
          AND lease_attempt IS NULL`,
    )
    .run(stateWriteParams(runId, expectedVersion, next)).changes;
  if (changes === 1) {
    return { kind: 'committed', state: next };
  }
  const row = tx
    .prepare(`SELECT state_version, ${LEASE_COLUMNS} FROM runs WHERE id = :id`)
    .get<LeaseRow & { readonly state_version: number }>({ id: runId });
  if (row === undefined) return { kind: 'missing' };
  const lease = leaseFromRow(row);
  if (lease !== null && row.state_version === expectedVersion) {
    return { kind: 'execution_leased', lease };
  }
  return { kind: 'concurrent_modification' };
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
    .get<PersistedRunRow>({ id: runId });
  return row === undefined ? null : assembleRaw(row, runId);
}

/**
 * Reassemble a run's full state object from its row, unvalidated: `state_json`
 * plus the `lifecycle` column, whose home is outside the JSON.
 *
 * Every reader of a row comes through here, so unparseable `state_json` is
 * refused once, in the persisted-state taxonomy (RD-309), rather than escaping
 * one reader as a bare `SyntaxError` that a frontend can only render as an
 * internal error.
 *
 * @param row - The row's state columns.
 * @param runId - Run the row belongs to, named by the refusal.
 * @returns The assembled object.
 * @throws {InvalidRunbookStateError} When `state_json` is not valid JSON
 *   (`unparseable_json`).
 * @throws {Error} When the lifecycle column holds an unknown value.
 */
function assembleRaw(row: PersistedRunRow, runId: RunId): Record<string, unknown> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(row.state_json) as Record<string, unknown>;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new InvalidRunbookStateError(
        `Invalid runbook state for "${runId}": persisted state is not valid JSON.`,
        { runId, reason: 'unparseable_json' },
      );
    }
    throw error;
  }
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
