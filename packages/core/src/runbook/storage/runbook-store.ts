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
import { makeRunbookStateSchema, DelegationClaimLinkageSchema } from '../../schemas.js';
import { getErrorMessage } from '../../errors.js';
import type {
  RunbookState,
  ResolvedCompletion,
  Lifecycle,
  ExecutionRecoveryReason,
  SubstepState,
} from '../types.js';
import { type RunId, assertRunId } from '../run-id.js';
import {
  type ClaimRecord,
  type ClaimLookupKey,
  type DelegationClaimLinkage,
  type ClaimAndInitialLinkInput,
  assertClaimLookupKey,
  assertClaimSecretHash,
} from '../claim-id.js';
import { classifyDelegationLiveness, findSubstepState, linkageMatchesClaim } from '../targeting.js';
import type { SessionData } from '../state.js';
import type { SqlBindable, SqlDriver, SqlTransaction } from './sql-driver.js';
import {
  type CapturedAuthority,
  type ClaimGeneration,
  type ExecutionEpoch,
  type GuardedMutationResult,
  assertClaimGeneration,
  assertStateVersion,
  assertExecutionEpoch,
  assertExecutionTokenHash,
  verifyExecutionToken,
  hashExecutionToken,
  type ExecutionToken,
} from './mutation-result.js';

/** Machine lifecycle values persisted in the `runs.lifecycle` column. */
const LIFECYCLES: readonly Lifecycle[] = ['running', 'completed', 'stopped'];

/** Execution phases persisted in `execution_attempts.phase`. */
export type ExecutionPhase = 'claimed' | 'effect_started' | 'recovery_pending' | 'committed';

/** Attempt budget for an optimistic {@link RunbookStore.mutateState} cycle. */
const DEFAULT_MUTATE_ATTEMPTS = 8;

/**
 * Outcome of a claim-free guarded state mutation.
 *
 * `unchanged` is distinct from `committed`: the builder declined to produce a new
 * state, so nothing was written and no version was consumed.
 */
export type StateMutationResult =
  | { readonly kind: 'committed'; readonly value: RunbookState }
  | { readonly kind: 'unchanged'; readonly value: RunbookState }
  | { readonly kind: 'missing'; readonly runId: RunId; readonly message: string }
  | { readonly kind: 'execution_in_progress'; readonly runId: RunId; readonly message: string }
  | { readonly kind: 'concurrent_modification'; readonly runId: RunId; readonly message: string };

/**
 * Exhaustive outcome of an ownership-sensitive session mutation.
 *
 * Domain-specific results remain nested in the `committed` arm so ownership
 * refusals cannot be confused with a domain-level `null` or status.
 *
 * @template T - Domain value returned after the session transaction commits.
 */
export type SessionMutationResult<T> =
  | { readonly status: 'committed'; readonly value: T }
  | {
      readonly status: 'execution-in-progress';
      readonly runId: RunId;
      readonly message: string;
    }
  | {
      readonly status: 'recovery-required';
      readonly runId: RunId;
      readonly epoch: ExecutionEpoch;
      readonly message: string;
    };

/**
 * Marker instructing a guarded run-state write to refuse — inside the same
 * transaction, before the run `UPDATE` — when the run named by `parentRunId`
 * still has a live delegated child. Supplied only by
 * {@link SessionService.runGuardedParentAdvance}; absent on every routine write.
 */
export type ParentAdvanceGuard = {
  readonly kind: 'refuse-open-delegated-children';
  readonly parentRunId: RunId;
};

/**
 * Build the guard for a parent-advancing write.
 *
 * @param parentRunId - The parent run whose advance must refuse on a live delegated child.
 * @returns The guard marker to pass as {@link RunbookStore.mutateState}'s `guard` option.
 */
export function parentAdvanceGuard(parentRunId: RunId): ParentAdvanceGuard {
  return { kind: 'refuse-open-delegated-children', parentRunId };
}

/**
 * Thrown from a guarded write when a live delegated child still exists for the
 * advancing parent. Aborts the write transaction (rollback) and is caught at
 * exactly one boundary — {@link SessionService.runGuardedParentAdvance} — where
 * it becomes the `open_delegated_children` refusal. Any other error from the
 * guarded write is rethrown unchanged.
 */
export class OpenDelegatedChildrenError extends Error {
  /**
   * Construct the refusal, carrying the blocking claims.
   *
   * @param claims - The active delegated child claims that blocked the advance.
   */
  constructor(readonly claims: readonly ClaimRecord[]) {
    super('Parent advance refused: a live delegated child exists.');
    this.name = 'OpenDelegatedChildrenError';
  }
}

/**
 * Type guard for {@link OpenDelegatedChildrenError}. Same-realm custom error, so
 * `instanceof` is the correct (allow-listed) check.
 *
 * @param value - Caught value to test.
 * @returns `true` when `value` is an `OpenDelegatedChildrenError`.
 */
export function isOpenDelegatedChildrenError(value: unknown): value is OpenDelegatedChildrenError {
  return value instanceof OpenDelegatedChildrenError;
}

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

/** Internal rollback marker for an ownership trigger abort classified in-transaction. */
class SessionExecutionInProgressError extends Error {
  constructor(readonly runId: RunId) {
    super('execution_in_progress');
    this.name = 'SessionExecutionInProgressError';
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
  /** Persisted delegation linkage for the presented claim, else null. */
  readonly claimDelegationJson: string | null;
  /** Parent run id for a delegated claim, else null. */
  readonly parentId: string | null;
  /** Parent lifecycle for a delegated claim, else null. */
  readonly parentLifecycle: string | null;
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
    if (row.parentId !== captured.parent.runId || parentTerminal) {
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
    c.delegation_json        AS claim_delegation_json,
    p.id                     AS parent_id,
    p.lifecycle              AS parent_lifecycle,
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
  readonly claim_delegation_json: string | null;
  readonly parent_id: string | null;
  readonly parent_lifecycle: string | null;
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
      claimDelegationJson: null,
      parentId: null,
      parentLifecycle: null,
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
    claimDelegationJson: raw.claim_delegation_json,
    parentId: raw.parent_id,
    parentLifecycle: raw.parent_lifecycle,
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
  const delegatedParent =
    row.claimDelegationJson === null
      ? undefined
      : parseDelegationLinkage(row.claimDelegationJson, claimKey).parentRunId;
  const parent = delegatedParent === undefined ? undefined : { runId: delegatedParent };
  const parentTerminal = row.parentLifecycle === 'completed' || row.parentLifecycle === 'stopped';
  if (parent && (row.parentId !== parent.runId || parentTerminal)) {
    return {
      kind: 'claim_superseded',
      runId,
      message: `The delegated parent of run ${runId} is missing, terminal, or relinked.`,
    };
  }
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

/**
 * Resolve the active claim controlling a run, if any.
 *
 * A run has at most one active controlling claim, enforced by the partial
 * unique index `claims_one_active_per_run` (`schema.ts`): `rundown run` mints a
 * run-control claim as part of the same session mutation that pushes the run
 * (`pushRunbookWithRunControlClaim`), and a delegated child is claimed by
 * exactly one bearer. Tombstoned claims are excluded, so a superseded holder is
 * never resurrected as authority. A second active row is impossible under the
 * index; reading two here is hard corruption and throws rather than selecting an
 * arbitrary controller (which `null` — "no controller" to `captureRunAuthority`
 * — would misreport as a routine refusal).
 *
 * This exists for the *bare* caller — `rundown pass` with no `--claim-id` on a
 * run that authorization has already cleared it to mutate. Such a caller
 * presents no claim, but the fence still needs the run's authority predicate to
 * capture. Resolving the controlling claim here is not a #613 divergence: #613
 * forbids silently resolving a *presented* claim onto a different target, and
 * nothing is presented on this path.
 *
 * @param tx - Open transaction.
 * @param runId - Target run.
 * @returns The controlling claim's lookup key, or `null` when the run has none.
 * @throws {Error} When two active claims control the run — a corruption the
 *   partial unique index makes unreachable — rather than selecting an arbitrary one.
 */
export function resolveControllingClaim(tx: SqlTransaction, runId: RunId): ClaimLookupKey | null {
  const rows = tx
    .prepare(
      `SELECT key FROM claims
       WHERE controlled_run = :runId AND status = 'active'
       ORDER BY key
       LIMIT 2`,
    )
    .all<{ readonly key: string }>({ runId });
  if (rows.length > 1) {
    throw new Error(
      `Run ${runId} has two active controlling claims; the partial unique index ` +
        `claims_one_active_per_run should make this unreachable. The runbook database ` +
        `is inconsistent. Finish or prune active runbooks and restart.`,
    );
  }
  if (rows.length === 0) {
    return null;
  }
  return assertClaimLookupKey(rows[0].key);
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
  /**
   * Delete an unowned run and its cascaded rows.
   *
   * @throws {Error} With `execution_in_progress` when the run has active
   * execution ownership.
   */
  deleteRun(runId: RunId): void;
  /** Insert a claim row (fires the generation-bump trigger on the controlled run). */
  insertClaim(record: ClaimRecord, issuedGeneration: ClaimGeneration): void;
  /** Mark a claim superseded (tombstone). Idempotent. */
  tombstoneClaim(key: ClaimLookupKey): void;
  /**
   * Supersede every active delegated claim no longer live in the given parent
   * state (the parent half of R2's durable latch). Returns the keys tombstoned.
   */
  invalidateClosedDelegatedClaims(parent: RunbookState): readonly ClaimLookupKey[];
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
  /**
   * Read a run's persisted state inside this transaction.
   *
   * Session mutations that validate against run state (claim linkage checks,
   * terminal-child refusals, stash gating) must read that state under the same
   * transaction that writes the session; a read outside it could observe a run
   * that another writer terminalizes before the session write lands.
   */
  readState(runId: RunId): RunbookState | null;
  /** Read the latest recovery-pending epoch using this open transaction. */
  pendingRecovery(runId: RunId): { readonly epoch: ExecutionEpoch } | null;
  /** Return whether a run currently has active execution ownership. */
  executionOwned(runId: RunId): boolean;
  /** Set a matching delegation's child id under its observed parent state version. */
  linkInitialDelegation(
    input: ClaimAndInitialLinkInput,
    now: string,
  ): 'linked' | 'already-linked' | 'conflict';
  /** Clear a matching token+child initial link under its observed state version. */
  clearInitialDelegation(
    input: ClaimAndInitialLinkInput,
    now: string,
  ): 'cleared' | 'already-absent' | 'conflict';
}

/** Typed operations available inside a {@link RunbookStore.mutateSession} cycle. */
export interface SessionMutationTxn extends RunbookStoreTxn {
  /**
   * The session snapshot, read at transaction start. Mutate in place; the store
   * reconciles it into the session tables when the callback returns.
   */
  readonly session: SessionData;
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
   * Capture authority for a run whose caller presented no claim.
   *
   * Resolves the run's active controlling claim and captures against it in one
   * read transaction, so the claim cannot be tombstoned between lookup and
   * capture. A run with no active controlling claim cannot be fenced and is
   * refused as `claim_superseded` — the same refusal a caller presenting a dead
   * claim receives, since in both cases no live authority controls the run.
   *
   * @param runId - Target run.
   * @returns The captured authority or a typed refusal.
   */
  captureRunAuthority(runId: RunId): Promise<CaptureResult> {
    return this.driver.read((tx) => {
      const claimKey = resolveControllingClaim(tx, runId);
      if (claimKey === null) {
        const present = tx
          .prepare('SELECT 1 AS present FROM runs WHERE id = :runId')
          .get<{ readonly present: number }>({ runId });
        return present
          ? {
              kind: 'claim_superseded' as const,
              runId,
              message: `Run ${runId} has no active controlling claim.`,
            }
          : { kind: 'missing' as const, runId, message: `Run ${runId} does not exist.` };
      }
      return captureAuthority(tx, runId, claimKey);
    });
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
   * Commit an effectful mutation under active execution ownership.
   *
   * Re-selects and classifies the commit row against both the captured claim/state
   * CAS and the presented execution identity (token + epoch). Unlike
   * {@link saveState}, this path requires the run to be owned by exactly this
   * attempt in phase `effect_started`; a moved phase surfaces as
   * `recovery_required`, a reissued attempt as `execution_in_progress`. On `ok`,
   * one atomic UPDATE writes the new state, clears active ownership, and (via the
   * `state_json` trigger) bumps `state_version`; the resolved-completion table is
   * rewritten from `next`, and the owning attempt is marked `committed`.
   *
   * Ownership is cleared in the same UPDATE that writes `state_json`, before any
   * completion/attempt writes, so no trigger-guarded write in this transaction is
   * refused by the owned-run guard.
   *
   * @param captured - Authority captured before the effect.
   * @param execution - The owning attempt's raw token and epoch.
   * @param next - The new run state to persist (already reflecting any consumed
   *   resolved completion).
   * @returns The committed state, or a typed refusal.
   */
  commitOwnedState(
    captured: CapturedAuthority,
    execution: ExecutionExpectation,
    next: RunbookState,
  ): Promise<GuardedMutationResult<RunbookState>> {
    const hash = hashExecutionToken(execution.token);
    return this.transaction((txn) => {
      const row = txn.commitRow(captured.runId, captured.claimKey);
      const classification = classifyCommitRow(row, captured, execution);
      if (classification.kind !== 'ok') {
        return classificationToResult(classification);
      }
      const changes = txn.tx
        .prepare(
          `UPDATE runs
              SET state_json = :stateJson,
                  lifecycle  = :lifecycle,
                  updated_at = :updatedAt,
                  exec_pid = NULL, exec_token = NULL, exec_epoch = NULL, exec_start_id = NULL
            WHERE id = :id
              AND state_version = :stateVersion
              AND exec_token = :hash
              AND exec_epoch = :epoch`,
        )
        .run({
          id: captured.runId,
          stateJson: serializeStateJson(next),
          lifecycle: next.lifecycle ?? 'running',
          updatedAt: next.updatedAt,
          stateVersion: captured.stateVersion,
          hash,
          epoch: execution.epoch,
        }).changes;
      assertExactlyOneRow(changes, captured.runId);
      this.afterAuthoritativeStateWrite(txn.tx, next);
      txn.tx
        .prepare(
          `UPDATE execution_attempts
              SET phase = 'committed', finished_at = :now
            WHERE run_id = :runId AND exec_epoch = :epoch
              AND exec_token = :hash AND phase = 'effect_started'`,
        )
        .run({ now: next.updatedAt, runId: captured.runId, epoch: execution.epoch, hash });
      return { kind: 'committed', value: next };
    });
  }

  /**
   * Apply a claim-free, guarded read-modify-write to a run's state.
   *
   * This is the transactional replacement for the per-run file lock: the read
   * captures `state_version`, the caller's `build` runs OUTSIDE any transaction
   * (so it may await), and the write commits only if the version is unchanged and
   * the run is unowned. A version that moved under a concurrent writer retries the
   * whole cycle within a finite attempt budget; an active execution owner refuses
   * immediately. Mutation *authority* is enforced above this layer (claim
   * verification), exactly as it was under the lock — this method guards only
   * atomicity and execution ownership.
   *
   * @param runId - Run to mutate.
   * @param build - Derives the next state from the current one; `null` means no change.
   * @param options - Optional attempt budget and parent-advance guard.
   * @param options.attempts - Maximum number of stale-version retries before giving up.
   * @param options.guard - Parent-advance guard: when present, the write refuses
   *   inside its transaction if the run still has a live delegated child.
   * @returns The committed state, the unchanged state, or a typed refusal.
   * @throws {OpenDelegatedChildrenError} When `options.guard` is supplied and a
   *   live delegated child blocks the advance.
   */
  async mutateState(
    runId: RunId,
    build: (current: RunbookState) => RunbookState | null | Promise<RunbookState | null>,
    options: { readonly attempts?: number; readonly guard?: ParentAdvanceGuard } = {},
  ): Promise<StateMutationResult> {
    const attempts = options.attempts ?? DEFAULT_MUTATE_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const snapshot = await this.driver.read((tx) => this.readRunWithVersion(tx, runId));
      if (snapshot === null) {
        return { kind: 'missing', runId, message: `Run ${runId} does not exist.` };
      }
      const next = await build(snapshot.state);
      if (next === null) {
        return { kind: 'unchanged', value: snapshot.state };
      }
      // A guard refusal throws OpenDelegatedChildrenError out of the transaction
      // (driver ROLLBACK + rethrow); it must NOT be caught here as a retry — it
      // propagates to runGuardedParentAdvance as the open_delegated_children
      // refusal.
      const outcome = await this.transaction((txn) =>
        this.writeStateAtVersion(txn.tx, runId, snapshot.stateVersion, next, options.guard),
      );
      if (outcome === 'committed') {
        return { kind: 'committed', value: next };
      }
      if (outcome === 'missing') {
        return { kind: 'missing', runId, message: `Run ${runId} does not exist.` };
      }
      if (outcome === 'owned') {
        return {
          kind: 'execution_in_progress',
          runId,
          message: `Run ${runId} has an execution in progress.`,
        };
      }
      // 'stale': a concurrent writer bumped state_version — rebuild from fresh state.
    }
    return {
      kind: 'concurrent_modification',
      runId,
      message: `Run ${runId} was modified concurrently by another writer.`,
    };
  }

  /**
   * Replace the persisted session (default stack, stash slot, active claims).
   *
   * Claims are reconciled rather than rewritten: a claim absent from `session`
   * becomes a tombstone (never a hard delete, so issuance history survives), and a
   * newly present claim is inserted. Existing claims are left untouched so this
   * wholesale save never churns `claim_generation` or clobbers `last_seen_at` —
   * claim activity is written only at the authorization seam via
   * {@link RunbookStoreTxn.recordClaimSeen}.
   *
   * @param session - The session data to persist.
   * @returns Resolves once committed.
   */
  saveSession(session: SessionData): Promise<void> {
    return this.transaction((txn) => {
      this.applySession(txn, session);
    });
  }

  /**
   * Read the session, hand it to `work` for in-place mutation, and reconcile the
   * result — all inside one transaction.
   *
   * This is the transactional replacement for the load-modify-save cycle that
   * previously ran under the workspace session file lock. Atomicity now comes
   * from the transaction itself, so an interleaved writer cannot lose an update:
   * `BEGIN IMMEDIATE` serializes the read against every other writer, and the
   * whole cycle either commits or rolls back.
   *
   * `work` is synchronous by construction. A transaction must not be held across
   * an `await` — that is what makes the sqljs single-connection driver safe — so
   * every dependency a session mutation needs is available on the passed
   * operations (notably {@link RunbookStoreTxn.readState} for run-state reads)
   * rather than fetched by the caller mid-cycle.
   *
   * @template T - Value the mutation returns to its caller.
   * @param work - Mutates `ctx.session` in place and returns the caller's result.
   * @returns The work's return value, once committed.
   */
  mutateSession<T>(work: (ctx: SessionMutationTxn) => T): Promise<T> {
    return this.transaction((txn) => {
      const session = this.readSession(txn.tx);
      const result = work({ ...txn, session });
      this.applySession(txn, session);
      return result;
    });
  }

  /**
   * Mutate ownership-sensitive session rows with typed execution refusals.
   *
   * Recovery is preflighted inside the same transaction, in caller-supplied run
   * order. SQLite trigger aborts are normalized only when their exact message is
   * `execution_in_progress`; every other error is rethrown unchanged.
   *
   * @template T - Domain value returned by the mutation callback.
   * @param runIds - Affected runs, ordered by deterministic refusal priority.
   * @param work - Synchronous session mutation callback.
   * @returns The committed value or the first ownership refusal.
   */
  async mutateSessionGuarded<T>(
    runIds: readonly RunId[] | ((session: SessionData) => readonly RunId[]),
    work: (ctx: SessionMutationTxn) => T,
  ): Promise<SessionMutationResult<T>> {
    let affectedRunIds: readonly RunId[] = [];
    try {
      return await this.transaction((txn) => {
        const session = this.readSession(txn.tx);
        affectedRunIds = typeof runIds === 'function' ? runIds(session) : runIds;
        for (const runId of affectedRunIds) {
          const pending = txn.pendingRecovery(runId);
          if (pending !== null) {
            return {
              status: 'recovery-required',
              runId,
              epoch: pending.epoch,
              message: `Run ${runId} needs recovery: its execution outcome is unknown.`,
            } satisfies SessionMutationResult<T>;
          }
          if (txn.executionOwned(runId)) {
            return {
              status: 'execution-in-progress',
              runId,
              message: `Run ${runId} has an execution in progress.`,
            } satisfies SessionMutationResult<T>;
          }
        }
        try {
          const value = work({ ...txn, session });
          this.applySession(txn, session);
          return { status: 'committed', value } satisfies SessionMutationResult<T>;
        } catch (error: unknown) {
          if (getErrorMessage(error) === 'execution_in_progress') {
            const runId = affectedRunIds.find((candidate) => txn.executionOwned(candidate));
            if (runId !== undefined) {
              throw new SessionExecutionInProgressError(runId);
            }
          }
          throw error;
        }
      });
    } catch (error: unknown) {
      if (!(error instanceof SessionExecutionInProgressError)) {
        throw error;
      }
      return {
        status: 'execution-in-progress',
        runId: error.runId,
        message: `Run ${error.runId} has an execution in progress.`,
      };
    }
  }

  /**
   * Reconcile a session snapshot into the session tables.
   *
   * @param txn - Open store transaction.
   * @param session - Session data to persist.
   */
  private applySession(txn: RunbookStoreTxn, session: SessionData): void {
    txn.setStack(session.defaultStack);
    txn.setStash(session.stashedRunbookId ?? null);
    const stale = new Set(
      txn.tx
        .prepare("SELECT key FROM claims WHERE status = 'active'")
        .all<{ readonly key: string }>()
        .map((row) => row.key),
    );
    const inserts: ClaimRecord[] = [];
    for (const [key, record] of Object.entries(session.claims)) {
      if (stale.delete(key)) {
        this.updateChangedClaimColumns(txn.tx, key, record);
        continue;
      }
      inserts.push(record);
    }
    // Tombstone removed claims BEFORE inserting new ones. A rotated claim (new
    // key, same controlled_run — e.g. re-issuing a run-control claim) would
    // otherwise collide with its still-active predecessor under
    // claims_one_active_per_run, which requires at most one active claim per run.
    for (const key of stale) {
      txn.tombstoneClaim(assertClaimLookupKey(key));
    }
    for (const record of inserts) {
      const generation =
        txn.tx
          .prepare('SELECT claim_generation AS g FROM runs WHERE id = :id')
          .get<{ readonly g: number }>({ id: record.controlledRunId })?.g ?? 0;
      txn.insertClaim(record, assertClaimGeneration(generation));
    }
  }

  /**
   * Delete an unowned run and its cascaded rows.
   *
   * @param runId - Run to delete.
   * @returns Resolves once committed.
   * @throws {Error} With `execution_in_progress` when the run is actively owned.
   */
  deleteRun(runId: RunId): Promise<void> {
    return this.transaction((txn) => {
      txn.deleteRun(runId);
    });
  }

  /**
   * Load every persisted run.
   *
   * @returns All run states in ascending id order.
   */
  listRuns(): Promise<readonly RunbookState[]> {
    return this.driver.read((tx) => {
      const ids = tx
        .prepare('SELECT id FROM runs ORDER BY id')
        .all<{ readonly id: string }>()
        .map((row) => assertRunId(row.id));
      const states: RunbookState[] = [];
      for (const id of ids) {
        const state = this.readRun(tx, id);
        if (state !== null) {
          states.push(state);
        }
      }
      return states;
    });
  }

  /**
   * Read a run together with its current `state_version`.
   *
   * @param tx - Open transaction.
   * @param runId - Run to read.
   * @returns The state and its version, or null when absent.
   */
  private readRunWithVersion(
    tx: SqlTransaction,
    runId: RunId,
  ): { readonly state: RunbookState; readonly stateVersion: number } | null {
    const row = tx
      .prepare('SELECT state_version FROM runs WHERE id = :id')
      .get<{ readonly state_version: number }>({ id: runId });
    if (row === undefined) {
      return null;
    }
    const state = this.readRun(tx, runId);
    return state === null ? null : { state, stateVersion: row.state_version };
  }

  /**
   * Write run state under a `state_version` CAS, requiring an unowned run.
   *
   * @param tx - Open transaction.
   * @param runId - Run to write.
   * @param stateVersion - Version captured at read.
   * @param next - New state.
   * @param guard - Optional parent-advance guard. When present, the open
   *   delegated-children predicate is evaluated inside this transaction BEFORE
   *   the `UPDATE`; a live delegated child aborts the write (rollback).
   * @returns Why the write did or did not land.
   * @throws {OpenDelegatedChildrenError} When `guard` is supplied and the parent
   *   still has a live delegated child, aborting the transaction.
   */
  private writeStateAtVersion(
    tx: SqlTransaction,
    runId: RunId,
    stateVersion: number,
    next: RunbookState,
    guard?: ParentAdvanceGuard,
  ): 'committed' | 'stale' | 'owned' | 'missing' {
    if (guard !== undefined) {
      // Defensive invariant: the guard only applies to its own parent's advance.
      if (guard.parentRunId !== runId) {
        throw new Error(
          `Parent-advance guard for ${guard.parentRunId} misapplied to write of ${runId}.`,
        );
      }
      const open = this.openDelegatedChildrenFor(tx, runId);
      if (open.length > 0) {
        // Aborts the BEGIN IMMEDIATE transaction (ROLLBACK) before any UPDATE.
        throw new OpenDelegatedChildrenError(open);
      }
    }
    const changes = tx
      .prepare(
        `UPDATE runs
            SET state_json = :stateJson,
                lifecycle  = :lifecycle,
                updated_at = :updatedAt
          WHERE id = :id
            AND state_version = :stateVersion
            AND exec_token IS NULL`,
      )
      .run({
        id: runId,
        stateJson: serializeStateJson(next),
        lifecycle: next.lifecycle ?? 'running',
        updatedAt: next.updatedAt,
        stateVersion,
      }).changes;
    if (changes === 1) {
      this.afterAuthoritativeStateWrite(tx, next);
      return 'committed';
    }
    const row = tx
      .prepare('SELECT exec_token FROM runs WHERE id = :id')
      .get<{ readonly exec_token: string | null }>({ id: runId });
    if (row === undefined) {
      return 'missing';
    }
    return row.exec_token !== null ? 'owned' : 'stale';
  }

  /**
   * Read the latest `recovery_pending` attempt for a run, if any.
   *
   * @param runId - Run to inspect.
   * @returns The pending attempt's epoch and recorded reason, or null.
   */
  readPendingRecovery(
    runId: RunId,
  ): Promise<{ readonly epoch: ExecutionEpoch; readonly reason: string | null } | null> {
    return this.driver.read((tx) => {
      const row = tx
        .prepare(
          `SELECT exec_epoch AS epoch, reason FROM execution_attempts
            WHERE run_id = :runId AND phase = 'recovery_pending'
            ORDER BY exec_epoch DESC LIMIT 1`,
        )
        .get<{ readonly epoch: number; readonly reason: string | null }>({ runId });
      if (row === undefined) {
        return null;
      }
      return { epoch: assertExecutionEpoch(row.epoch), reason: row.reason };
    });
  }

  /**
   * Commit an interrupted-execution recovery snapshot.
   *
   * Persists the `recoveryRequired` snapshot (lifecycle stays `running`), records
   * the attempt's recovery reason, and clears active ownership — atomically,
   * keyed on the exact interrupted epoch. If the interrupted attempt was
   * superseded meanwhile, the commit changes zero rows and refuses.
   *
   * @param input - Recovery commit inputs.
   * @param input.epoch - The interrupted attempt's epoch.
   * @param input.reason - The recovery cause to record.
   * @param input.next - The recovery run state (carrying the new snapshot).
   * @returns The committed state, or a typed refusal if the attempt was superseded.
   */
  commitRecovery(input: {
    readonly epoch: ExecutionEpoch;
    readonly reason: ExecutionRecoveryReason;
    readonly next: RunbookState;
  }): Promise<GuardedMutationResult<RunbookState>> {
    const { epoch, reason, next } = input;
    return this.transaction((txn) => {
      const changes = txn.tx
        .prepare(
          `UPDATE runs
              SET state_json = :json, lifecycle = :lifecycle,
                  exec_pid = NULL, exec_token = NULL, exec_epoch = NULL, exec_start_id = NULL,
                  updated_at = :now
            WHERE id = :runId AND exec_epoch = :epoch`,
        )
        .run({
          json: serializeStateJson(next),
          lifecycle: next.lifecycle ?? 'running',
          now: next.updatedAt,
          runId: next.id,
          epoch,
        }).changes;
      if (changes !== 1) {
        return {
          kind: 'execution_in_progress',
          runId: next.id,
          message: `The interrupted attempt for run ${next.id} was superseded before recovery committed.`,
        };
      }
      const attemptChanges = txn.tx
        .prepare(
          `UPDATE execution_attempts
              SET phase = 'committed', finished_at = :now,
                  reason = COALESCE(reason, :reason)
            WHERE run_id = :runId AND exec_epoch = :epoch AND phase = 'recovery_pending'`,
        )
        .run({ reason, now: next.updatedAt, runId: next.id, epoch }).changes;
      assertExactlyOneRow(attemptChanges, next.id);
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
        const changes = tx
          .prepare('DELETE FROM runs WHERE id = :id AND exec_token IS NULL')
          .run({ id: runId }).changes;
        if (changes === 0) {
          const owned = tx
            .prepare('SELECT 1 AS owned FROM runs WHERE id = :id AND exec_token IS NOT NULL')
            .get<{ readonly owned: 1 }>({ id: runId });
          if (owned !== undefined) {
            throw new Error(`execution_in_progress: run ${runId} has active execution ownership`);
          }
        }
      },
      insertClaim(record, issuedGeneration) {
        store.insertClaim(tx, record, issuedGeneration);
      },
      tombstoneClaim(key) {
        tx.prepare("UPDATE claims SET status = 'superseded' WHERE key = :key").run({ key });
      },
      invalidateClosedDelegatedClaims(parent) {
        return store.invalidateClosedDelegatedClaims(tx, parent);
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
      readState(runId) {
        return store.readRun(tx, runId);
      },
      pendingRecovery(runId) {
        const row = tx
          .prepare(
            `SELECT exec_epoch AS epoch FROM execution_attempts
              WHERE run_id = :runId AND phase = 'recovery_pending'
              ORDER BY exec_epoch DESC LIMIT 1`,
          )
          .get<{ readonly epoch: number }>({ runId });
        return row === undefined ? null : { epoch: assertExecutionEpoch(row.epoch) };
      },
      executionOwned(runId) {
        return (
          tx
            .prepare('SELECT 1 AS owned FROM runs WHERE id = :runId AND exec_token IS NOT NULL')
            .get<{ readonly owned: 1 }>({ runId }) !== undefined
        );
      },
      linkInitialDelegation(input, now) {
        return store.linkInitialDelegation(tx, input, now);
      },
      clearInitialDelegation(input, now) {
        return store.clearInitialDelegation(tx, input, now);
      },
    };
  }

  private linkInitialDelegation(
    tx: SqlTransaction,
    input: ClaimAndInitialLinkInput,
    now: string,
  ): 'linked' | 'already-linked' | 'conflict' {
    const observed = this.readRunWithVersion(tx, input.linkage.parentRunId);
    if (observed === null) return 'conflict';
    const current = findSubstepState(
      observed.state.substepStates ?? [],
      input.linkage.parentStepId,
      input.linkage.parentFrameKey,
    );
    if (current?.delegation?.tokenHash !== input.linkage.tokenHash) return 'conflict';
    if (current.delegation.childRunId !== null) {
      return current.delegation.childRunId === input.childRunId ? 'already-linked' : 'conflict';
    }
    const { token: _token, ...delegation } = current.delegation;
    const updatedEntry: SubstepState = {
      ...current,
      delegation: { ...delegation, childRunId: input.childRunId },
    };
    const substepStates = (observed.state.substepStates ?? []).map((entry) =>
      entry.id === current.id && entry.frameKey === current.frameKey ? updatedEntry : entry,
    );
    const next = patchStateSubsteps(observed.state, substepStates, now);
    const changes = tx
      .prepare(
        `UPDATE runs SET state_json = :stateJson, lifecycle = :lifecycle, updated_at = :updatedAt
         WHERE id = :id AND state_version = :stateVersion AND exec_token IS NULL`,
      )
      .run({
        id: input.linkage.parentRunId,
        stateVersion: observed.stateVersion,
        stateJson: serializeStateJson(next),
        lifecycle: next.lifecycle ?? 'running',
        updatedAt: now,
      }).changes;
    if (changes !== 1) return 'conflict';
    this.afterAuthoritativeStateWrite(tx, next);
    return 'linked';
  }

  private clearInitialDelegation(
    tx: SqlTransaction,
    input: ClaimAndInitialLinkInput,
    now: string,
  ): 'cleared' | 'already-absent' | 'conflict' {
    const observed = this.readRunWithVersion(tx, input.linkage.parentRunId);
    if (observed === null) return 'already-absent';
    const current = findSubstepState(
      observed.state.substepStates ?? [],
      input.linkage.parentStepId,
      input.linkage.parentFrameKey,
    );
    if (
      current?.delegation?.tokenHash !== input.linkage.tokenHash ||
      current.delegation.childRunId !== input.childRunId
    ) {
      return 'already-absent';
    }
    const updatedEntry: SubstepState = {
      ...current,
      delegation: { ...current.delegation, childRunId: null },
    };
    const substepStates = (observed.state.substepStates ?? []).map((entry) =>
      entry.id === current.id && entry.frameKey === current.frameKey ? updatedEntry : entry,
    );
    const next = patchStateSubsteps(observed.state, substepStates, now);
    const changes = tx
      .prepare(
        `UPDATE runs SET state_json = :stateJson, lifecycle = :lifecycle, updated_at = :updatedAt
         WHERE id = :id AND state_version = :stateVersion AND exec_token IS NULL`,
      )
      .run({
        id: input.linkage.parentRunId,
        stateVersion: observed.stateVersion,
        stateJson: serializeStateJson(next),
        lifecycle: next.lifecycle ?? 'running',
        updatedAt: now,
      }).changes;
    if (changes !== 1) return 'conflict';
    this.afterAuthoritativeStateWrite(tx, next);
    return 'cleared';
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
      this.afterAuthoritativeStateWrite(tx, next);
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
   * Run the common bookkeeping every authoritative run-state write owes.
   *
   * Invoked exactly once by each successful state-write site — after a run
   * UPDATE changes exactly one row, never on a zero-row/stale/owned outcome —
   * so the resolved-completion projection and the delegated-claim supersession
   * latch stay in lockstep with the committed state. This is the single home
   * for the parent half of R2's two-sided durable latch.
   *
   * @param tx - Open write transaction.
   * @param next - The run state just committed.
   * @throws {Error} When a delegated claim for this run carries malformed
   *   persisted linkage (invalid state), aborting the transaction.
   */
  private afterAuthoritativeStateWrite(tx: SqlTransaction, next: RunbookState): void {
    this.writeResolvedCompletions(tx, next.id, next.resolvedCompletions);
    this.invalidateClosedDelegatedClaims(tx, next);
  }

  /**
   * List active delegated claims that are still OPEN for `parentRunId`,
   * evaluated inside an open write transaction against the PRE-update parent
   * state.
   *
   * A claim is open only when the child state exists, is non-terminal, still
   * has delegation linkage matching the claim, AND the parent's corresponding
   * delegated substep is not yet `done`. Mirrors
   * {@link SessionService.listOpenClaimsForParent} exactly, but as synchronous
   * in-transaction SQL so the result is atomic with the decisive write that
   * follows in the same transaction — the whole point of the guard.
   *
   * @param tx - Open write transaction (pre-UPDATE).
   * @param parentRunId - The advancing parent run.
   * @returns Claim records for non-terminal children still linked to this parent
   *   whose delegated substep remains unresolved.
   */
  private openDelegatedChildrenFor(tx: SqlTransaction, parentRunId: RunId): ClaimRecord[] {
    const parent = this.readRun(tx, parentRunId);
    const parentSubsteps = parent?.substepStates ?? [];
    const rows = tx
      .prepare("SELECT * FROM claims WHERE parent_run_id = :parentId AND status = 'active'")
      .all<ClaimRow>({ parentId: parentRunId });

    const open: ClaimRecord[] = [];
    for (const row of rows) {
      const claim = deserializeClaim(row);
      if (!claim.delegation) {
        continue;
      }
      const child = this.readRun(tx, claim.controlledRunId);
      if (!child || child.lifecycle === 'completed' || child.lifecycle === 'stopped') {
        continue;
      }
      if (!linkageMatchesClaim(child.parentLinkage, claim)) {
        continue;
      }
      const parentSubstep = findSubstepState(
        parentSubsteps,
        claim.delegation.parentStepId,
        claim.delegation.parentFrameKey,
      );
      if (parentSubstep?.status === 'done') {
        continue;
      }
      open.push(claim);
    }
    return open;
  }

  /**
   * Tombstone every active delegated claim that is no longer live in `parent`.
   *
   * The parent half of the two-sided durable latch (R2). Selects active claims
   * whose `parent_run_id` names this run, classifies each against the committed
   * parent state via {@link classifyDelegationLiveness}, and supersedes those
   * that are closed. Each status UPDATE fires `claims_bump_gen_update` once,
   * bumping the controlled child's `claim_generation`; no caller bumps it
   * directly. Idempotent: a claim already superseded matches no `status =
   * 'active'` row.
   *
   * A row with no persisted delegation linkage is invalid state — a delegated
   * claim must carry one — and aborts the transaction rather than being skipped.
   *
   * @param tx - Open write transaction.
   * @param parent - The parent run state just committed.
   * @returns The keys of the claims superseded by this call.
   * @throws {Error} When an active delegated claim carries no persisted
   *   delegation linkage (invalid state), aborting the transaction.
   */
  private invalidateClosedDelegatedClaims(
    tx: SqlTransaction,
    parent: RunbookState,
  ): ClaimLookupKey[] {
    const rows = tx
      .prepare(
        `SELECT key, delegation_json FROM claims
          WHERE parent_run_id = :parentId AND status = 'active'`,
      )
      .all<{ readonly key: string; readonly delegation_json: string | null }>({
        parentId: parent.id,
      });
    const update = tx.prepare(
      "UPDATE claims SET status = 'superseded' WHERE key = :key AND status = 'active'",
    );
    const superseded: ClaimLookupKey[] = [];
    for (const row of rows) {
      const key = assertClaimLookupKey(row.key);
      if (row.delegation_json === null) {
        throw new Error(
          `Delegated claim ${key} for parent ${parent.id} carries no persisted delegation linkage; the runbook database is inconsistent.`,
        );
      }
      const linkage = parseDelegationLinkage(row.delegation_json, key);
      const liveness = classifyDelegationLiveness(parent, linkage);
      if (liveness.kind === 'closed') {
        update.run({ key });
        superseded.push(key);
      }
    }
    return superseded;
  }

  /**
   * Insert a claim row.
   *
   * @param tx - Open transaction.
   * @param record - Claim record to persist.
   * @param issuedGeneration - Generation captured as issuance metadata.
   */
  /**
   * Update an existing claim row to match a record, touching only changed columns.
   *
   * Column-precise on purpose. SQLite fires an `UPDATE OF <cols>` trigger based on
   * the columns named in `SET`, not on whether their values actually differ, so
   * blindly rewriting every column would bump `claim_generation` on each session
   * save and invalidate live captures. Diffing first means a resolution-affecting
   * edit (grants, status, linkage) still bumps the generation exactly once, while
   * a metadata-only refresh (`last_seen_at`) never does.
   *
   * @param tx - Open transaction.
   * @param key - Claim lookup key.
   * @param record - Desired claim state.
   */
  private updateChangedClaimColumns(tx: SqlTransaction, key: string, record: ClaimRecord): void {
    const desired: Record<string, SqlBindable> = {
      controlled_run: record.controlledRunId,
      secret_hash: record.secretHash,
      parent_run_id: record.delegation?.parentRunId ?? null,
      delegation_json: record.delegation ? JSON.stringify(record.delegation) : null,
      grants_json: JSON.stringify(record.grants),
      updated_at: record.updatedAt,
      last_seen_at: record.lastSeenAt,
    };
    const current = tx
      .prepare(
        `SELECT controlled_run, secret_hash, parent_run_id, delegation_json,
                grants_json, updated_at, last_seen_at
           FROM claims WHERE key = :key`,
      )
      .get<Record<string, SqlBindable>>({ key });
    if (current === undefined) {
      return;
    }
    const changed = Object.keys(desired).filter((column) => current[column] !== desired[column]);
    if (changed.length === 0) {
      return;
    }
    const assignments = changed.map((column) => `${column} = :${column}`).join(', ');
    const params: Record<string, SqlBindable> = { key };
    for (const column of changed) {
      params[column] = desired[column];
    }
    tx.prepare(`UPDATE claims SET ${assignments} WHERE key = :key`).run(params);
  }

  private insertClaim(
    tx: SqlTransaction,
    record: ClaimRecord,
    issuedGeneration: ClaimGeneration,
  ): void {
    tx.prepare(
      `INSERT INTO claims
         (key, controlled_run, secret_hash, issued_generation, status,
          parent_run_id, delegation_json, grants_json,
          issued_at, updated_at, last_seen_at)
       VALUES
         (:key, :controlledRun, :secretHash, :issuedGeneration, 'active',
          :parentRunId, :delegationJson, :grantsJson,
          :issuedAt, :updatedAt, :lastSeenAt)`,
    ).run({
      key: record.claimKey,
      controlledRun: record.controlledRunId,
      secretHash: record.secretHash,
      issuedGeneration,
      parentRunId: record.delegation?.parentRunId ?? null,
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
    const current = tx
      .prepare('SELECT run_id FROM stash_slot WHERE slot = 0')
      .get<{ readonly run_id: string }>();
    if ((current?.run_id ?? null) === runId) {
      return;
    }
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
    const raw = this.readRunRaw(tx, runId);
    return raw === null ? null : (this.stateSchema.parse(raw) as RunbookState);
  }

  /**
   * Reassemble a run's persisted JSON without validating it.
   *
   * Exposed for the state manager, which owns the caller-facing error taxonomy
   * (legacy-snapshot and schema-version rejection) and must therefore inspect the
   * raw object before validation rather than receive a parsed value or a ZodError.
   *
   * @param runId - Run to read.
   * @returns The assembled state object, or null when absent.
   */
  readRunJson(runId: RunId): Promise<Record<string, unknown> | null> {
    return this.driver.read((tx) => this.readRunRaw(tx, runId));
  }

  /**
   * Reassemble a run row into its full state object, unvalidated.
   *
   * @param tx - Open transaction.
   * @param runId - Run to read.
   * @returns The assembled object, or null when absent.
   */
  private readRunRaw(tx: SqlTransaction, runId: RunId): Record<string, unknown> | null {
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
    return raw;
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
function patchStateSubsteps(
  state: RunbookState,
  substepStates: readonly SubstepState[],
  updatedAt: string,
): RunbookState {
  const snapshot = state.snapshot;
  const patchedSnapshot =
    snapshot && typeof snapshot === 'object' && 'context' in snapshot
      ? {
          ...(snapshot as Record<string, unknown>),
          context: {
            ...((snapshot as { context?: Record<string, unknown> }).context ?? {}),
            substepStates,
          },
        }
      : snapshot;
  return { ...state, substepStates, snapshot: patchedSnapshot, updatedAt };
}

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
 * Parse and validate a persisted `delegation_json` column into a
 * {@link DelegationClaimLinkage}.
 *
 * Validates against the canonical {@link DelegationClaimLinkageSchema} — the
 * single source of truth shared with in-memory `ClaimRecord` validation — so
 * this storage edge cannot drift from it. The no-migration policy forbids
 * trusting an unchecked cast: a corrupt or schema-incompatible row is rejected
 * with an explicit error so the recovery path is deliberate user action
 * (finish / prune / restart) rather than a silently-adapted bad claim escaping
 * into the session.
 *
 * @param json - Raw `delegation_json` column value.
 * @param claimKey - Claim lookup key, used only for the error message.
 * @returns The validated delegation linkage.
 * @throws {Error} When the JSON is unparseable or fails linkage validation.
 */
function parseDelegationLinkage(json: string, claimKey: string): DelegationClaimLinkage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Claim ${claimKey} carries an unparseable persisted delegation linkage; the runbook database is inconsistent: ${getErrorMessage(err)}`,
    );
  }
  const result = DelegationClaimLinkageSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Claim ${claimKey} carries a malformed persisted delegation linkage; the runbook database is inconsistent: ${result.error.message}`,
    );
  }
  return result.data;
}

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
    row.delegation_json !== null ? parseDelegationLinkage(row.delegation_json, row.key) : undefined;
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
