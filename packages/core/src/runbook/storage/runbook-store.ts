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
import { DelegationClaimLinkageSchema, makeRunbookStateSchema } from '../../schemas.js';
import type {
  RunbookState,
  ResolvedCompletion,
  Lifecycle,
  ExecutionRecoveryReason,
} from '../types.js';
import { type RunId, assertRunId } from '../run-id.js';
import {
  type ClaimRecord,
  type ClaimLookupKey,
  type DelegationClaimLinkage,
  assertClaimLookupKey,
  assertClaimSecretHash,
} from '../claim-id.js';
import { classifyDelegationLiveness, findSubstepState, linkageMatchesClaim } from '../targeting.js';
import { getErrorMessage } from '../../errors.js';
import { logger } from '../../logger.js';
import type { SessionData } from '../state.js';
import type { SqlDriver, SqlTransaction, SqlReadTransaction, SyncWork } from './sql-driver.js';
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
  hashExecutionToken,
  type ExecutionToken,
} from './mutation-result.js';

/** Machine lifecycle values persisted in the `runs.lifecycle` column. */
const LIFECYCLES: readonly Lifecycle[] = ['running', 'completed', 'stopped'];

/** Claim statuses persisted in the `claims.status` column. */
const CLAIM_STATUSES = ['active', 'superseded'] as const;

/** Persisted claim status: authority, or a retained tombstone. */
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

const EXECUTION_PHASES = [
  'claimed',
  'effect_started',
  'recovery_pending',
  'committed',
  'released',
] as const;

/** Execution phases persisted in `execution_attempts.phase`. */
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];

/**
 * Validate an execution phase string read from the column.
 *
 * @param value - Raw phase string.
 * @returns The validated phase.
 * @throws {Error} When the value is not a known execution phase.
 */
export function assertExecutionPhase(value: string): ExecutionPhase {
  if (!EXECUTION_PHASES.includes(value as ExecutionPhase)) {
    throw new Error(`Invalid persisted execution phase: ${JSON.stringify(value)}`);
  }
  return value as ExecutionPhase;
}

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
 * The ownership refusal arms an ownership-sensitive session mutation can return.
 *
 * Derived from {@link GuardedMutationResult} rather than re-declared, so the two
 * spellings of `execution_in_progress` / `recovery_required` cannot drift apart.
 * Neither arm mentions the committed value's type, so this is usable as a member
 * of any command-facing outcome union without threading a type parameter.
 */
export type SessionMutationRefusal = Extract<
  GuardedMutationResult<never>,
  { readonly kind: 'execution_in_progress' | 'recovery_required' }
>;

/**
 * Exhaustive outcome of an ownership-sensitive session mutation.
 *
 * Domain-specific results stay nested in the `committed` arm so an ownership
 * refusal cannot be confused with a domain-level `null` or status. A session
 * mutation refuses only on execution ownership — the CAS refusals
 * (`claim_superseded`, `concurrent_modification`) and `missing` belong to
 * guarded run-state writes, not to the session tables — so the alias narrows
 * {@link GuardedMutationResult} rather than widening a new union alongside it.
 *
 * @template T - Domain value returned after the session transaction commits.
 */
export type SessionMutationResult<T> =
  | Extract<GuardedMutationResult<T>, { readonly kind: 'committed' }>
  | SessionMutationRefusal;

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
 * Normalise an optional guard into a write-options object.
 *
 * Concentrates one branch that every layer forwarding a guard down the chain
 * would otherwise spell for itself, so the forwarding sites (state manager,
 * actor service, completion record and both drain loops) read the same way. It
 * also leaves `guard` genuinely absent rather than present-and-`undefined`, so a
 * future `'guard' in options` test cannot read an unguarded write as a guarded
 * one. Note this repo does not enable `exactOptionalPropertyTypes`, so the two
 * spellings are type-equivalent today — the helper buys consistency, not
 * type-level enforcement.
 *
 * @param guard - Guard to forward, or `undefined` on an unguarded write.
 * @returns `{}` when there is no guard, otherwise `{ guard }`.
 */
export function guardOptions(guard: ParentAdvanceGuard | undefined): {
  readonly guard?: ParentAdvanceGuard;
} {
  return guard === undefined ? {} : { guard };
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

/**
 * Build the execution-ownership refusal for a session mutation.
 *
 * One wording for one condition: the preflight arm and the normalized
 * trigger-abort arm of {@link RunbookStore.mutateSessionGuarded} describe the
 * same fact, and a caller must not be able to tell which one refused it.
 *
 * @param runId - Run whose active execution ownership blocked the mutation.
 * @returns The typed `execution_in_progress` refusal.
 */
function executionInProgressRefusal(runId: RunId): SessionMutationRefusal {
  return {
    kind: 'execution_in_progress',
    runId,
    message: `Run ${runId} has an execution in progress.`,
  };
}

/**
 * Internal rollback marker for an ownership abort classified in-transaction.
 *
 * The `claims_guard_*` / `stash_guard_*` triggers `RAISE(ABORT)` on a statement,
 * which SQLite rolls back without ending the transaction — so the classifying
 * read still runs, but the transaction must not commit the partial mutation.
 * Throwing this rolls it back; it is caught at exactly one boundary
 * ({@link RunbookStore.mutateSessionGuarded}) and becomes the typed refusal.
 * Never escapes the store.
 */
class SessionExecutionInProgressError extends Error {
  /**
   * Construct the marker for the owned run that blocked the session write.
   *
   * @param runId - Run whose active execution ownership aborted the statement.
   */
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
  /** Live parent run id for a delegated claim, else null (including deleted parents). */
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
  readonly execPhase: ExecutionPhase | null;
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

/** One dependency-ordered member of an aggregate owned-state commit. */
export interface OwnedRunSetMember {
  /** Authority captured before the aggregate effect. */
  readonly captured: CapturedAuthority;
  /** Exact effect-started attempt owning this member. */
  readonly execution: ExecutionExpectation & { readonly runId: RunId };
  /** Prepared machine-derived state to persist. */
  readonly next: RunbookState;
}

/** Input to {@link RunbookStore.commitOwnedRunSet}. */
export interface CommitOwnedRunSetInput {
  /** Members in dependency order: descendants before roots before external parents. */
  readonly members: readonly OwnedRunSetMember[];
  /**
   * Optional pure projection over the transaction's session snapshot.
   *
   * The caller owns release semantics; the repository only persists the
   * projected snapshot after every run owner has been cleared.
   */
  readonly updateSession?: (session: SessionData) => SyncWork<void>;
}

/** Optional projections applied by a single owned-state commit. */
export interface CommitOwnedStateOptions {
  /** Open-child guard checked before the authoritative state write. */
  readonly guard?: ParentAdvanceGuard;
  /** Pure projection over the transaction's session snapshot. */
  readonly updateSession?: (session: SessionData) => SyncWork<void>;
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
  tx: SqlReadTransaction,
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
    execPhase: raw.exec_phase === null ? null : assertExecutionPhase(raw.exec_phase),
  };
}

/** Outcome of capturing authority before an effectful mutation. */
export type CaptureResult =
  | { readonly kind: 'captured'; readonly authority: CapturedAuthority }
  | { readonly kind: 'missing'; readonly runId: RunId; readonly message: string }
  | { readonly kind: 'claim_superseded'; readonly runId: RunId; readonly message: string };

/** Authority capture paired with the exact run state read in the same transaction. */
export type CapturedRunStateResult =
  | {
      readonly kind: 'captured';
      readonly authority: CapturedAuthority;
      readonly state: RunbookState;
    }
  | Exclude<CaptureResult, { readonly kind: 'captured' }>;

/**
 * Classify a run for which no active controlling claim was found.
 *
 * This probe deliberately reads only row existence. Authority capture must not
 * deserialize state until a live claim exists to fence the state read.
 *
 * @param tx - Open read transaction.
 * @param runId - Target run.
 * @returns Missing when the run row is absent, otherwise claim superseded.
 */
function classifyRunWithoutControllingClaim(
  tx: SqlReadTransaction,
  runId: RunId,
): Exclude<CaptureResult, { readonly kind: 'captured' }> {
  const present = tx
    .prepare('SELECT 1 AS present FROM runs WHERE id = :runId')
    .get<{ readonly present: number }>({ runId });
  return present
    ? {
        kind: 'claim_superseded',
        runId,
        message: `Run ${runId} has no active controlling claim.`,
      }
    : { kind: 'missing', runId, message: `Run ${runId} does not exist.` };
}

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
  tx: SqlReadTransaction,
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
 * @param tx - Open read transaction.
 * @param runId - Target run.
 * @returns The controlling claim's lookup key, or `null` when the run has none.
 * @throws {Error} When two active claims control the run — a corruption the
 *   partial unique index makes unreachable — rather than selecting an arbitrary one.
 */
export function resolveControllingClaim(
  tx: SqlReadTransaction,
  runId: RunId,
): ClaimLookupKey | null {
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

/**
 * A claim row read by key regardless of status.
 *
 * `readSession` surfaces only active claims, because only those are targeting
 * authority. A caller that must tell "this bearer was superseded" apart from
 * "this bearer never existed" needs the tombstone too — that distinction is the
 * difference between a no-retry signal and a message the holder reads as a
 * mistyped id.
 */
export interface PresentedClaim {
  /** Persisted status: `active`, or `superseded` for a tombstone. */
  readonly status: ClaimStatus;
  /** The claim record itself, deserialized exactly as an active row would be. */
  readonly record: ClaimRecord;
}

/** Sync typed operations available inside a store READ transaction. */
export interface RunbookStoreReadTxn {
  /** Underlying read transaction, for advanced/composite queries within the store. */
  readonly tx: SqlReadTransaction;
  /** Read the joined commit row for a run + claim. */
  commitRow(runId: RunId, claimKey: ClaimLookupKey): CommitRow;
  /** Read a claim by key including tombstones, or null when the key is unknown. */
  claim(key: ClaimLookupKey): PresentedClaim | null;
  /** Read the current default stack. */
  stack(): readonly RunId[];
  /** Read the current stash slot. */
  stash(): RunId | null;
}

/**
 * Sync typed operations available inside a store WRITE transaction.
 *
 * Extends the read facade with every mutating operation, so a read transaction
 * cannot be handed a writer by construction (the driver's `SqlReadTransaction`
 * exposes no `run`/`exec`).
 */
export interface RunbookStoreTxn extends RunbookStoreReadTxn {
  /** Underlying writing transaction, for advanced/composite operations within the store. */
  readonly tx: SqlTransaction;
  /** Insert a brand-new run at version/generation 0. */
  insertRun(state: RunbookState): void;
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
  /**
   * Move a claim's `updated_at` ("this record was last written").
   *
   * Deliberately distinct from {@link recordClaimSeen}, which moves `last_seen_at`
   * ("the holder presented its bearer as authority"). Merging them would let an
   * unrelated claim write silently refresh the #519 idle clock. Like that method
   * this writes pure metadata: `updated_at` is outside both `claims_guard_update`
   * and `claims_bump_gen_update`, so it is neither refused under an execution
   * owner nor bumps `claim_generation`.
   */
  touchClaimUpdatedAt(key: ClaimLookupKey, now: string): void;
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
  /**
   * Read the run's latest recovery-pending epoch, or null when none is pending.
   *
   * Read inside the mutating transaction: a run whose execution outcome is
   * unknown must not have its session targeting rewritten under it, and the
   * check is only meaningful against the same snapshot the write lands on.
   */
  pendingRecovery(runId: RunId): { readonly epoch: ExecutionEpoch } | null;
  /** Whether the run currently has active execution ownership (`exec_token`). */
  executionOwned(runId: RunId): boolean;
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
   * Capture a presented claim's authority and target state in one read transaction.
   *
   * @param runId - Target run.
   * @param claimKey - Lookup key derived from the presented bearer.
   * @returns Captured authority plus the exact state it describes, or a typed refusal.
   * @throws {Error} When the captured run's persisted state fails validation.
   */
  captureAuthorityState(runId: RunId, claimKey: ClaimLookupKey): Promise<CapturedRunStateResult> {
    return this.driver.read((tx) => {
      const captured = captureAuthority(tx, runId, claimKey);
      if (captured.kind !== 'captured') return captured;
      const state = this.readRun(tx, runId);
      if (state === null) {
        return { kind: 'missing' as const, runId, message: `Run ${runId} does not exist.` };
      }
      return { ...captured, state };
    });
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
   * @throws {Error} When a controlled run's persisted state fails schema validation.
   */
  async captureRunAuthority(runId: RunId): Promise<CaptureResult> {
    const captured = await this.captureRunAuthorityState(runId);
    if (captured.kind !== 'captured') return captured;
    const { state: _state, ...authority } = captured;
    return authority;
  }

  /**
   * Capture bare-run authority and its state from one read transaction.
   *
   * @param runId - Target run.
   * @returns Captured authority plus the exact state it describes, or a typed refusal.
   * @throws {Error} When a controlled run's persisted state fails schema validation. Uncontrolled
   *   runs are refused from an existence-only probe without deserializing their state.
   */
  captureRunAuthorityState(runId: RunId): Promise<CapturedRunStateResult> {
    return this.driver.read((tx) => {
      const claimKey = resolveControllingClaim(tx, runId);
      if (claimKey === null) {
        return classifyRunWithoutControllingClaim(tx, runId);
      }
      const captured = captureAuthority(tx, runId, claimKey);
      if (captured.kind !== 'captured') return captured;
      const state = this.readRun(tx, runId);
      if (state === null) {
        return { kind: 'missing' as const, runId, message: `Run ${runId} does not exist.` };
      }
      return { ...captured, state };
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
   * Load a single claim by key, tombstones included.
   *
   * The deliberate counterpart to {@link loadSession}, which surfaces only active
   * claims: a caller resolving a presented bearer needs the superseded row too,
   * so a claim that lost authority is refused as superseded rather than reported
   * as one that never existed.
   *
   * @param key - Claim lookup key derived from the presented bearer.
   * @returns The claim and its status, or null when no row carries that key.
   */
  loadClaim(key: ClaimLookupKey): Promise<PresentedClaim | null> {
    return this.driver.read((tx) => this.readClaim(tx, key));
  }

  /**
   * Revalidate an exact captured authority set without acquiring ownership or writing state.
   *
   * This is the linearization point for write-free outcomes prepared from a
   * prior capture. It prevents a no-op response (notably deterministic bearer
   * recovery) from escaping after claim rotation, state replacement, or a new
   * execution owner invalidated the evidence used to prepare it.
   *
   * @param captured - Dependency-ordered authority captures to validate atomically.
   * @returns Committed void when every capture is still exact, otherwise the first refusal.
   */
  validateCapturedRunSet(
    captured: readonly CapturedAuthority[],
  ): Promise<GuardedMutationResult<void>> {
    if (captured.length === 0) {
      throw new Error('Captured authority validation requires at least one run.');
    }
    const runIds = new Set(captured.map(({ runId }) => runId));
    if (runIds.size !== captured.length) {
      throw new Error('Captured authority validation repeats a run.');
    }
    return this.driver.read((tx) => {
      for (const authority of captured) {
        const classification = classifyCommitRow(
          selectCommitRow(tx, authority.runId, authority.claimKey),
          authority,
        );
        if (classification.kind !== 'ok') return classificationToResult(classification);
      }
      return { kind: 'committed', value: undefined };
    });
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
   * @param options - Optional guards and session projection for the owned commit.
   * @returns The committed state, or a typed refusal.
   */
  commitOwnedState(
    captured: CapturedAuthority,
    execution: ExecutionExpectation,
    next: RunbookState,
    options: CommitOwnedStateOptions = {},
  ): Promise<GuardedMutationResult<RunbookState>> {
    return this.transaction((txn) => {
      const row = txn.commitRow(captured.runId, captured.claimKey);
      const classification = classifyCommitRow(row, captured, execution);
      if (classification.kind !== 'ok') {
        if (this.isExactAttemptCommitted(txn.tx, captured.runId, execution)) {
          return { kind: 'committed', value: next };
        }
        return classificationToResult(classification);
      }
      this.assertParentAdvanceAllowed(txn.tx, captured.runId, options.guard);
      this.writeOwnedState(txn.tx, captured, execution, next);
      if (options.updateSession !== undefined) {
        const session = this.readSession(txn.tx);
        options.updateSession(session);
        this.applySession(txn, session);
      }
      return { kind: 'committed', value: next };
    });
  }

  /**
   * Commit an aggregate effect's prepared run states and session projection.
   *
   * Every member is classified before the first write. Members are then written
   * in caller-supplied dependency order, after which the optional session
   * projection is applied while all affected execution owners are already
   * cleared. Any refusal writes nothing; any thrown projection rolls the entire
   * transaction back.
   *
   * @param input - Dependency-ordered owned states and optional session projection.
   * @returns Every committed state, or the first typed refusal.
   * @throws {Error} When the input repeats a run or its identities disagree.
   */
  commitOwnedRunSet(
    input: CommitOwnedRunSetInput,
  ): Promise<GuardedMutationResult<readonly RunbookState[]>> {
    if (input.members.length === 0) {
      throw new Error('Aggregate owned-state commit requires at least one member.');
    }
    const seen = new Set<RunId>();
    for (const member of input.members) {
      const runId = member.captured.runId;
      if (seen.has(runId)) {
        throw new Error(`Aggregate owned-state commit repeats run ${runId}.`);
      }
      if (member.execution.runId !== runId || member.next.id !== runId) {
        throw new Error(`Aggregate owned-state identities disagree for run ${runId}.`);
      }
      seen.add(runId);
    }

    return this.transaction((txn) => {
      const alreadyCommitted = input.members.every((member) =>
        this.isExactAttemptCommitted(txn.tx, member.captured.runId, member.execution),
      );
      if (alreadyCommitted) {
        return { kind: 'committed', value: input.members.map((member) => member.next) };
      }
      for (const member of input.members) {
        const row = txn.commitRow(member.captured.runId, member.captured.claimKey);
        const classification = classifyCommitRow(row, member.captured, member.execution);
        if (classification.kind !== 'ok') {
          return classificationToResult(classification);
        }
      }

      for (const member of input.members) {
        this.writeOwnedState(txn.tx, member.captured, member.execution, member.next);
      }
      if (input.updateSession !== undefined) {
        const session = this.readSession(txn.tx);
        input.updateSession(session);
        this.applySession(txn, session);
      }
      return { kind: 'committed', value: input.members.map((member) => member.next) };
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
   * `build` is re-invoked from scratch on every retry, so it MUST be free of
   * external side effects: under contention it can run `attempts` times (default
   * 8), and the retry loop applies NO backoff — all 8 invocations can land within
   * a few milliseconds. Only the final, committed return value is persisted;
   * anything a losing attempt did outside the returned state is unwound by nothing.
   *
   * Note the CAS asymmetry: {@link writeStateAtVersion} guards on `state_version`
   * only, NOT on `claim_generation` (unlike {@link applyStateUpdate}). A claim
   * revoked between an out-of-band authority check and this commit is therefore
   * invisible here. That is sound for the claim-free contract this method
   * documents, but callers MUST NOT treat a `committed` result as evidence that
   * their authority was still valid at commit time — use
   * {@link RunbookStore.saveState} when the write must be claim-guarded.
   *
   * @param runId - Run to mutate.
   * @param build - Derives the next state from the current one; `null` means no
   *   change. May be invoked once per attempt — see the side-effect constraint above.
   * @param options - Optional attempt budget (default 8) and parent-advance guard.
   * @param options.attempts - Maximum optimistic retry cycles before reporting
   *   `concurrent_modification`.
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
   * Claims are reconciled rather than rewritten: an active claim absent from
   * `session` becomes a tombstone (never a hard delete, so issuance history
   * survives), and a genuinely new claim is inserted. Existing active claims are
   * left untouched so this wholesale save never churns `claim_generation` or
   * clobbers `last_seen_at` — claim activity is written only at the authorization
   * seam via {@link RunbookStoreTxn.recordClaimSeen}.
   *
   * Incoming claims are classified against ALL persisted claims, not just the
   * active ones, because "not active" is not "absent". A session snapshot may be
   * stale — the store is the transactional replacement for `SessionLock`, so a
   * lost update is a normal race, not a lock violation — and both stale shapes
   * must reconcile rather than surface a raw SQLite constraint error:
   *
   * - **Persisted and active** — left untouched (see above).
   * - **Persisted but superseded** — skipped, never reactivated. The tombstone is
   *   an authoritative revocation recorded at the claim lifecycle seam; letting a
   *   stale bulk save resurrect it would restore revoked authority, bump
   *   `claim_generation` through `claims_bump_gen_update` (invalidating every live
   *   capture), and be refused outright by `claims_guard_update` whenever the
   *   controlled run is owned. Skipping converges on the newer, authoritative
   *   state.
   * - **Absent, controlling a run that no longer exists** — skipped. The
   *   `controlled_run` FK is `ON DELETE CASCADE`, so the row was removed by an
   *   authoritative run deletion (`rd prune`); the claim is dead by definition and
   *   there is nothing left to reference. Skipping (rather than throwing) keeps
   *   this void bulk reconciler convergent for a race it is expected to lose;
   *   persisted state already reflects the deletion.
   * - **Absent, controlling a live run** — inserted at that run's current
   *   generation.
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
   * `work` is synchronous by construction, and {@link SyncWork} makes that a
   * compile-time contract rather than a convention. A transaction must not be
   * held across an `await` — that is what makes the sqljs single-connection
   * driver safe — so every dependency a session mutation needs is available on
   * the passed operations (notably {@link RunbookStoreTxn.readState} for
   * run-state reads) rather than fetched by the caller mid-cycle.
   *
   * @template T - Value the mutation returns to its caller.
   * @param work - Mutates `ctx.session` in place and returns the caller's result.
   * @returns The work's return value, once committed.
   */
  mutateSession<T>(work: (ctx: SessionMutationTxn) => SyncWork<T>): Promise<T> {
    return this.transaction((txn): SyncWork<T> => {
      const session = this.readSession(txn.tx);
      const result = work({ ...txn, session });
      this.applySession(txn, session);
      return result;
    });
  }

  /**
   * {@link mutateSession} with the execution-ownership refusals made typed.
   *
   * The schema triggers already enforce ownership — a claim or stash write while
   * `exec_token` is set aborts the statement. This method adds classification,
   * not enforcement: it pre-checks each affected run inside the same transaction
   * (so a refusal is decided against the snapshot the write would land on), and
   * normalizes a trigger abort that slips past the preflight into the same typed
   * refusal instead of an opaque `Error`.
   *
   * Recovery is checked before ownership, and runs are checked in caller-supplied
   * order, so a fixed set of affected runs always refuses with the same reason on
   * the same run.
   *
   * Normalization is by EXACT message equality against `execution_in_progress`,
   * the text the guard triggers raise (pinned for both drivers by the
   * driver-contract "surfaces a RAISE(ABORT) message verbatim" case). Any other
   * error — and an `execution_in_progress` abort naming no affected run — is
   * rethrown unchanged rather than mislabelled.
   *
   * @template T - Value the mutation returns to its caller.
   * @param runIds - Affected runs in deterministic refusal order, or a selector
   *   reading them off the session snapshot when they are not known in advance.
   * @param work - Mutates `ctx.session` in place and returns the caller's result.
   * @returns The committed value, or the first ownership refusal.
   * @throws {Error} Any non-ownership failure raised by `work` or the write.
   */
  async mutateSessionGuarded<T>(
    runIds: readonly RunId[] | ((session: SessionData) => readonly RunId[]),
    work: (ctx: SessionMutationTxn) => SyncWork<T>,
  ): Promise<SessionMutationResult<T>> {
    try {
      return await this.transaction((txn) => {
        const session = this.readSession(txn.tx);
        const affected = typeof runIds === 'function' ? runIds(session) : runIds;
        for (const runId of affected) {
          const pending = txn.pendingRecovery(runId);
          if (pending !== null) {
            return {
              kind: 'recovery_required',
              runId,
              epoch: pending.epoch,
              message: `Run ${runId} ended execution with an unknown outcome at epoch ${String(pending.epoch)}; run recovery before continuing.`,
            } satisfies SessionMutationResult<T>;
          }
          if (txn.executionOwned(runId)) {
            return executionInProgressRefusal(runId) satisfies SessionMutationResult<T>;
          }
        }
        try {
          const value = work({ ...txn, session });
          this.applySession(txn, session);
          return { kind: 'committed', value } satisfies SessionMutationResult<T>;
        } catch (error: unknown) {
          if (getErrorMessage(error) === 'execution_in_progress') {
            const owned = affected.find((candidate) => txn.executionOwned(candidate));
            if (owned !== undefined) {
              throw new SessionExecutionInProgressError(owned);
            }
          }
          throw error;
        }
      });
    } catch (error: unknown) {
      // Same-realm marker class, so `instanceof` is the correct (allow-listed) check.
      if (!(error instanceof SessionExecutionInProgressError)) {
        throw error;
      }
      return executionInProgressRefusal(error.runId);
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
    const persisted = new Map(
      txn.tx
        .prepare('SELECT key, status FROM claims')
        .all<{ readonly key: string; readonly status: string }>()
        .map((row) => [row.key, row.status] as const),
    );
    // Only active claims are droppable; re-marking an existing tombstone would
    // fire the resolution-affecting claim triggers for no change.
    const stale = new Set(
      [...persisted].filter(([, status]) => status === 'active').map(([key]) => key),
    );
    const inserts: ClaimRecord[] = [];
    for (const [key, record] of Object.entries(session.claims)) {
      if (persisted.has(key)) {
        stale.delete(key);
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
      // Read after the tombstones above: each one bumps the controlled run's
      // claim_generation, so reading before them would record an issuance
      // generation this same transaction has already superseded.
      const generation = txn.tx
        .prepare('SELECT claim_generation AS g FROM runs WHERE id = :id')
        .get<{ readonly g: number }>({ id: record.controlledRunId })?.g;
      if (generation === undefined) {
        // Converging on the deletion is right for a bulk reconciler losing a
        // race it is expected to lose, but the drop must not be silent: the
        // mint path returns a claim_id to its caller once this resolves, so an
        // unrecorded claim resurfaces much later as an unexplained
        // ACTOR_CONTEXT_REQUIRED with nothing pointing back to here.
        void logger.warn('session claim skipped: controlled run no longer exists', {
          claimKey: record.claimKey,
          runId: record.controlledRunId,
        });
        continue;
      }
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
    tx: SqlReadTransaction,
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
    this.assertParentAdvanceAllowed(tx, runId, guard);
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
   * Assert an optional parent-advance guard inside the decisive transaction.
   *
   * @param tx - Open write transaction containing the decisive state update.
   * @param runId - Run receiving the guarded update.
   * @param guard - Optional parent-advance guard to evaluate.
   * @throws {Error} When the guard targets another run or open delegated children remain.
   */
  private assertParentAdvanceAllowed(
    tx: SqlTransaction,
    runId: RunId,
    guard?: ParentAdvanceGuard,
  ): void {
    if (guard === undefined) return;
    if (guard.parentRunId !== runId) {
      throw new Error(
        `Parent-advance guard for ${guard.parentRunId} misapplied to write of ${runId}.`,
      );
    }
    const open = this.openDelegatedChildrenFor(tx, runId);
    if (open.length > 0) {
      throw new OpenDelegatedChildrenError(open);
    }
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
   * Persists the `recoveryRequired` snapshot (lifecycle stays `running`), closes
   * the exact recovery attempt as committed with its reason and finish time, and
   * clears active ownership atomically.
   *
   * The two guards refuse differently because they mean different things. When the
   * run no longer names the interrupted epoch, a concurrent recovery already won:
   * that is ordinary contention, nothing has been written, and it returns a typed
   * `execution_in_progress`. When the run still names the epoch but its attempt row
   * has left `recovery_pending`, no writer of `execution_attempts.phase` can have
   * produced that pairing — both `committed` transitions clear `runs.exec_*` in the
   * same transaction — so it throws and rolls back the run UPDATE. A typed refusal
   * there would commit half a recovery: ownership cleared and state advanced, with
   * the attempt still open.
   *
   * Unlike the three authoritative commit sites, this does not call
   * {@link afterAuthoritativeStateWrite}: restoring an attempt's own snapshot
   * under an unchanged lifecycle closes no delegation and resolves no
   * completion. See that method's remarks.
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
   * Build the typed read facade over an open read transaction.
   *
   * @param tx - Open read transaction.
   * @returns Typed store read operations.
   */
  private readOps(tx: SqlReadTransaction): RunbookStoreReadTxn {
    const store = this;
    return {
      tx,
      commitRow(runId, claimKey) {
        return selectCommitRow(tx, runId, claimKey);
      },
      claim(key) {
        return store.readClaim(tx, key);
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
   * Build the typed operation facade over an open writing transaction.
   *
   * @param tx - Open writing transaction.
   * @returns Typed store operations.
   */
  private ops(tx: SqlTransaction): RunbookStoreTxn {
    const store = this;
    return {
      ...this.readOps(tx),
      tx,
      insertRun(state) {
        store.insertRun(tx, state);
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
      touchClaimUpdatedAt(key, now) {
        tx.prepare('UPDATE claims SET updated_at = :now WHERE key = :key').run({ key, now });
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
   * Write one already-classified owned state and close its exact attempt.
   *
   * @param tx - Open aggregate/single-run transaction.
   * @param captured - Authority already classified in this transaction.
   * @param execution - Exact effect-started owner.
   * @param next - Prepared state to persist.
   */
  private writeOwnedState(
    tx: SqlTransaction,
    captured: CapturedAuthority,
    execution: ExecutionExpectation,
    next: RunbookState,
  ): void {
    const hash = hashExecutionToken(execution.token);
    const changes = tx
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
    this.afterAuthoritativeStateWrite(tx, next);
    const attemptChanges = tx
      .prepare(
        `UPDATE execution_attempts
            SET phase = 'committed', finished_at = :now
          WHERE run_id = :runId AND exec_epoch = :epoch
            AND exec_token = :hash AND phase = 'effect_started'`,
      )
      .run({ now: next.updatedAt, runId: captured.runId, epoch: execution.epoch, hash }).changes;
    assertExactlyOneRow(attemptChanges, captured.runId);
  }

  /**
   * Test whether an exact secret execution identity already committed durably.
   *
   * @param tx - Open transaction used to inspect the attempt row.
   * @param runId - Run whose attempt is being inspected.
   * @param execution - Exact execution token and epoch to match.
   * @returns Whether that exact attempt is durably committed.
   */
  private isExactAttemptCommitted(
    tx: SqlTransaction,
    runId: RunId,
    execution: ExecutionExpectation,
  ): boolean {
    const row = tx
      .prepare(
        `SELECT 1 AS committed FROM execution_attempts
          WHERE run_id = :runId AND exec_epoch = :epoch
            AND exec_token = :hash AND phase = 'committed'`,
      )
      .get<{ readonly committed: 1 }>({
        runId,
        epoch: execution.epoch,
        hash: hashExecutionToken(execution.token),
      });
    return row !== undefined;
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
   * Run the common bookkeeping an authoritative run-state write owes.
   *
   * Invoked exactly once by each authoritative commit site — the shared owned
   * write in {@link writeOwnedState}, the CAS write behind {@link mutateState},
   * and the captured-authority write behind {@link saveState} — after a run
   * UPDATE changes exactly one row, never on a
   * zero-row/stale/owned outcome, so the resolved-completion projection and the
   * delegated-claim supersession latch stay in lockstep with the committed
   * state. This is the single home for the parent half of R2's two-sided
   * durable latch.
   *
   * {@link commitRecovery} is deliberately NOT one of those sites: it restores
   * the interrupted attempt's own snapshot under the same lifecycle rather than
   * moving a cursor or ending a run, so it can close no delegation. Any cursor
   * movement that follows recovery commits through one of the sites above
   * and invalidates there. Do not read the phrase "every state write" literally
   * — `state_json` is written through recovery plus the single-run and aggregate
   * owned paths, CAS mutation, and captured-authority save; this hook covers all
   * authoritative paths except recovery.
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
   * A claim whose *controlled child* has reached `completed` or `stopped` is
   * retained even when the parent side reads closed. Such a claim is no longer
   * mutation authority, but it is the terminal evidence `rd pass`/`rd fail`
   * resolve to report `already-resolved` or `DELEGATION_RESULT_CONFLICT`, and
   * that `rd prune` collects. Superseding it makes the claim unresolvable, and
   * an unresolvable claim reports `CLAIMED_RUNBOOK_UNAVAILABLE` — collapsing
   * `terminal-child` into a refusal that names the wrong cause.
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
        `SELECT claims.key AS key,
                claims.delegation_json AS delegation_json,
                runs.lifecycle AS controlled_lifecycle,
                runs.exec_token AS controlled_exec_token
           FROM claims
           JOIN runs ON runs.id = claims.controlled_run
          WHERE claims.parent_run_id = :parentId AND claims.status = 'active'`,
      )
      .all<{
        readonly key: string;
        readonly delegation_json: string | null;
        readonly controlled_lifecycle: string;
        readonly controlled_exec_token: string | null;
      }>({
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
      // Terminal evidence outlives the parent-side delegation. Checked before
      // classification, not after: every terminal child also reads closed on the
      // parent side (its substep is `done`), so the order is what decides.
      // Validated at this edge like every other raw row — an unknown lifecycle
      // must abort, not read as non-terminal and silently supersede the claim.
      const controlledLifecycle = assertLifecycle(row.controlled_lifecycle);
      if (controlledLifecycle === 'completed' || controlledLifecycle === 'stopped') {
        continue;
      }
      // An executing child cannot be superseded from here. `status` is inside
      // claims_guard_update's column list, so the UPDATE below would RAISE
      // 'execution_in_progress' and roll back THIS parent's commit — an
      // unrelated write failing because a child happens to be mid-execution.
      // Deferring costs no enforcement: the claim-side half of the same latch
      // (`SessionService.claimRunbook`, which classifies liveness against the
      // parent read in its own transaction) already refuses a closed delegation
      // without consulting this row's status. The tombstone lands on the next
      // authoritative parent write after the child releases ownership.
      if (row.controlled_exec_token !== null) {
        continue;
      }
      // Validated, not cast: a malformed linkage must abort like every other
      // raw row at this edge, not reach the classifier as a shape-checked lie.
      const linkage = deserializeDelegation(row.delegation_json);
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
   * A request that matches the persisted value performs no write at all. The slot
   * is guarded by `stash_guard_insert`/`stash_guard_delete`, which refuse while
   * the slot's run has an active execution owner; an unconditional
   * delete-then-insert therefore made an owned run sitting in the stash poison
   * every unrelated session save. An unchanged slot cannot change claim
   * resolution, which is exactly what those guards exist to protect, so the
   * refusal was spurious. Every real transition (null→id, id→null, id→other) still
   * performs its guarded write and still bumps `claim_generation` on both affected
   * runs via `stash_bump_gen_insert`/`stash_bump_gen_delete`.
   *
   * @param tx - Open transaction.
   * @param runId - Run to stash, or null to clear.
   */
  private setStash(tx: SqlTransaction, runId: RunId | null): void {
    if (this.readStash(tx) === runId) {
      return;
    }
    // Past the equality check the slot is guaranteed to differ, so this DELETE
    // either removes the one row that must go (firing its guard and bump) or
    // matches nothing — a row-level trigger cannot fire on an empty table.
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
  private readRun(tx: SqlReadTransaction, runId: RunId): RunbookState | null {
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
  private readRunRaw(tx: SqlReadTransaction, runId: RunId): Record<string, unknown> | null {
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
   * Accumulates into a NULL-prototype object. A completion key is arbitrary
   * persisted text, so on a `{}` literal a `__proto__` key would hit
   * `Object.prototype`'s setter — silently dropping the row and mutating the
   * object's prototype instead of storing an own property.
   *
   * @param tx - Open transaction.
   * @param runId - Run whose completions to read.
   * @returns The completion map, empty when the run has none.
   */
  private readResolvedCompletions(tx: SqlReadTransaction, runId: RunId): Record<string, unknown> {
    const rows = tx
      .prepare(
        'SELECT completion_key, payload_json FROM resolved_completions WHERE run_id = :runId',
      )
      .all<{ readonly completion_key: string; readonly payload_json: string }>({ runId });
    const out = Object.create(null) as Record<string, unknown>;
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
  private readSession(tx: SqlReadTransaction): SessionData {
    const claims: Record<string, ClaimRecord> = {};
    // Only active claims are usable targeting authority; superseded tombstones are
    // retained for commit-validity/generation accounting and for the by-key read
    // in `readClaim` (which tells a superseded bearer apart from an unknown one),
    // but never surfaced here.
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
   * Read one claim by key, whatever its status.
   *
   * @param tx - Open transaction.
   * @param key - Claim lookup key.
   * @returns The claim and its validated status, or null when the key is unknown.
   * @throws {Error} When the row carries a status outside the persisted union, or
   *   malformed grants/delegation JSON (invalid state, validated at this edge).
   */
  private readClaim(tx: SqlReadTransaction, key: ClaimLookupKey): PresentedClaim | null {
    const row = tx.prepare('SELECT * FROM claims WHERE key = :key').get<ClaimRow>({ key });
    if (row === undefined) {
      return null;
    }
    return { status: assertClaimStatus(row.status), record: deserializeClaim(row) };
  }

  /**
   * Read the default stack in order.
   *
   * @param tx - Open transaction.
   * @returns Ordered run ids.
   */
  private readStack(tx: SqlReadTransaction): readonly RunId[] {
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
  private readStash(tx: SqlReadTransaction): RunId | null {
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

/**
 * Validate a claim status string read from the column.
 *
 * @param value - Raw status string.
 * @returns The validated status.
 * @throws {Error} When the value is not a known claim status.
 */
function assertClaimStatus(value: string): ClaimStatus {
  if (!CLAIM_STATUSES.includes(value as ClaimStatus)) {
    throw new Error(`Invalid persisted claim status: ${JSON.stringify(value)}`);
  }
  return value as ClaimStatus;
}

/** Zod schema for the grants JSON blob, kept permissive at this edge. */
const GrantsSchema = z.array(z.record(z.string(), z.unknown()));

/**
 * Reconstruct a delegation linkage from its persisted blob.
 *
 * The writer only ever stores a linkage built from branded values, so a blob
 * that fails here means the database was corrupted outside this store. Every
 * branded field is re-validated rather than cast, so a corrupt row cannot
 * re-enter the domain wearing brands it does not satisfy.
 *
 * @param json - Raw `delegation_json` column value.
 * @returns The validated delegation linkage.
 * @throws {Error} When the blob is not a well-formed delegation linkage.
 */
function deserializeDelegation(json: string): DelegationClaimLinkage {
  try {
    const parsed = DelegationClaimLinkageSchema.safeParse(JSON.parse(json));
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    return parsed.data;
  } catch (error) {
    throw new Error(`Invalid persisted delegation linkage: ${getErrorMessage(error)}`);
  }
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
    row.delegation_json !== null ? deserializeDelegation(row.delegation_json) : undefined;
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
