/**
 * Typed transactional repository over the SQLite runbook schema.
 *
 * `transaction()` is the sole write path; read helpers use short read
 * transactions. Every raw row is validated at this edge (Zod for run state,
 * explicit shape checks for coordinated rows) so no unvalidated row escapes the
 * store. The two run counters (`state_version`, `claim_generation`) are owned by
 * the structural triggers in `schema.ts`, never written directly here.
 *
 * The coordinated fields — claims, resolved completions, the default stack, and
 * the stash slot — live in their own tables and are their sole authority; they
 * are excluded from `runs.state_json`, which holds only the rest of
 * `RunbookState` plus the inline machine snapshot.
 *
 * @module runbook/storage/runbook-store
 */

import { z } from 'zod';
import { makeRunbookStateSchema } from '../../schemas.js';
import type { RunbookState, ResolvedCompletion, Lifecycle } from '../types.js';
import { type RunId, assertRunId } from '../run-id.js';
import {
  type ClaimRecord,
  type ClaimLookupKey,
  assertClaimLookupKey,
  assertClaimSecretHash,
} from '../claim-id.js';
import type { SessionData } from '../state.js';
import type { SqlDriver, SqlTransaction } from './sql-driver.js';
import {
  type CapturedAuthority,
  type ClaimGeneration,
  type ExecutionEpoch,
  type GuardedMutationResult,
  assertClaimGeneration,
  assertStateVersion,
  assertExecutionEpoch,
  assertLinkageVersion,
  assertExecutionTokenHash,
  verifyExecutionToken,
  type ExecutionToken,
} from './mutation-result.js';

/** Machine lifecycle values persisted in the `runs.lifecycle` column. */
const LIFECYCLES: readonly Lifecycle[] = ['running', 'completed', 'stopped'];

/** Execution phases persisted in `execution_attempts.phase`. */
export type ExecutionPhase = 'claimed' | 'effect_started' | 'recovery_pending' | 'committed';

/**
 * Raised when a classified-success guarded write changes anything other than
 * exactly one row. A `SELECT`-classified success followed by a zero-row (or
 * multi-row) authoritative `UPDATE` is an invariant violation: the transaction
 * rolls back and this surfaces, never a `committed` result.
 */
export class StoreInvariantError extends Error {
  /**
   * Construct a store-invariant error.
   *
   * @param message - Human-readable invariant description.
   */
  constructor(message: string) {
    super(message);
    this.name = 'StoreInvariantError';
  }
}

/**
 * Assert a guarded authoritative write changed exactly one row.
 *
 * @param changes - Rows changed by the authoritative UPDATE.
 * @param runId - Target run, for the error message.
 * @throws {StoreInvariantError} When `changes` is not exactly 1.
 */
export function assertExactlyOneRow(changes: number, runId: RunId): void {
  if (changes !== 1) {
    throw new StoreInvariantError(
      `Guarded write for ${runId} changed ${String(changes)} rows after a success classification; rolled back.`,
    );
  }
}

/** Raw `claims` columns. */
type ClaimRow = {
  readonly key: string;
  readonly controlled_run: string;
  readonly secret_hash: string;
  readonly issued_generation: number;
  readonly status: string;
  readonly parent_run_id: string | null;
  readonly parent_linkage_version: number | null;
  readonly delegation_json: string | null;
  readonly grants_json: string;
  readonly issued_at: string;
  readonly updated_at: string;
  readonly last_seen_at: string;
};

/**
 * The joined row the commit protocol classifies. Mirrors the design spec's
 * commit `SELECT`: runs, the presented claim, its parent, and the active attempt.
 */
export interface CommitRow {
  /** Whether the target run exists. */
  readonly runPresent: boolean;
  /** Current run state version. */
  readonly stateVersion: number;
  /** Current run claim generation. */
  readonly claimGeneration: number;
  /** Whether the presented claim exists. */
  readonly claimPresent: boolean;
  /** Presented claim status (`active` | `superseded`), or null when absent. */
  readonly claimStatus: string | null;
  /** Whether the presented claim controls the target run (#613 unification). */
  readonly claimControlsRun: boolean;
  /** Parent run id for a delegated claim, else null. */
  readonly parentId: string | null;
  /** Parent lifecycle for a delegated claim, else null. */
  readonly parentLifecycle: string | null;
  /** Parent linkage version for a delegated claim, else null. */
  readonly parentLinkageVersion: number | null;
  /** Active attempt's hashed token, or null when unowned. */
  readonly execToken: string | null;
  /** Active attempt's epoch, or null when unowned. */
  readonly execEpoch: number | null;
  /** Active attempt's phase, or null when unowned. */
  readonly execPhase: string | null;
}

/**
 * Owner-commit expectation for the execution identity, supplied by an effectful
 * mutation. Absent for a state-only mutation, which requires the run to be
 * unowned.
 */
export interface ExecutionExpectation {
  /** Raw token the owner must present. */
  readonly token: ExecutionToken;
  /** Epoch the owner must match. */
  readonly epoch: ExecutionEpoch;
}

/** Result of classifying a commit row. `ok` means the authoritative write may proceed. */
export type CommitClassification =
  | { readonly kind: 'ok' }
  | { readonly kind: 'claim_superseded'; readonly runId: RunId; readonly message: string }
  | { readonly kind: 'concurrent_modification'; readonly runId: RunId; readonly message: string }
  | { readonly kind: 'execution_in_progress'; readonly runId: RunId; readonly message: string }
  | {
      readonly kind: 'recovery_required';
      readonly runId: RunId;
      readonly epoch: ExecutionEpoch;
      readonly message: string;
    }
  | { readonly kind: 'missing'; readonly runId: RunId; readonly message: string };

/**
 * Total, exhaustive commit-row classifier.
 *
 * The `SELECT` decides the outcome because a zero-row `UPDATE` is ambiguous
 * between "run gone" and "generation moved". This function encodes that decision
 * once. Order matters: existence, then claim validity (including the #613
 * caller/target unification and delegated-parent liveness), then lost-update,
 * then execution identity.
 *
 * @param row - The joined commit row.
 * @param captured - Authority captured before the effect.
 * @param execution - Owner-commit expectation, or undefined for a state-only
 *   (must-be-unowned) mutation.
 * @returns The classification; `ok` permits the authoritative write.
 */
export function classifyCommitRow(
  row: CommitRow,
  captured: CapturedAuthority,
  execution?: ExecutionExpectation,
): CommitClassification {
  const runId = captured.runId;
  if (!row.runPresent) {
    return { kind: 'missing', runId, message: `Run ${runId} no longer exists.` };
  }
  if (!row.claimPresent || !row.claimControlsRun || row.claimStatus !== 'active') {
    return {
      kind: 'claim_superseded',
      runId,
      message: `The presented claim no longer controls run ${runId}.`,
    };
  }
  if (row.claimGeneration !== captured.claimGeneration) {
    return {
      kind: 'claim_superseded',
      runId,
      message: `Run ${runId} claim generation advanced since it was captured.`,
    };
  }
  if (captured.parent) {
    const parentTerminal = row.parentLifecycle === 'completed' || row.parentLifecycle === 'stopped';
    if (
      row.parentId !== captured.parent.runId ||
      parentTerminal ||
      row.parentLinkageVersion !== captured.parent.linkageVersion
    ) {
      return {
        kind: 'claim_superseded',
        runId,
        message: `The delegated parent of run ${runId} is missing, terminal, or relinked.`,
      };
    }
  }
  if (row.stateVersion !== captured.stateVersion) {
    return {
      kind: 'concurrent_modification',
      runId,
      message: `Run ${runId} was modified concurrently.`,
    };
  }
  return classifyExecution(row, runId, execution);
}

/**
 * Classify the execution-identity dimension of a commit row.
 *
 * @param row - The joined commit row.
 * @param runId - Target run.
 * @param execution - Owner-commit expectation, or undefined for a state-only
 *   mutation.
 * @returns `ok`, or an execution-related refusal.
 */
function classifyExecution(
  row: CommitRow,
  runId: RunId,
  execution: ExecutionExpectation | undefined,
): CommitClassification {
  if (execution === undefined) {
    // State-only mutation: the run must be unowned.
    if (row.execToken !== null) {
      return {
        kind: 'execution_in_progress',
        runId,
        message: `Run ${runId} has an execution in progress.`,
      };
    }
    return { kind: 'ok' };
  }
  // Owner commit: the exact token/epoch must still own an effect-started attempt.
  const epoch = assertExecutionEpoch(execution.epoch);
  if (row.execEpoch !== execution.epoch || row.execToken === null) {
    return {
      kind: 'execution_in_progress',
      runId,
      message: `Run ${runId} is owned by a different execution attempt.`,
    };
  }
  if (!verifyExecutionToken(execution.token, assertExecutionTokenHash(row.execToken))) {
    return {
      kind: 'execution_in_progress',
      runId,
      message: `Run ${runId} is owned by a different execution attempt.`,
    };
  }
  if (row.execPhase !== 'effect_started') {
    return {
      kind: 'recovery_required',
      runId,
      epoch,
      message: `Run ${runId} needs recovery: its execution outcome is unknown.`,
    };
  }
  return { kind: 'ok' };
}

const COMMIT_ROW_SQL = `
  SELECT
    r.id                     AS run_present,
    r.state_version          AS state_version,
    r.claim_generation       AS claim_generation,
    c.key                    AS claim_key,
    c.status                 AS claim_status,
    c.controlled_run         AS controlled_run,
    p.id                     AS parent_id,
    p.lifecycle              AS parent_lifecycle,
    c.parent_linkage_version AS parent_linkage_version,
    r.exec_token             AS exec_token,
    r.exec_epoch             AS exec_epoch,
    a.phase                  AS exec_phase
  FROM runs r
  LEFT JOIN claims c ON c.key = :claimKey
  LEFT JOIN runs p ON p.id = c.parent_run_id
  LEFT JOIN execution_attempts a ON a.run_id = r.id AND a.exec_epoch = r.exec_epoch
  WHERE r.id = :runId
`;

type RawCommitRow = {
  readonly run_present: string | null;
  readonly state_version: number;
  readonly claim_generation: number;
  readonly claim_key: string | null;
  readonly claim_status: string | null;
  readonly controlled_run: string | null;
  readonly parent_id: string | null;
  readonly parent_lifecycle: string | null;
  readonly parent_linkage_version: number | null;
  readonly exec_token: string | null;
  readonly exec_epoch: number | null;
  readonly exec_phase: string | null;
};

/**
 * Read the joined commit row for a run and a presented claim key.
 *
 * Returns a `runPresent: false` row when the run is absent so the classifier can
 * distinguish `missing` from `claim_superseded`.
 *
 * @param tx - Open transaction.
 * @param runId - Target run.
 * @param claimKey - Presented claim lookup key.
 * @returns The commit row.
 */
export function selectCommitRow(
  tx: SqlTransaction,
  runId: RunId,
  claimKey: ClaimLookupKey,
): CommitRow {
  const raw = tx.prepare(COMMIT_ROW_SQL).get<RawCommitRow>({ runId, claimKey });
  if (raw === undefined) {
    return {
      runPresent: false,
      stateVersion: 0,
      claimGeneration: 0,
      claimPresent: false,
      claimStatus: null,
      claimControlsRun: false,
      parentId: null,
      parentLifecycle: null,
      parentLinkageVersion: null,
      execToken: null,
      execEpoch: null,
      execPhase: null,
    };
  }
  const claimPresent = raw.claim_key !== null;
  return {
    runPresent: true,
    stateVersion: raw.state_version,
    claimGeneration: raw.claim_generation,
    claimPresent,
    claimStatus: raw.claim_status,
    claimControlsRun: claimPresent && raw.controlled_run === runId,
    parentId: raw.parent_id,
    parentLifecycle: raw.parent_lifecycle,
    parentLinkageVersion: raw.parent_linkage_version,
    execToken: raw.exec_token,
    execEpoch: raw.exec_epoch,
    execPhase: raw.exec_phase,
  };
}

/** Outcome of capturing authority before an effectful mutation. */
export type CaptureResult =
  | { readonly kind: 'captured'; readonly authority: CapturedAuthority }
  | { readonly kind: 'missing'; readonly runId: RunId; readonly message: string }
  | { readonly kind: 'claim_superseded'; readonly runId: RunId; readonly message: string };

/**
 * Capture the complete authority predicate for a run + presented claim.
 *
 * Unifies the caller-presented claim and the mutation-target claim into one
 * captured fact (#613): if the presented claim does not control the target run,
 * or is a tombstone, the divergence is refused rather than silently resolved to
 * the target.
 *
 * @param tx - Open transaction.
 * @param runId - Target run.
 * @param claimKey - Presented claim lookup key.
 * @returns The captured authority, or a typed refusal.
 */
export function captureAuthority(
  tx: SqlTransaction,
  runId: RunId,
  claimKey: ClaimLookupKey,
): CaptureResult {
  const row = selectCommitRow(tx, runId, claimKey);
  if (!row.runPresent) {
    return { kind: 'missing', runId, message: `Run ${runId} does not exist.` };
  }
  if (!row.claimPresent || !row.claimControlsRun || row.claimStatus !== 'active') {
    return {
      kind: 'claim_superseded',
      runId,
      message: `The presented claim does not control run ${runId}.`,
    };
  }
  const parent =
    row.parentId !== null && row.parentLinkageVersion !== null
      ? {
          runId: assertRunId(row.parentId),
          linkageVersion: assertLinkageVersion(row.parentLinkageVersion),
        }
      : undefined;
  return {
    kind: 'captured',
    authority: {
      runId,
      claimKey,
      claimGeneration: assertClaimGeneration(row.claimGeneration),
      stateVersion: assertStateVersion(row.stateVersion),
      ...(parent ? { parent } : {}),
    },
  };
}

/** Sync typed operations available inside a store write transaction. */
export interface RunbookStoreTxn {
  /** Underlying transaction, for advanced/composite operations within the store. */
  readonly tx: SqlTransaction;
  /** Insert a brand-new run at version/generation 0. */
  insertRun(state: RunbookState): void;
  /** Read the joined commit row for a run + claim. */
  commitRow(runId: RunId, claimKey: ClaimLookupKey): CommitRow;
  /**
   * Apply a guarded, unowned state update under the captured CAS. Returns the
   * changed-row count so the caller can assert exactly one row.
   */
  applyStateUpdate(captured: CapturedAuthority, next: RunbookState): number;
  /** Delete a run and its cascaded rows. */
  deleteRun(runId: RunId): void;
  /** Insert a claim row (fires the generation-bump trigger on the controlled run). */
  insertClaim(record: ClaimRecord, issuedGeneration: ClaimGeneration): void;
  /** Mark a claim superseded (tombstone). Idempotent. */
  tombstoneClaim(key: ClaimLookupKey): void;
  /** Refresh a claim's #519 activity timestamp. */
  recordClaimSeen(key: ClaimLookupKey, now: string): void;
  /** Replace the default stack with the given ordered run ids. */
  setStack(runIds: readonly RunId[]): void;
  /** Set (or clear, with null) the single stash slot. */
  setStash(runId: RunId | null): void;
  /** Read the current default stack. */
  stack(): readonly RunId[];
  /** Read the current stash slot. */
  stash(): RunId | null;
}

/**
 * Transactional SQLite repository for runbook state, claims, and session data.
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
    private readonly cwd: string,
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
  transaction<T>(work: (txn: RunbookStoreTxn) => T): Promise<T> {
    return this.driver.immediate((tx) => work(this.ops(tx)));
  }

  /**
   * Run read work in one short read transaction.
   *
   * @template T - Value the work returns.
   * @param work - Synchronous callback receiving typed transaction operations.
   * @returns The work's return value.
   */
  read<T>(work: (txn: RunbookStoreTxn) => T): Promise<T> {
    return this.driver.read((tx) => work(this.ops(tx)));
  }

  /**
   * Create a brand-new run.
   *
   * @param state - Initial run state.
   * @returns Resolves once committed.
   */
  createRun(state: RunbookState): Promise<void> {
    return this.transaction((txn) => {
      txn.insertRun(state);
    });
  }

  /**
   * Load a run by id, or null when absent.
   *
   * @param runId - Run to load.
   * @returns The validated run state, or null.
   */
  loadRun(runId: RunId): Promise<RunbookState | null> {
    return this.driver.read((tx) => this.readRun(tx, runId));
  }

  /**
   * List all run ids.
   *
   * @returns All run ids in ascending id order.
   */
  listRunIds(): Promise<readonly RunId[]> {
    return this.driver.read((tx) =>
      tx
        .prepare('SELECT id FROM runs ORDER BY id')
        .all<{ readonly id: string }>()
        .map((r) => assertRunId(r.id)),
    );
  }

  /**
   * Capture authority for a run + presented claim in a read transaction.
   *
   * @param runId - Target run.
   * @param claimKey - Presented claim lookup key.
   * @returns The captured authority or a typed refusal.
   */
  captureAuthority(runId: RunId, claimKey: ClaimLookupKey): Promise<CaptureResult> {
    return this.driver.read((tx) => captureAuthority(tx, runId, claimKey));
  }

  /**
   * Load the project session (default stack, stash slot, claims).
   *
   * @returns The reconstructed session data.
   */
  loadSession(): Promise<SessionData> {
    return this.driver.read((tx) => this.readSession(tx));
  }

  /**
   * Apply a guarded, state-only mutation under a previously-captured authority.
   *
   * Re-selects and classifies the commit row inside a fresh short transaction, so
   * a change between capture and write surfaces as `concurrent_modification`,
   * `claim_superseded`, `execution_in_progress`, or `missing`. On `ok`, the
   * authoritative UPDATE runs under the captured CAS and must change exactly one
   * row.
   *
   * @param captured - Authority captured earlier by {@link captureAuthority}.
   * @param next - The new run state to persist.
   * @returns The committed state, or a typed refusal.
   */
  saveState(
    captured: CapturedAuthority,
    next: RunbookState,
  ): Promise<GuardedMutationResult<RunbookState>> {
    return this.transaction((txn) => {
      const row = txn.commitRow(captured.runId, captured.claimKey);
      const classification = classifyCommitRow(row, captured);
      if (classification.kind !== 'ok') {
        return classificationToResult(classification);
      }
      assertExactlyOneRow(txn.applyStateUpdate(captured, next), captured.runId);
      return { kind: 'committed', value: next };
    });
  }

  /**
   * Build the typed operation facade over an open transaction.
   *
   * @param tx - Open transaction.
   * @returns Typed store operations.
   */
  private ops(tx: SqlTransaction): RunbookStoreTxn {
    const store = this;
    return {
      tx,
      insertRun(state) {
        store.insertRun(tx, state);
      },
      commitRow(runId, claimKey) {
        return selectCommitRow(tx, runId, claimKey);
      },
      applyStateUpdate(captured, next) {
        return store.applyStateUpdate(tx, captured, next);
      },
      deleteRun(runId) {
        tx.prepare('DELETE FROM runs WHERE id = :id').run({ id: runId });
      },
      insertClaim(record, issuedGeneration) {
        store.insertClaim(tx, record, issuedGeneration);
      },
      tombstoneClaim(key) {
        tx.prepare("UPDATE claims SET status = 'superseded' WHERE key = :key").run({ key });
      },
      recordClaimSeen(key, now) {
        tx.prepare('UPDATE claims SET last_seen_at = :now WHERE key = :key').run({ key, now });
      },
      setStack(runIds) {
        store.setStack(tx, runIds);
      },
      setStash(runId) {
        store.setStash(tx, runId);
      },
      stack() {
        return store.readStack(tx);
      },
      stash() {
        return store.readStash(tx);
      },
    };
  }

  /**
   * Insert a new run row plus its resolved-completion rows.
   *
   * @param tx - Open transaction.
   * @param state - Initial run state.
   */
  private insertRun(tx: SqlTransaction, state: RunbookState): void {
    const now = state.updatedAt;
    tx.prepare(
      `INSERT INTO runs (id, state_version, claim_generation, lifecycle, state_json, created_at, updated_at)
       VALUES (:id, 0, 0, :lifecycle, :stateJson, :startedAt, :updatedAt)`,
    ).run({
      id: state.id,
      lifecycle: state.lifecycle ?? 'running',
      stateJson: serializeStateJson(state),
      startedAt: state.startedAt,
      updatedAt: now,
    });
    this.writeResolvedCompletions(tx, state.id, state.resolvedCompletions);
  }

  /**
   * Apply a guarded, unowned state update under the captured CAS.
   *
   * The `WHERE` requires the captured `state_version` and `claim_generation` and
   * `exec_token IS NULL` (unowned). The `state_version` bump is owned by the
   * trigger, not written here. Returns the changed-row count.
   *
   * @param tx - Open transaction.
   * @param captured - Captured authority.
   * @param next - New run state.
   * @returns Rows changed by the authoritative UPDATE.
   */
  private applyStateUpdate(
    tx: SqlTransaction,
    captured: CapturedAuthority,
    next: RunbookState,
  ): number {
    const result = tx
      .prepare(
        `UPDATE runs
            SET state_json = :stateJson,
                lifecycle  = :lifecycle,
                updated_at = :updatedAt
          WHERE id = :id
            AND state_version = :stateVersion
            AND claim_generation = :claimGeneration
            AND exec_token IS NULL`,
      )
      .run({
        id: captured.runId,
        stateJson: serializeStateJson(next),
        lifecycle: next.lifecycle ?? 'running',
        updatedAt: next.updatedAt,
        stateVersion: captured.stateVersion,
        claimGeneration: captured.claimGeneration,
      });
    if (result.changes === 1) {
      this.writeResolvedCompletions(tx, captured.runId, next.resolvedCompletions);
    }
    return result.changes;
  }

  /**
   * Replace a run's resolved-completion rows.
   *
   * @param tx - Open transaction.
   * @param runId - Run whose completions to replace.
   * @param completions - New completion map, or undefined for none.
   */
  private writeResolvedCompletions(
    tx: SqlTransaction,
    runId: RunId,
    completions: Readonly<Record<string, ResolvedCompletion>> | undefined,
  ): void {
    tx.prepare('DELETE FROM resolved_completions WHERE run_id = :runId').run({ runId });
    if (completions === undefined) {
      return;
    }
    const insert = tx.prepare(
      `INSERT INTO resolved_completions (run_id, completion_key, payload_json, created_at)
       VALUES (:runId, :key, :payload, :createdAt)`,
    );
    for (const [key, completion] of Object.entries(completions)) {
      insert.run({
        runId,
        key,
        payload: JSON.stringify(completion),
        createdAt: completion.completedAt,
      });
    }
  }

  /**
   * Insert a claim row.
   *
   * @param tx - Open transaction.
   * @param record - Claim record to persist.
   * @param issuedGeneration - Generation captured as issuance metadata.
   */
  private insertClaim(
    tx: SqlTransaction,
    record: ClaimRecord,
    issuedGeneration: ClaimGeneration,
  ): void {
    tx.prepare(
      `INSERT INTO claims
         (key, controlled_run, secret_hash, issued_generation, status,
          parent_run_id, parent_linkage_version, delegation_json, grants_json,
          issued_at, updated_at, last_seen_at)
       VALUES
         (:key, :controlledRun, :secretHash, :issuedGeneration, 'active',
          :parentRunId, :parentLinkageVersion, :delegationJson, :grantsJson,
          :issuedAt, :updatedAt, :lastSeenAt)`,
    ).run({
      key: record.claimKey,
      controlledRun: record.controlledRunId,
      secretHash: record.secretHash,
      issuedGeneration,
      parentRunId: record.delegation?.parentRunId ?? null,
      parentLinkageVersion: record.delegation ? 0 : null,
      delegationJson: record.delegation ? JSON.stringify(record.delegation) : null,
      grantsJson: JSON.stringify(record.grants),
      issuedAt: record.issuedAt,
      updatedAt: record.updatedAt,
      lastSeenAt: record.lastSeenAt,
    });
  }

  /**
   * Replace the default stack rows.
   *
   * @param tx - Open transaction.
   * @param runIds - Ordered run ids (index 0 = bottom).
   */
  private setStack(tx: SqlTransaction, runIds: readonly RunId[]): void {
    tx.prepare('DELETE FROM session_stack').run();
    const insert = tx.prepare('INSERT INTO session_stack (position, run_id) VALUES (:pos, :runId)');
    runIds.forEach((runId, pos) => {
      insert.run({ pos, runId });
    });
  }

  /**
   * Set or clear the stash slot.
   *
   * @param tx - Open transaction.
   * @param runId - Run to stash, or null to clear.
   */
  private setStash(tx: SqlTransaction, runId: RunId | null): void {
    tx.prepare('DELETE FROM stash_slot').run();
    if (runId !== null) {
      tx.prepare('INSERT INTO stash_slot (slot, run_id) VALUES (0, :runId)').run({ runId });
    }
  }

  /**
   * Read and validate a run from an open transaction.
   *
   * @param tx - Open transaction.
   * @param runId - Run to read.
   * @returns The validated run state, or null.
   */
  private readRun(tx: SqlTransaction, runId: RunId): RunbookState | null {
    const row = tx
      .prepare('SELECT lifecycle, state_json FROM runs WHERE id = :id')
      .get<{ readonly lifecycle: string; readonly state_json: string }>({ id: runId });
    if (row === undefined) {
      return null;
    }
    const raw = JSON.parse(row.state_json) as Record<string, unknown>;
    raw.lifecycle = assertLifecycle(row.lifecycle);
    // resolvedCompletions live only in their own table; a run always carries the
    // field (empty when it has no completions), so canonicalize to `{}`.
    raw.resolvedCompletions = this.readResolvedCompletions(tx, runId);
    return this.stateSchema.parse(raw) as RunbookState;
  }

  /**
   * Read a run's resolved completions as a plain (unbranded) record.
   *
   * @param tx - Open transaction.
   * @param runId - Run whose completions to read.
   * @returns The completion map, empty when the run has none.
   */
  private readResolvedCompletions(tx: SqlTransaction, runId: RunId): Record<string, unknown> {
    const rows = tx
      .prepare(
        'SELECT completion_key, payload_json FROM resolved_completions WHERE run_id = :runId',
      )
      .all<{ readonly completion_key: string; readonly payload_json: string }>({ runId });
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      out[row.completion_key] = JSON.parse(row.payload_json);
    }
    return out;
  }

  /**
   * Read and reconstruct the session data.
   *
   * @param tx - Open transaction.
   * @returns The session data.
   */
  private readSession(tx: SqlTransaction): SessionData {
    const claims: Record<string, ClaimRecord> = {};
    // Only active claims are usable targeting authority; superseded tombstones are
    // retained for commit-validity/generation accounting but never surfaced here.
    for (const row of tx.prepare("SELECT * FROM claims WHERE status = 'active'").all<ClaimRow>()) {
      claims[row.key] = deserializeClaim(row);
    }
    const stash = this.readStash(tx);
    return {
      defaultStack: [...this.readStack(tx)],
      claims,
      ...(stash !== null ? { stashedRunbookId: stash } : {}),
    };
  }

  /**
   * Read the default stack in order.
   *
   * @param tx - Open transaction.
   * @returns Ordered run ids.
   */
  private readStack(tx: SqlTransaction): readonly RunId[] {
    return tx
      .prepare('SELECT run_id FROM session_stack ORDER BY position')
      .all<{ readonly run_id: string }>()
      .map((r) => assertRunId(r.run_id));
  }

  /**
   * Read the stash slot.
   *
   * @param tx - Open transaction.
   * @returns The stashed run id, or null.
   */
  private readStash(tx: SqlTransaction): RunId | null {
    const row = tx
      .prepare('SELECT run_id FROM stash_slot WHERE slot = 0')
      .get<{ readonly run_id: string }>();
    return row === undefined ? null : assertRunId(row.run_id);
  }
}

/**
 * Map a non-`ok` commit classification to a {@link GuardedMutationResult} refusal.
 *
 * @template T - The committed value type of the target result.
 * @param classification - A non-`ok` classification.
 * @returns The corresponding refusal result.
 */
function classificationToResult<T>(
  classification: Exclude<CommitClassification, { kind: 'ok' }>,
): GuardedMutationResult<T> {
  return classification;
}

/**
 * Serialize a run state to `state_json`, excluding the coordinated fields that
 * live in their own tables.
 *
 * @param state - Run state.
 * @returns JSON string for the `state_json` column.
 */
function serializeStateJson(state: RunbookState): string {
  const { resolvedCompletions: _rc, lifecycle: _lc, ...rest } = state;
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

/** Zod schema for the grants JSON blob, kept permissive at this edge. */
const GrantsSchema = z.array(z.record(z.string(), z.unknown()));

/**
 * Reconstruct a claim record from its row.
 *
 * @param row - Raw claim row.
 * @returns The claim record.
 */
function deserializeClaim(row: ClaimRow): ClaimRecord {
  const grants = GrantsSchema.parse(
    JSON.parse(row.grants_json),
  ) as unknown as ClaimRecord['grants'];
  const delegation =
    row.delegation_json !== null
      ? (JSON.parse(row.delegation_json) as ClaimRecord['delegation'])
      : undefined;
  return {
    claimKey: assertClaimLookupKey(row.key),
    secretHash: assertClaimSecretHash(row.secret_hash),
    controlledRunId: assertRunId(row.controlled_run),
    ...(delegation ? { delegation } : {}),
    grants,
    issuedAt: row.issued_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}
