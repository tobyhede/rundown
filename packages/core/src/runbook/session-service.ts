// packages/core/src/runbook/session-service.ts

/**
 * Session stack orchestration service for runbooks.
 *
 * Owns which runbook is active, push/pop lifecycle,
 * and stash/restore operations. Composes {@link RunbookStateManager}
 * for raw session persistence — does not own disk I/O.
 *
 * @module
 */

import type { RunbookStateManager, SessionData } from './state.js';
import { isRunId, type RunId } from './run-id.js';
import {
  parentAdvanceGuard,
  assertExactlyOneRow,
  classifyCommitRow,
  isOpenDelegatedChildrenError,
  type ParentAdvanceGuard,
  type SessionMutationRefusal,
  type SessionMutationResult,
  type SessionMutationTxn,
} from './storage/runbook-store.js';
import type { CapturedAuthority, GuardedMutationResult } from './storage/mutation-result.js';
import type { SyncWork } from './storage/sql-driver.js';
import type {
  PreparedDelegationChildLink,
  PreparedDelegationChildUnlink,
} from './actor-service.js';
import {
  createDelegatedChildGrants,
  createClaimRecord,
  createRunControlGrants,
  hashClaimSecret,
  parseClaimBearer,
  generateClaimBearer,
  seenClaimRecord,
  refreshedClaimRecord,
  verifyClaimSecret,
  type ClaimId,
  type ClaimIdResolution,
  type ClaimLookupKey,
  type ClaimRecord,
  type ClaimRunbookResult,
  type ClaimSupersededReason,
  type ClaimVerificationResult,
  type DelegationClaimLinkage,
  type SupersededDelegationOrigin,
  type VerifiedClaim,
} from './claim-id.js';
import type { DelegationLinkage, RunbookState } from './types.js';
import {
  delegationRuntimeCapabilities,
  type DelegationRuntimeCapabilities,
} from './delegation-credential.js';
import {
  classifyDelegationLiveness,
  delegationAuthorityCoordinatesMatch,
  findSubstepState,
  linkageMatchesClaim,
} from './targeting.js';
import {
  DELEGATION_COLLECTION_PENDING_MESSAGE,
  readDelegationCollectionPendingForPolicy,
} from './delegation-lifecycle-read-model.js';

/** Result of removing a runbook from session targeting structures. */
export type ReleaseRunbookResult =
  | { readonly status: 'not-found'; readonly runbookId: RunId }
  | {
      readonly status: 'released';
      readonly runbookId: RunId;
      readonly removedFromDefaultStack: boolean;
      readonly nextDefaultRunbookId: RunId | null;
    };

/**
 * In-memory run-control credential prepared before a run is activated.
 *
 * The bearer is intentionally absent from persisted state until the matching
 * atomic activation installs {@link claim}. Callers must keep this value in
 * process memory only.
 */
export interface PreparedRunControlClaim {
  /** Public bearer returned to the run controller after activation commits. */
  readonly claimId: ClaimId;
  /** Proof-backed record installed in the session transaction. */
  readonly claim: ClaimRecord;
  /**
   * Claim-bound delegation capabilities retained in process memory only.
   *
   * One branded pair rather than two independently optional callables: the
   * issuer and the deriver are two halves of ONE authority (a descriptor minted
   * by an issuer is refused RD-821 by a deriver bound to a different issuer
   * claim), so a one-sided value is not a state this producer can reach and the
   * type says so.
   */
  readonly delegationRuntime: DelegationRuntimeCapabilities;
}

/**
 * Outcome of {@link SessionService.adoptRunControlClaim}.
 *
 * Refusal-biased by construction: the only `adopted` arm is one where the
 * replaced claim provably issued nothing, so no delivered credential is
 * orphaned by the replacement.
 */
export type RunControlAdoption =
  | {
      /** Authority was re-established; the runtime is process-memory only. */
      readonly kind: 'adopted';
      /** Bearer, persisted record, and claim-bound delegation capabilities. */
      readonly runtime: PreparedRunControlClaim;
    }
  | {
      /** The run already carries a credential the replacement could not reproduce. */
      readonly kind: 'refused_credential_issued';
      /** Run whose control could not be adopted. */
      readonly runId: RunId;
    }
  | {
      /** The guarded session mutation itself refused. */
      readonly kind: 'refused_session';
      /** The exact session refusal, for the caller to render. */
      readonly refusal: SessionMutationRefusal;
    };

/**
 * Project one terminal release onto an in-memory session snapshot.
 *
 * @param session - Session snapshot to mutate in place.
 * @param runbookId - Run to remove from session targeting structures.
 * @param options - Terminal-claim retention policy.
 * @param options.retainClaimsAsTerminal - Whether matching claims remain as terminal tombstones.
 * @returns Structured release result for the projected snapshot.
 */
export function projectRunbookRelease(
  session: SessionData,
  runbookId: RunId,
  options: { readonly retainClaimsAsTerminal?: boolean } = {},
): ReleaseRunbookResult {
  const originalDefaultStackLength = session.defaultStack.length;
  session.defaultStack = session.defaultStack.filter((id) => id !== runbookId);
  const removedFromDefaultStack = session.defaultStack.length !== originalDefaultStackLength;

  const removedClaimIds: string[] = [];
  const retainedClaimIds: string[] = [];
  for (const [claimKey, claim] of Object.entries(session.claims)) {
    if (claim.controlledRunId === runbookId) {
      if (options.retainClaimsAsTerminal) {
        retainedClaimIds.push(claimKey);
      } else {
        removedClaimIds.push(claimKey);
        delete session.claims[claimKey];
      }
    }
  }

  const removedFromStash = session.stashedRunbookId === runbookId;
  if (removedFromStash) session.stashedRunbookId = undefined;

  if (
    !removedFromDefaultStack &&
    removedClaimIds.length === 0 &&
    retainedClaimIds.length === 0 &&
    !removedFromStash
  ) {
    return { status: 'not-found', runbookId };
  }
  return {
    status: 'released',
    runbookId,
    removedFromDefaultStack,
    nextDefaultRunbookId: session.defaultStack[session.defaultStack.length - 1] ?? null,
  };
}

/** Force-terminal command kind that drives inline-root resolution. */
export type InlineForceTerminalKind = 'complete' | 'stop';

/**
 * Plan describing how a bare `rd complete` / `rd stop` force-terminal command
 * should cascade across the active inline composition chain.
 *
 * Resolution climbs `parentLinkage.kind === 'inline'` from the active runbook,
 * stopping before any delegation boundary, to find the outermost
 * contiguous-inline ancestor (`targetState`). The descendant inline runs are
 * forced terminal first, then the root, so no inline descendant remains
 * `running` under a terminal inline ancestor.
 */
export type ActiveInlineForceTerminalPlan =
  | {
      readonly status: 'resolved';
      readonly kind: InlineForceTerminalKind;
      /** The currently active runbook (innermost inline child). */
      readonly activeState: RunbookState;
      /** The outermost contiguous-inline ancestor to force terminal. */
      readonly targetState: RunbookState;
      /** Inline descendants between active and root, active-first (excludes root). */
      readonly descendantStates: readonly RunbookState[];
      /** Full force order, descendant-to-root (active first, root last). */
      readonly forceOrder: readonly RunbookState[];
      /** Session run ids to release after the cascade, descendant-to-root. */
      readonly releaseRunIds: readonly RunId[];
    }
  | { readonly status: 'none'; readonly kind: InlineForceTerminalKind }
  | {
      readonly status: 'missing-inline-parent';
      readonly kind: InlineForceTerminalKind;
      readonly activeState: RunbookState;
      readonly missingParentRunId: RunId;
    }
  | {
      readonly status: 'inline-cycle';
      readonly kind: InlineForceTerminalKind;
      readonly activeState: RunbookState;
      readonly repeatedRunId: RunId;
    };

/** Result of releasing multiple runbooks in a single session mutation. */
export interface ReleaseRunbooksResult {
  readonly releasedRunIds: readonly RunId[];
  readonly nextDefaultRunbookId: RunId | null;
}

/** Machine-derived inputs committed with a delegated child's first claim. */
export interface ClaimAndInitialLinkInput {
  /** Child run receiving the delegated claim. */
  readonly childRunId: RunId;
  /** Exact delegation coordinates shared by parent, child, and claim. */
  readonly linkage: DelegationLinkage;
  /** Parent authority captured with the state used to derive `preparedParent`. */
  readonly capturedParent: CapturedAuthority;
  /** Opaque parent mutation produced by an XState delegation link transition. */
  readonly preparedParent: PreparedDelegationChildLink;
}

/** Machine-derived inputs committed when rolling back a delegated child's initial link. */
export interface RollbackInitialLinkInput extends Omit<ClaimAndInitialLinkInput, 'preparedParent'> {
  /** Opaque parent mutation produced by an XState delegation unlink transition. */
  readonly preparedParent: PreparedDelegationChildUnlink;
}

/** Atomic initial-claim/link outcome. */
export type ClaimAndInitialLinkResult = GuardedMutationResult<ClaimRunbookResult>;

/**
 * Validate that every component of an initial-link mutation names one parent.
 *
 * @param input - Atomic link or rollback input to validate.
 * @param operation - Operation named in an invariant-failure diagnostic.
 * @returns The machine-derived next parent state.
 * @throws {Error} When the operation is wrong or parent coordinates disagree.
 */
function assertInitialLinkParentCoordinates(
  input: ClaimAndInitialLinkInput | RollbackInitialLinkInput,
  operation: 'link' | 'rollback',
): RunbookState {
  const { linkage, capturedParent, preparedParent } = input;
  const { previousState, nextState } = preparedParent.mutation;
  if (preparedParent.operation !== (operation === 'link' ? 'link' : 'unlink')) {
    throw new Error(`Initial delegation ${operation} received the wrong mutation operation`);
  }
  if (
    capturedParent.runId !== linkage.parentRunId ||
    previousState.id !== linkage.parentRunId ||
    nextState.id !== linkage.parentRunId
  ) {
    throw new Error(`Initial delegation ${operation} names different parent runs`);
  }
  return nextState;
}

/**
 * Typed outcome of resolving an explicit `--run` id to a running member of the
 * session default stack.
 *
 * Single source of truth for the "resolve `--run` to a running stack member,
 * else refuse" decision shared by target resolution
 * (`resolveCommandTarget` / `resolveTransitionTarget`), run-targeted terminals,
 * and delegation-issuance anchoring — so every command refuses the identical
 * condition with the identical cause split.
 */
export type RunningStackMemberResolution =
  | {
      /** The named run is a running member of the session default stack. */
      readonly kind: 'running';
      /** Resolved running state of the named run. */
      readonly state: RunbookState;
    }
  | {
      /** The named id is not on the session default stack (or its persisted run is missing). */
      readonly kind: 'not_on_stack';
    }
  | {
      /** The named run is on the stack but not running (terminal or unset lifecycle). */
      readonly kind: 'not_running';
      /** The run's non-running lifecycle, when persisted. */
      readonly lifecycle: RunbookState['lifecycle'];
    };

/**
 * Outcome of a best-effort claim last-seen recording.
 *
 * Returned rather than thrown: recording follows bearer verification and grant
 * authorization but is independent of the subsequent mutation outcome. A
 * failure here must be observable to tests but must never propagate, block the
 * protected mutation, or mask its result (RD-102) (#519).
 */
export type ClaimSeenRecordResult =
  | {
      /** The presented claim holder's sighting was persisted to `lastSeenAt`. */
      readonly kind: 'recorded';
      /** Claim key whose record was updated. */
      readonly claimKey: ClaimLookupKey;
      /** ISO timestamp written to `lastSeenAt`. */
      readonly lastSeenAt: string;
    }
  | {
      /** No claim matched the presented bearer (missing key or unverified secret). */
      readonly kind: 'no-claim';
    }
  | {
      /** Recording was attempted and failed. Swallowed — never propagated. */
      readonly kind: 'record-failed';
      /** The swallowed cause, surfaced for diagnostics and tests only. */
      readonly error: unknown;
    };

/**
 * Result of restoring a stashed delegated child by claim id.
 *
 * `claim` is a {@link VerifiedClaim}, not the persisted {@link ClaimRecord}:
 * every arm that carries one is returned only after the presented bearer was
 * proved against `secretHash` in the same transaction, and the narrower type is
 * what makes it structurally impossible for a caller to re-emit that hash (or
 * the record's bookkeeping timestamps) into CLI output. Same reason
 * {@link SessionService.verifyClaimId} returns one.
 */
export type UnstashForClaimIdResult =
  | { readonly status: 'restored'; readonly claim: VerifiedClaim; readonly state: RunbookState }
  | { readonly status: 'missing-claim'; readonly claimId: ClaimId }
  | { readonly status: 'missing-child'; readonly childRunId: RunId }
  | { readonly status: 'not-stashed'; readonly claim: VerifiedClaim }
  | {
      readonly status: 'terminal-child';
      readonly claim: VerifiedClaim;
      readonly lifecycle: 'completed' | 'stopped';
    }
  | { readonly status: 'child-linkage-mismatch'; readonly claim: VerifiedClaim }
  | { readonly status: 'parent-missing'; readonly claim: VerifiedClaim }
  | {
      /**
       * The claim is no longer authority: either a tombstone the parent-side
       * latch wrote, or an active row whose delegation has closed in the
       * committed parent state. Replaces the former `parent-ended` outcome — a
       * parent that ended closed the delegation, which is one of several ways a
       * claim gets superseded, and `reason` names which.
       */
      readonly status: 'superseded';
      readonly claimId: ClaimId;
      readonly reason: ClaimSupersededReason;
    };

/**
 * Result of stashing a claimed runbook by explicit claim id.
 *
 * Mirrors {@link UnstashForClaimIdResult}, with two stash-specific refusals in
 * place of `not-stashed`: `already-stashed` (the slot already holds this
 * claim's own run) and `slot-occupied` (it holds a different run). `claim` is a
 * {@link VerifiedClaim} for the same reason it is there, and the two must stay
 * in step — a sibling that still handed back the raw record would be the leak
 * the narrowing exists to prevent.
 */
export type StashForClaimIdResult =
  | { readonly status: 'stashed'; readonly claim: VerifiedClaim; readonly state: RunbookState }
  | { readonly status: 'missing-claim'; readonly claimId: ClaimId }
  | { readonly status: 'already-stashed'; readonly claim: VerifiedClaim }
  | {
      readonly status: 'slot-occupied';
      readonly claim: VerifiedClaim;
      readonly stashedRunbookId: RunId;
    }
  | { readonly status: 'missing-child'; readonly childRunId: RunId }
  | {
      readonly status: 'terminal-child';
      readonly claim: VerifiedClaim;
      readonly lifecycle: 'completed' | 'stopped';
    }
  | { readonly status: 'child-linkage-mismatch'; readonly claim: VerifiedClaim }
  | { readonly status: 'parent-missing'; readonly claim: VerifiedClaim }
  | {
      readonly status: 'superseded';
      readonly claimId: ClaimId;
      readonly reason: ClaimSupersededReason;
    };

/**
 * Result of stashing whatever runbook is currently active.
 *
 * The bare (unclaimed) counterpart of {@link StashForClaimIdResult}, and
 * discriminated for the same reason: collapsing every outcome into
 * `RunId | null` forced the caller to read the session *before* the mutation to
 * tell "nothing is active" (a warning) from "the slot is taken" (an error) —
 * the check-then-act window #666 closed on the claim path.
 *
 * The arms are returned in the order the caller's questions were previously
 * asked (active first, slot second), so the outcome for a given session is
 * unchanged by the move into one transaction.
 */
export type StashActiveResult =
  | {
      /** The active run moved into the stash slot. */
      readonly status: 'stashed';
      /** State of the run that was stashed, read under the same transaction. */
      readonly state: RunbookState;
    }
  | {
      /**
       * Nothing is active: the session stack is empty.
       *
       * Reproduces every `null` {@link SessionService.getActive} returns, which
       * is what the two-step caller branched on. There is deliberately no
       * separate "stack top with no readable state" arm: `session_stack.run_id`
       * is a `ON DELETE CASCADE` foreign key onto `runs`, enforced by both
       * drivers, so a stack top whose run row is gone is not a state the
       * database can hold. Deleting the run takes the stack entry with it, and
       * the arm would be unreachable — and untestable — rather than defensive.
       */
      readonly status: 'no-active-runbook';
    }
  | {
      /** The single stash slot already holds a run; the caller must pop first. */
      readonly status: 'slot-occupied';
      /** Run currently occupying the slot. */
      readonly stashedRunbookId: RunId;
    };

/**
 * Command-facing spelling of a session ownership refusal.
 *
 * An alias, not a translation: the storage refusal arms already discriminate on
 * `kind` with the wire-facing spellings, so a command outcome union admits them
 * directly. Naming the alias keeps the seam legible where command outcomes carry
 * it (`LifecycleTerminalOutcome` and its siblings) without inviting a second
 * declaration of the same two arms that could drift from it.
 */
export type SessionMutationRefusalOutcome = SessionMutationRefusal;

/**
 * True when persisted child linkage matches an incoming delegation linkage on
 * every stored authority coordinate.
 *
 * Used by {@link SessionService.claimRunbook} to refuse a claim when the child's
 * persisted linkage disagrees with the freshly token-validated linkage the caller
 * is presenting — a fail-closed signal for state corruption.
 *
 * WHY ALL SIX, same reason as {@link linkageMatchesClaim}, one step earlier in
 * the lifecycle: the `incoming` linkage is copied wholesale into the claim's
 * `delegation` descriptor and its report grant a few lines into
 * `claimRunbookInTransaction`, so whatever this predicate lets past becomes
 * persisted authority. `grantAllows` later evaluates that grant against the
 * CHILD ROW's `parentLinkage` — the `persisted` argument here — and compares all
 * seven. Any coordinate skipped here is one the two can differ on for the life
 * of the claim, and the divergence surfaces only as a dropped terminal report
 * (#738). The child's `parentLinkage` is write-once at `manager.create`; the
 * caller's linkage is not, which is why this comparison is the one that has to
 * be total.
 *
 * @param persisted - Parent linkage stored on the child runbook state
 * @param incoming - Freshly built delegation linkage offered by the caller
 * @returns `true` only when both are delegation-shaped and every shared field agrees
 */
function linkageMatchesLinkage(
  persisted: RunbookState['parentLinkage'],
  incoming: DelegationLinkage,
): boolean {
  return (
    persisted?.kind === 'delegation' && delegationAuthorityCoordinatesMatch(persisted, incoming)
  );
}

/**
 * The affected-run selector for a mutation that acts on whatever is on top.
 *
 * `popRunbook` and `stash` name their target only by position, so the run whose
 * ownership must be checked is not knowable until the guarded transaction has
 * read the session. An empty stack selects nothing: those mutations then return
 * their domain `null` without a refusal to make.
 *
 * @param session - Session snapshot read at the start of the guarded transaction.
 * @returns The top-of-stack run id, or an empty list when the stack is empty.
 */
function topOfStack(session: SessionData): readonly RunId[] {
  const topId = session.defaultStack[session.defaultStack.length - 1];
  return topId ? [topId] : [];
}

function claimRecordToDelegationLinkage(claim: ClaimRecord): DelegationLinkage {
  if (!claim.delegation) {
    throw new Error(`Claim ${claim.claimKey} has no delegation linkage`);
  }
  return {
    kind: 'delegation',
    parentRunId: claim.delegation.parentRunId,
    parentStepId: claim.delegation.parentStepId,
    tokenHash: claim.delegation.tokenHash,
    parentStep: claim.delegation.parentStep,
    parentFrameKey: claim.delegation.parentFrameKey,
    parentEntry: claim.delegation.parentEntry,
  };
}

function verifiedClaimFromRecord(record: ClaimRecord): VerifiedClaim {
  return {
    claimKey: record.claimKey,
    controlledRunId: record.controlledRunId,
    ...(record.delegation ? { delegation: record.delegation } : {}),
    grants: record.grants,
  };
}

/**
 * Manages runbook session stacks and stash operations.
 *
 * Provides a single active runbook stack and a single
 * stash slot for temporarily parking a runbook. Follows the same
 * constructor-injection pattern as {@link RunbookActorService}.
 */
export class SessionService {
  private readonly now: () => string;

  /**
   * Create a new SessionService.
   *
   * `now` is the clock seam for every timestamp this service writes. It returns an
   * ISO string rather than a `Date` because all four write sites want one, and it
   * follows the established convention for injected clocks in this package
   * (`RunbookActorServiceOptions.inlineLaunchNow`, defaulted at `compiler.ts:3695`).
   * Optional and defaulted, so the 40-odd construction sites — including 16 in the
   * CLI, which take the real clock — are unaffected.
   *
   * @param manager - State manager for raw session and state persistence
   * @param now - Optional clock returning an ISO instant (defaults to the wall clock)
   */
  constructor(
    private readonly manager: RunbookStateManager,
    now?: () => string,
  ) {
    this.now = now ?? (() => new Date().toISOString());
  }

  /**
   * Run a session read-modify-write inside one store transaction.
   *
   * Replaces the workspace session file lock: atomicity now comes from the
   * transaction, so an interleaved writer cannot lose an update. Because a
   * transaction must never be held across an `await`, `work` is synchronous and
   * reads run state through `ctx.readState` rather than awaiting the manager.
   *
   * Read-only methods deliberately stay outside this helper — the worst case
   * there is a slightly stale snapshot.
   *
   * @template T - Value the mutation returns.
   * @param work - Mutates `ctx.session` in place and returns the caller's result.
   * @returns The value returned by `work`, once committed.
   */
  private mutate<T>(work: (ctx: SessionMutationTxn) => SyncWork<T>): Promise<T> {
    return this.manager.mutateSession(work);
  }

  /**
   * {@link mutate} for a mutation that can touch a run under execution.
   *
   * Every session write that a `claims_guard_*` or `stash_guard_*` trigger can
   * abort goes through here, so the refusal reaches the caller as a typed arm
   * instead of an opaque `Error` or a domain `null`.
   *
   * @template T - Value the mutation returns.
   * @param runIds - Affected runs in deterministic refusal order, or a selector
   *   reading them off the session snapshot inside the transaction (used where
   *   the affected run is only identifiable from the session itself).
   * @param work - Mutates `ctx.session` in place and returns the caller's result.
   * @returns The committed value, or the first ownership refusal.
   */
  private mutateGuarded<T>(
    runIds: readonly RunId[] | ((session: SessionData) => readonly RunId[]),
    work: (ctx: SessionMutationTxn) => SyncWork<T>,
  ): Promise<SessionMutationResult<T>> {
    return this.manager.mutateSessionGuarded(runIds, work);
  }

  /**
   * Describe why a superseded claim stopped being authority.
   *
   * The single decision for every path that reports a supersession — the async
   * `getActiveForClaimId` read (on both its tombstone and its active-row arms)
   * and the in-transaction `unstashForClaimId` — which differ only in how they
   * read the parent. Two copies of this mapping would be two places for the
   * taxonomy to drift. Callers narrow to `closed` first where they must
   * distinguish an active row's own refusals; this only maps the reason.
   *
   * A non-delegated claim has no parent to classify against, and a tombstone
   * whose delegation still reads live was retired on the claim side (released,
   * rotated, pruned): both are `claim-rotated`, not a parent-side reason that
   * did not happen.
   *
   * @param record - The tombstoned claim record.
   * @param parent - Parent state for `record.delegation`, read by the caller in
   *   its own transaction; ignored for a non-delegated claim.
   * @returns The supersession reason, plus the parent coordinates when delegated.
   */
  private describeSupersession(
    record: ClaimRecord,
    parent: RunbookState | null,
  ): { readonly reason: ClaimSupersededReason; readonly delegation?: SupersededDelegationOrigin } {
    const { delegation } = record;
    if (delegation === undefined) {
      return { reason: 'claim-rotated' };
    }
    const liveness = classifyDelegationLiveness(parent, delegation);
    const origin = {
      parentRunId: delegation.parentRunId,
      parentStepId: delegation.parentStepId,
    };
    switch (liveness.kind) {
      case 'closed':
        return { reason: liveness.reason, delegation: origin };
      case 'parent-unreadable':
        return { reason: 'parent-unreadable', delegation: origin };
      case 'live':
        return { reason: 'claim-rotated', delegation: origin };
      default: {
        const _exhaustive: never = liveness;
        return _exhaustive;
      }
    }
  }

  /**
   * The superseded refusal for a *stashed* claim, when supersession is the more
   * useful of the two true refusals — otherwise null.
   *
   * Null for a non-delegated claim (nothing to classify), for a live delegation
   * (the claim really is just parked, and `rundown pop` will resume it), and for
   * a terminal child (whose delegation reads `resolved` but which must keep
   * reporting as terminal evidence rather than as a closed delegation).
   *
   * @param record - The active claim record whose child is the stashed run.
   * @param claimId - The presented bearer, echoed on the refusal.
   * @returns The superseded resolution, or null to fall through to `stashed`.
   */
  private async supersededStashedClaim(
    record: ClaimRecord,
    claimId: ClaimId,
  ): Promise<ClaimIdResolution | null> {
    const { delegation } = record;
    if (delegation === undefined) {
      return null;
    }
    const parent = await this.manager.load(delegation.parentRunId);
    if (classifyDelegationLiveness(parent, delegation).kind !== 'closed') {
      return null;
    }
    const child = await this.manager.load(record.controlledRunId);
    if (child?.lifecycle === 'completed' || child?.lifecycle === 'stopped') {
      return null;
    }
    return { status: 'superseded', claimId, ...this.describeSupersession(record, parent) };
  }

  /**
   * Resolve a bearer whose key is not among the session's active claims.
   *
   * Splits "superseded" from "never existed". The parent-side latch tombstones a
   * claim whose delegation closed, and `loadSession` surfaces only active claims,
   * so without the by-key read every superseded bearer reports as `missing` —
   * "Claim id … does not exist", which reads as a mistyped id and invites the
   * retry the no-retry signal exists to prevent.
   *
   * @param parsed - Parsed bearer (lookup key + secret).
   * @param claimId - The presented bearer, echoed on the refusal.
   * @returns A `superseded`, `invalid-secret`, or `missing` resolution.
   */
  private async resolveInactiveClaim(
    parsed: ReturnType<typeof parseClaimBearer>,
    claimId: ClaimId,
  ): Promise<ClaimIdResolution> {
    const presented = await this.manager.loadClaim(parsed.claimKey);
    if (presented === null) {
      return { status: 'missing', claimId };
    }
    // Secret first: a caller who cannot prove the bearer learns no more about a
    // tombstone than about an active claim (`invalid-secret` already reveals that
    // the key exists), so naming the supersession widens no oracle.
    if (!verifyClaimSecret(parsed.secret, presented.record.secretHash)) {
      return { status: 'invalid-secret', claimId };
    }
    if (presented.status === 'active') {
      // The row is active but was absent from the snapshot this resolution read —
      // a concurrent insert landing between the two reads. Report it as the
      // snapshot saw it; the next resolution reads the row.
      return { status: 'missing', claimId };
    }
    const parentRunId = presented.record.delegation?.parentRunId;
    const parent = parentRunId === undefined ? null : await this.manager.load(parentRunId);
    return {
      status: 'superseded',
      claimId,
      ...this.describeSupersession(presented.record, parent),
    };
  }

  private findClaimByChildRunId(
    claims: Record<string, ClaimRecord>,
    childRunId: RunId,
  ): ClaimRecord | undefined {
    return Object.values(claims).find((claim) => claim.controlledRunId === childRunId);
  }

  /**
   * Find the claim record a delegation linkage identifies, by delegation
   * IDENTITY rather than by authority validation.
   *
   * THREE FIELDS ON PURPOSE, against the six {@link linkageMatchesLinkage}
   * compares. `tokenHash` is the sha256 of an HMAC over the full issuance
   * coordinates plus a per-issuance `issuanceNonce` of 32 fresh random bytes
   * (`deriveDelegationToken`), so it alone identifies one issuance and the two
   * remaining conjuncts are redundant belt-and-braces. The width difference is
   * therefore not laxity: this answers "which record is this delegation?", while
   * `linkageMatchesLinkage` answers "may this linkage exercise that record's
   * authority?" — and the latter still has work to do, because `parentStep` is
   * not among the derivation's inputs and because it compares two caller-
   * authored structs, neither of them token-derived.
   *
   * Widening this to six would be strictly worse. A drifted record would be
   * missed here and re-found by the child-run arms below, which return the same
   * `linkage-mismatch` — nothing gained — while the narrow key reaches the
   * terminal-child check first, so a drifted record whose child is terminal
   * keeps the more precise refusal. And a drifted record whose CHILD differs
   * from the run being claimed would not be re-found at all: the incoming claim
   * would pass every fresh-child gate and mint a SECOND active claim against the
   * same token hash.
   *
   * @param claims - Active claim records from the session read in this transaction.
   * @param linkage - Delegation linkage naming the issuance to locate.
   * @returns The claim record for that delegation, or `undefined` when unclaimed.
   */
  private findClaimByDelegationLinkage(
    claims: Record<string, ClaimRecord>,
    linkage: DelegationLinkage,
  ): ClaimRecord | undefined {
    return Object.values(claims).find(
      (claim) =>
        claim.delegation?.parentRunId === linkage.parentRunId &&
        claim.delegation.parentStepId === linkage.parentStepId &&
        claim.delegation.tokenHash === linkage.tokenHash,
    );
  }

  /**
   * Issue a bearer claim with run-control grants for a local started run.
   *
   * @param runId - Run id controlled by the issued claim.
   * @returns Public bearer claim id and the persisted proof-backed record.
   *   Refused `execution_in_progress` or `recovery_required` instead when the
   *   run is execution-owned or awaiting recovery; the value is absent then.
   */
  async issueRunControlClaim(
    runId: RunId,
  ): Promise<SessionMutationResult<PreparedRunControlClaim>> {
    return this.mutateGuarded([runId], (ctx) => this.mintRunControlClaim(ctx.session, runId));
  }

  /**
   * Adopt run-control authority for a run this process must drive but whose
   * controlling bearer it does not hold.
   *
   * A run's bearer lives in the launching process's memory only, so a run
   * created by a process that died is orphaned: the persisted claim record
   * remains, but nothing can reproduce the secret it verifies. A resumed inline
   * child is exactly that run, and without a bearer its machine cannot issue
   * delegation credentials — the asymmetry where a freshly launched child
   * proceeds through an authored DELEGATE step and a resumed one stops.
   *
   * Adoption is refused, never forced, when the run already carries a
   * delegation issued under the claim being replaced. The credentials addendum
   * makes that a stop condition ("minting a second run-control claim after
   * initialization used the first"): the replacement claim could not reproduce
   * those credentials, and `createDelegationTokenDeriver` would — correctly —
   * refuse every echo of them, converting fail-closed into stuck-closed. A run
   * that has issued nothing has had its first claim installed but never used,
   * so replacing it orphans no credential.
   *
   * @param state - Captured state of the run whose control is being adopted.
   * @returns The adopted runtime, a refusal naming the issued credential that
   *   blocks adoption, or the session refusal that prevented the mint.
   */
  async adoptRunControlClaim(state: RunbookState): Promise<RunControlAdoption> {
    // The predicate reads the run through `ctx.readState`, not through the
    // caller's `state`. Evaluating it against a snapshot captured before the
    // transaction opened would be a check-then-act: a credential minted in
    // between is one the replacement claim cannot reproduce, so the rotation
    // would orphan it — the stop condition this refusal exists to enforce.
    // `state` supplies the run id only.
    const result = await this.mutateGuarded([state.id], (ctx) => {
      const current = ctx.readState(state.id);
      if (current?.substepStates?.some((substep) => substep.delegation !== undefined)) {
        return { kind: 'refused_credential_issued' as const };
      }
      return { kind: 'minted' as const, claim: this.mintRunControlClaim(ctx.session, state.id) };
    });
    if (result.kind !== 'committed') return { kind: 'refused_session', refusal: result };
    return result.value.kind === 'refused_credential_issued'
      ? { kind: 'refused_credential_issued', runId: state.id }
      : { kind: 'adopted', runtime: result.value.claim };
  }

  /**
   * Push a runbook onto the active stack and mint its run-control bearer claim
   * as a single atomic session mutation.
   *
   * `rundown run` starts a run and hands the orchestrator a run-control bearer.
   * Doing the push and the mint in one transaction rather than two keeps run-start
   * atomic: there is never a persisted window where the run is on the stack but
   * has no controlling claim.
   *
   * @param id - The runbook state ID to push and control.
   * @returns Public bearer claim id and the persisted proof-backed record.
   *   Refused `execution_in_progress` or `recovery_required` instead when the
   *   run is execution-owned or awaiting recovery; the value is absent then.
   */
  async pushRunbookWithRunControlClaim(
    id: RunId,
  ): Promise<SessionMutationResult<{ readonly claimId: ClaimId; readonly claim: ClaimRecord }>> {
    return this.mutateGuarded([id], (ctx) => {
      ctx.session.defaultStack.push(id);
      return this.mintRunControlClaim(ctx.session, id);
    });
  }

  /**
   * Prepare a run-control bearer without writing session state.
   *
   * This seam lets run initialization bind credential derivation to the exact
   * bearer that will later be installed by
   * {@link pushRunbookWithPreparedRunControlClaim}.
   *
   * @param runId - Run id controlled by the prepared claim.
   * @returns The caller-held bearer and its non-secret persisted record.
   */
  prepareRunControlClaim(runId: RunId): PreparedRunControlClaim {
    const parsed = parseClaimBearer(generateClaimBearer());
    const authority = {
      kind: 'bearer' as const,
      claimId: parsed.claimId,
      claimKey: parsed.claimKey,
    };
    return {
      claimId: parsed.claimId,
      claim: createClaimRecord({
        claimKey: parsed.claimKey,
        secretHash: hashClaimSecret(parsed.secret),
        controlledRunId: runId,
        grants: createRunControlGrants(runId),
        now: this.now(),
      }),
      delegationRuntime: delegationRuntimeCapabilities(authority),
    };
  }

  /**
   * Push a run and install an already prepared run-control claim atomically.
   *
   * @param id - Runbook state ID to push and control.
   * @param prepared - Exact in-memory claim prepared before initialization.
   * @returns The installed claim after the guarded session transaction commits.
   * @throws {Error} When the prepared claim controls a different run.
   */
  async pushRunbookWithPreparedRunControlClaim(
    id: RunId,
    prepared: PreparedRunControlClaim,
  ): Promise<SessionMutationResult<{ readonly claimId: ClaimId; readonly claim: ClaimRecord }>> {
    const parsed = parseClaimBearer(prepared.claimId);
    if (
      prepared.claim.controlledRunId !== id ||
      prepared.claim.claimKey !== parsed.claimKey ||
      prepared.claim.secretHash !== hashClaimSecret(parsed.secret)
    ) {
      throw new Error(`Prepared run-control claim does not match ${id}`);
    }
    return this.mutateGuarded([id], (ctx) => {
      ctx.session.defaultStack.push(id);
      this.installRunControlClaim(ctx.session, prepared.claim);
      return { claimId: prepared.claimId, claim: prepared.claim };
    });
  }

  /**
   * Mint a run-control bearer claim into an in-memory session (no IO, no lock).
   *
   * Shared by {@link issueRunControlClaim} and
   * {@link pushRunbookWithRunControlClaim}; both persist the mutated session
   * under the caller's held lock.
   *
   * @param session - Session to mutate in place; the new claim is added and any
   *   prior claim for `runId` is superseded.
   * @param runId - Run id the minted claim controls.
   * @returns Public bearer claim id and the persisted-shape record.
   */
  private mintRunControlClaim(session: SessionData, runId: RunId): PreparedRunControlClaim {
    const prepared = this.prepareRunControlClaim(runId);
    this.installRunControlClaim(session, prepared.claim);
    return prepared;
  }

  /**
   * Install one prepared run-control claim into an in-memory session.
   *
   * @param session - Session to mutate in place.
   * @param claim - Prepared run-control claim to install.
   */
  private installRunControlClaim(session: SessionData, claim: ClaimRecord): void {
    // Uphold the SessionDataSchema controlledRunId-uniqueness invariant: a run has
    // at most one run-control claim. Re-issuing supersedes (rotates) any existing
    // claim for this run rather than appending a duplicate that would render the
    // session unreadable. The prior bearer is invalidated by construction.
    for (const [existingKey, existingClaim] of Object.entries(session.claims)) {
      if (existingClaim.controlledRunId === claim.controlledRunId) {
        delete session.claims[existingKey];
      }
    }
    session.claims[claim.claimKey] = claim;
  }

  /**
   * Verify a bearer claim id against persisted session proof data.
   *
   * @param claimId - Bearer claim id presented by the caller.
   * @returns Verification result with a non-secret verified claim on success.
   */
  async verifyClaimId(claimId: ClaimId): Promise<ClaimVerificationResult> {
    const parsed = parseClaimBearer(claimId);
    const session = await this.manager.loadSession();
    if (!Object.hasOwn(session.claims, parsed.claimKey)) {
      return { status: 'missing', claimKey: parsed.claimKey };
    }
    const record = session.claims[parsed.claimKey];
    if (!verifyClaimSecret(parsed.secret, record.secretHash)) {
      return { status: 'invalid-secret', claimKey: parsed.claimKey };
    }
    return { status: 'verified', claim: verifiedClaimFromRecord(record) };
  }

  /**
   * Record that a claim holder was seen alive by presenting its bearer as authority.
   *
   * Refreshes EXACTLY the claim whose bearer the caller presented, never another:
   * the observation belongs to a single claim and its holder, and a parent cannot
   * vouch for a child's liveness (#519). When caller-versus-target attribution is
   * uncertain, the system under-reports rather than let one actor refresh another
   * actor's claim. The implementation follows the `unstashForClaimId` template —
   * one transaction: verify bearer -> refresh -> commit.
   *
   * Call this only after the presented bearer has passed verification and its
   * relevant grant has authorized the operation. That authorization proves holder
   * liveness; the subsequent mutation need not commit, advance, or succeed.
   * Deliberately NOT wired into {@link SessionService.verifyClaimId}: `status`,
   * `stash`, and `pop` verify a claim as a target selector but cannot prove its
   * holder was the presenter. Recording there would erase caller-versus-target
   * attribution and let a parent refresh a child's claim, so those paths
   * deliberately under-report instead.
   *
   * CALL ONLY OUTSIDE AN OPEN SESSION TRANSACTION. This method opens its own
   * write transaction; nesting it inside another one would deadlock the single
   * writer, and the totality contract below would silently convert that into
   * `record-failed` — totality MASKING a deadlock rather than exposing it.
   *
   * Best-effort and TOTAL: this method never throws. It commits separately from
   * the run mutation it accompanies, so the two are not atomic with each other.
   * Failing to record leaves an older observation, costing one spurious idle
   * report and one wasted check; it must neither prevent a subsequent mutation nor
   * mask that mutation's outcome. Failing a user's `rundown pass` because a
   * bookkeeping write hiccuped would be indefensible (RD-102).
   *
   * RECORDS THE CLOCK VERBATIM, AND DELIBERATELY DOES NOT CLAMP TO
   * `max(existing, now)` — a backward wall-clock step overwrites `lastSeenAt`
   * with an older value BY DESIGN. Reviewers reliably read that as a bug, so the
   * reasoning is recorded here (#611):
   * - Reader and writer SHARE A CLOCK. The parent's `rundown status` and the
   *   holder's authorized command are processes on the same host — the lock design
   *   requires it (stale reclamation is `kill(pid, 0)`, meaningless across hosts)
   *   and the SQLite authority is local. A backward step moves both, so the older
   *   timestamp is the CORRECT answer and no premature idle occurs.
   * - The clamp would introduce the AC6 fail-open it appears to prevent. Pinning
   *   `lastSeenAt` in the future meets `claimActivity`'s `Math.max(0, …)` skew
   *   clamp (claim-activity.ts:161) and yields `idleFor: 0` for the whole excursion:
   *   a DEAD claim reading as live, in exactly the case the signal exists to catch.
   *   Corrupt persisted state is rejected, never interpreted (claim-activity.ts:129-131) —
   *   and a max-clamp interprets.
   * - The failure modes are asymmetric in DURATION. Un-clamped, a false idle needs a
   *   back-and-forth excursion and self-heals on the holder's next authorized
   *   presentation. Clamped,
   *   the false not-idle lasts the whole jump and CANNOT self-heal, because it
   *   persists precisely while nothing is happening.
   *
   * The counter-argument, so it is weighed rather than lost: {@link DEFAULT_IDLE_AFTER_MS}
   * argues reporting idle EARLY is the worse error, which favours the clamp. That is
   * threshold-tuning reasoning for the routine no-jump case, where "late" means a
   * bounded delay — it does not sanction an unbounded dead-claim-reads-live window.
   *
   * Pinned by `claim-seen.test.ts` › "recordClaimSeen under backward
   * wall-clock movement (#611 review)" — in particular "reports a DEAD claim idle
   * after a sustained backward jump", which fails if the clamp is ever added.
   *
   * @param claimId - Bearer claim id presented by the authorized caller.
   * @returns Typed recording outcome. Never rejects.
   */
  async recordClaimSeen(claimId: ClaimId): Promise<ClaimSeenRecordResult> {
    try {
      return await this.mutate((ctx): ClaimSeenRecordResult => {
        const parsed = parseClaimBearer(claimId);
        const { session } = ctx;
        if (!Object.hasOwn(session.claims, parsed.claimKey)) {
          return { kind: 'no-claim' };
        }
        const claim = session.claims[parsed.claimKey];
        if (!verifyClaimSecret(parsed.secret, claim.secretHash)) {
          return { kind: 'no-claim' };
        }
        const now = this.now();
        // Written at the claim-activity seam, not left to the wholesale session
        // reconciler: `applySession` deliberately leaves an already-persisted
        // claim's columns untouched, so a bulk save can never churn
        // `claim_generation` or clobber `last_seen_at`. An in-place edit to the
        // snapshot alone would therefore be silently discarded. Both are kept —
        // the store op persists the refresh, and the snapshot edit keeps any
        // later read within this same transaction coherent.
        ctx.recordClaimSeen(parsed.claimKey, now);
        session.claims[parsed.claimKey] = seenClaimRecord(claim, now);
        return { kind: 'recorded', claimKey: parsed.claimKey, lastSeenAt: now };
      });
    } catch (error: unknown) {
      // Intentionally swallowed — see the best-effort note above. Nothing here may
      // reach the caller, block the protected mutation, or mask its outcome.
      return { kind: 'record-failed', error };
    }
  }

  /**
   * Get the currently active runbook.
   *
   * Returns the top runbook from the stack.
   *
   * @returns The active runbook state, or null if no runbook is active
   */
  async getActive(): Promise<RunbookState | null> {
    const session = await this.manager.loadSession();
    const stack = session.defaultStack;
    const topId = stack[stack.length - 1];
    return topId ? await this.manager.load(topId) : null;
  }

  /**
   * Resolve an explicit `--run` target to its live session-stack run state.
   *
   * Read-only: no transaction (consistent with {@link getActive}).
   * Resolves only ids present on the session `defaultStack` (any depth) —
   * `--run` is target selection only. Claimed children are never stack members,
   * so `--run` can never substitute for `--claim-id`.
   *
   * @param runId - Run id supplied by the caller via `--run`
   * @returns The run state, or `null` when the id is not an active stack member
   */
  async getRunById(runId: RunId): Promise<RunbookState | null> {
    const session = await this.manager.loadSession();
    if (!session.defaultStack.includes(runId)) return null;
    return this.manager.load(runId);
  }

  /**
   * Resolve an explicit `--run` id to a running session-stack member, splitting
   * the two refusal causes ("not on this session's stack" vs "on the stack but
   * not running") into a typed outcome.
   *
   * Read-only: no transaction (consistent with {@link getRunById},
   * which this composes). This is the single helper behind every command's
   * `--run` target resolution, so the refusal specificity cannot drift between
   * commands.
   *
   * @param runId - Run id supplied by the caller via `--run`
   * @returns `running` with the resolved state, `not_on_stack`, or
   *   `not_running` with the run's lifecycle
   */
  async resolveRunningStackMember(runId: RunId): Promise<RunningStackMemberResolution> {
    const state = await this.getRunById(runId);
    if (!state) return { kind: 'not_on_stack' };
    if (state.lifecycle !== 'running') return { kind: 'not_running', lifecycle: state.lifecycle };
    return { kind: 'running', state };
  }

  /**
   * Push a runbook onto the active runbook stack.
   *
   * Used when starting a new runbook or entering a nested/child runbook.
   * The pushed runbook becomes the active runbook.
   *
   * @param id - The runbook state ID to push
   */
  async pushRunbook(id: RunId): Promise<void> {
    await this.mutate((ctx) => {
      ctx.session.defaultStack.push(id);
    });
  }

  /**
   * Resolve an existing claim record for a delegation linkage, if one has
   * already been created.
   *
   * @param linkage - Delegation linkage to match by parent run, parent step, and token hash
   * @returns The matching claim record, or `null` when the delegation has not been claimed
   */
  async findClaimForDelegation(linkage: DelegationLinkage): Promise<ClaimRecord | null> {
    const session = await this.manager.loadSession();
    return this.findClaimByDelegationLinkage(session.claims, linkage) ?? null;
  }

  /**
   * Record that a delegation token has been claimed for a child runbook.
   *
   * Validates write-side invariants before recording the claim: the child run
   * must exist on disk, and its persisted `parentLinkage` must match the
   * incoming `linkage` on every stored authority coordinate. A mismatch indicates
   * state corruption (manual edits, stale persisted linkage from a prior
   * delegation, cross-host state merge) and is refused rather than silently
   * propagated into the claim record.
   *
   * @param childRunId - Child run id created or reused by claim
   * @param linkage - Delegation linkage to record in the claim. Caller must build
   *   this from freshly token-validated parent state.
   * @returns A claim record on success, or a failure variant when the child is
   *   missing, terminal, or its persisted linkage diverges from `linkage`.
   *   Refused `execution_in_progress` or `recovery_required` instead when the
   *   run is execution-owned or awaiting recovery; the value is absent then.
   */
  async claimRunbook(
    childRunId: RunId,
    linkage: DelegationLinkage,
  ): Promise<SessionMutationResult<ClaimRunbookResult>> {
    return this.mutateGuarded([childRunId], (ctx) =>
      this.claimRunbookInTransaction(ctx, childRunId, linkage),
    );
  }

  /**
   * Atomically persist a machine-derived parent link with the child's first claim.
   *
   * An idempotent `already-claimed` result may still commit the derived parent
   * link, repairing a missing link for the same child and exact delegation
   * coordinates. All other typed refusals leave both child and parent unchanged.
   *
   * @param input - Captured parent authority, derived parent state, child, and linkage.
   * @returns The committed claim result or a canonical guarded refusal.
   * @throws {Error} When the operation is wrong or parent coordinates disagree.
   */
  async claimAndInitialLink(input: ClaimAndInitialLinkInput): Promise<ClaimAndInitialLinkResult> {
    const { childRunId, linkage, capturedParent } = input;
    const nextState = assertInitialLinkParentCoordinates(input, 'link');

    const nested = await this.mutateGuarded(
      [childRunId, linkage.parentRunId],
      (ctx): ClaimAndInitialLinkResult => {
        const classification = classifyCommitRow(
          ctx.commitRow(capturedParent.runId, capturedParent.claimKey),
          capturedParent,
        );
        if (classification.kind !== 'ok') return classification;

        const claim = this.claimRunbookInTransaction(ctx, childRunId, linkage);
        if (claim.status === 'missing-child') {
          return {
            kind: 'missing',
            runId: claim.childRunId,
            message: `Run ${claim.childRunId} no longer exists.`,
          };
        }
        if (claim.status === 'already-claimed' && claim.childRunId !== childRunId) {
          return { kind: 'committed', value: claim };
        }
        if (claim.status !== 'claimed' && claim.status !== 'already-claimed') {
          return { kind: 'committed', value: claim };
        }

        assertExactlyOneRow(ctx.applyStateUpdate(capturedParent, nextState), capturedParent.runId);
        return { kind: 'committed', value: claim };
      },
    );
    return nested.kind === 'committed' ? nested.value : nested;
  }

  /**
   * Atomically remove the exact initial claim/link pair after launch setup fails.
   *
   * @param input - Recaptured parent authority and machine-derived unlink mutation.
   * @returns A committed rollback status or canonical guarded refusal.
   * @throws {Error} When the operation is wrong or parent coordinates disagree.
   */
  async rollbackInitialLink(
    input: RollbackInitialLinkInput,
  ): Promise<GuardedMutationResult<{ readonly status: 'rolled-back' | 'already-absent' }>> {
    const { childRunId, linkage, capturedParent } = input;
    const nextState = assertInitialLinkParentCoordinates(input, 'rollback');
    const nested = await this.mutateGuarded(
      [childRunId, linkage.parentRunId],
      (ctx): GuardedMutationResult<{ readonly status: 'rolled-back' | 'already-absent' }> => {
        const classification = classifyCommitRow(
          ctx.commitRow(capturedParent.runId, capturedParent.claimKey),
          capturedParent,
        );
        if (classification.kind !== 'ok') return classification;
        const claim = this.findClaimByDelegationLinkage(ctx.session.claims, linkage);
        if (claim === undefined) {
          assertExactlyOneRow(
            ctx.applyStateUpdate(capturedParent, nextState),
            capturedParent.runId,
          );
          return { kind: 'committed', value: { status: 'already-absent' } };
        }
        if (claim.controlledRunId !== childRunId) {
          return {
            kind: 'concurrent_modification',
            runId: linkage.parentRunId,
            message: `Run ${linkage.parentRunId} was modified concurrently.`,
          };
        }
        delete ctx.session.claims[claim.claimKey];
        assertExactlyOneRow(ctx.applyStateUpdate(capturedParent, nextState), capturedParent.runId);
        return { kind: 'committed', value: { status: 'rolled-back' } };
      },
    );
    return nested.kind === 'committed' ? nested.value : nested;
  }

  /**
   * Claim a run using an already-open session transaction; performs no IO itself.
   *
   * @param ctx - Open session mutation transaction.
   * @param childRunId - Child run receiving the claim.
   * @param linkage - Exact live parent delegation coordinates.
   * @returns The claim result recorded in the supplied transaction.
   */
  private claimRunbookInTransaction(
    ctx: SessionMutationTxn,
    childRunId: RunId,
    linkage: DelegationLinkage,
  ): ClaimRunbookResult {
    const { session } = ctx;
    const now = this.now();

    // Claim-side half of the durable latch (R2). Validate the exact delegation
    // is still live in the parent state read inside THIS transaction, before
    // any existing-claim refresh or fresh insertion. If the parent commit that
    // moved past this delegation already landed, refuse — the tombstoned bearer
    // cannot be resurrected by a later reset. An unreadable parent is refused
    // with a typed result, not thrown: it is the same FK-impossible corruption
    // class as `missing-child` below, and `getActiveForClaimId` already reports
    // it softly as `unlinked` / `parent-missing`. One class, one policy.
    const parent = ctx.readState(linkage.parentRunId);
    const liveness = classifyDelegationLiveness(parent, linkage);
    if (liveness.kind === 'parent-unreadable') {
      return {
        status: 'missing-parent',
        parentRunId: linkage.parentRunId,
        parentStepId: linkage.parentStepId,
      };
    }
    // Terminal evidence outlives the parent-side delegation. Checked before
    // classification, not after: every terminal child also reads closed on the
    // parent side (its substep is `done`), so the order is what decides. The
    // matching terminal-skip in `RunbookStore.invalidateClosedDelegatedClaims`
    // (`storage/runbook-store.ts`) is what keeps such a claim active for this
    // read, so the two orderings must stay tied together — checking liveness
    // first reports `delegation-superseded` for a claim whose real refusal is
    // the terminal child it can still name. Both are non-retryable; the loss is
    // diagnostic precision, not safety. `parent-unreadable` stays ahead of
    // this: it is a corruption signal about the state this read depends on.
    const existingForDelegation = this.findClaimByDelegationLinkage(session.claims, linkage);
    let existingLiveClaim:
      | { readonly claim: ClaimRecord; readonly state: RunbookState }
      | undefined;
    if (existingForDelegation !== undefined) {
      const existingState = ctx.readState(existingForDelegation.controlledRunId);
      if (!existingState) {
        // The claim's controlled run state cannot be read. The FK cascade
        // (`claims.controlled_run` ON DELETE CASCADE) deletes a claim with its
        // run, so this is not reachable through a supported delete — but the
        // caller-visible refusal taxonomy (superseded plan Task 6) returns a
        // typed `missing-child` rather than throwing, so a corrupted database
        // degrades gracefully.
        return { status: 'missing-child', childRunId: existingForDelegation.controlledRunId };
      }
      if (existingState.lifecycle === 'completed' || existingState.lifecycle === 'stopped') {
        return {
          status: 'terminal-child',
          childRunId: existingForDelegation.controlledRunId,
          lifecycle: existingState.lifecycle,
        };
      }
      existingLiveClaim = { claim: existingForDelegation, state: existingState };
    }

    if (liveness.kind === 'closed') {
      return {
        status: 'delegation-superseded',
        parentRunId: linkage.parentRunId,
        parentStepId: linkage.parentStepId,
        childRunId,
      };
    }

    if (existingLiveClaim !== undefined) {
      if (!linkageMatchesLinkage(existingLiveClaim.state.parentLinkage, linkage)) {
        return {
          status: 'linkage-mismatch',
          childRunId: existingLiveClaim.claim.controlledRunId,
          incoming: linkage,
          persisted: existingLiveClaim.state.parentLinkage,
        };
      }
      return {
        status: 'already-claimed',
        childRunId: existingLiveClaim.claim.controlledRunId,
        claim: existingLiveClaim.claim,
      };
    }

    const childState = ctx.readState(childRunId);
    if (!childState) {
      return { status: 'missing-child', childRunId };
    }
    if (childState.lifecycle === 'completed' || childState.lifecycle === 'stopped') {
      return { status: 'terminal-child', childRunId, lifecycle: childState.lifecycle };
    }
    if (!linkageMatchesLinkage(childState.parentLinkage, linkage)) {
      return {
        status: 'linkage-mismatch',
        childRunId,
        incoming: linkage,
        persisted: childState.parentLinkage,
      };
    }

    const existing = this.findClaimByChildRunId(session.claims, childRunId);
    if (existing !== undefined) {
      const existingLinkage = claimRecordToDelegationLinkage(existing);
      if (!linkageMatchesLinkage(existingLinkage, linkage)) {
        return {
          status: 'linkage-mismatch',
          childRunId,
          incoming: linkage,
          persisted: existingLinkage,
        };
      }
      return { status: 'already-claimed', childRunId, claim: existing };
    }

    const parsed = parseClaimBearer(generateClaimBearer());
    const delegation: DelegationClaimLinkage = {
      childRunId,
      tokenHash: linkage.tokenHash,
      parentRunId: linkage.parentRunId,
      parentStepId: linkage.parentStepId,
      parentStep: linkage.parentStep,
      parentFrameKey: linkage.parentFrameKey,
      parentEntry: linkage.parentEntry,
    };
    const claim = createClaimRecord({
      claimKey: parsed.claimKey,
      secretHash: hashClaimSecret(parsed.secret),
      controlledRunId: childRunId,
      delegation,
      grants: createDelegatedChildGrants({ linkage: delegation }),
      now,
    });
    session.claims[claim.claimKey] = claim;
    return { status: 'claimed', claimId: parsed.claimId, claim };
  }

  /**
   * Resolve an explicit claim id to an active child runbook.
   *
   * By default, claims whose child runbook is parked in
   * `session.stashedRunbookId` resolve as `unlinked` with `reason: 'stashed'`
   * so write commands (pass/fail/goto/complete/stop) refuse to operate on a
   * runbook the user explicitly parked — they must `rd pop --claim-id` first.
   * Read-only inspection paths (e.g. `rd status --claim-id`) opt into seeing
   * the stashed child by passing `{ includeStashed: true }`.
   *
   * @param claimId - Claim id returned by `rd claim`
   * @param options - Optional resolution flags
   * @param options.includeStashed - When true, do not gate on the stashed
   *   runbook; the claim resolves as `claimed` even if its child is parked.
   *   Defaults to false.
   * @returns Claim resolution result
   */
  async getActiveForClaimId(
    claimId: ClaimId,
    options: { readonly includeStashed?: boolean } = {},
  ): Promise<ClaimIdResolution> {
    const parsed = parseClaimBearer(claimId);
    const session = await this.manager.loadSession();
    if (!Object.hasOwn(session.claims, parsed.claimKey)) {
      return this.resolveInactiveClaim(parsed, claimId);
    }
    const record = session.claims[parsed.claimKey];
    if (!verifyClaimSecret(parsed.secret, record.secretHash)) {
      return { status: 'invalid-secret', claimId };
    }
    const claim = verifiedClaimFromRecord(record);

    if (options.includeStashed !== true && session.stashedRunbookId === record.controlledRunId) {
      // Supersession outranks the parked-runbook gate. "Run `rundown pop` to
      // resume" names a recovery that cannot succeed once authority has ended —
      // `pop` refuses the same claim — so the caller spends a command to reach a
      // refusal that contradicts the advice it followed. Between two
      // simultaneously true refusals, the one that ends the caller's work beats
      // the one that invites more of it.
      //
      // Deliberately not hoisted past the checks below: a terminal child still
      // reports `terminal` (the idempotent confirm-or-conflict contract, whose
      // delegation also reads closed), and unreadable or diverged child state
      // still reports its corruption signal with a `prune` remedy.
      return (
        (await this.supersededStashedClaim(record, claimId)) ?? {
          status: 'unlinked',
          claim,
          reason: 'stashed',
        }
      );
    }

    const state = await this.manager.load(record.controlledRunId);
    if (!state) {
      // The claim's controlled run state cannot be read. The FK cascade deletes a
      // claim with its run, so this is not reachable through a supported delete —
      // but the caller-visible refusal taxonomy (superseded plan Task 6) returns
      // a typed `stale` refusal rather than throwing, so a corrupted database
      // degrades gracefully.
      return { status: 'stale', claimId, reason: 'missing-state' };
    }
    if (state.lifecycle === 'completed' || state.lifecycle === 'stopped') {
      return { status: 'terminal', claim, state, lifecycle: state.lifecycle };
    }
    if (record.delegation && !linkageMatchesClaim(state.parentLinkage, record)) {
      return { status: 'unlinked', claim, reason: 'child-linkage-mismatch' };
    }

    if (record.delegation) {
      // Classify, rather than only checking the parent's lifecycle. The store
      // tombstone is an optimization; liveness against the committed parent is
      // the enforcement. The parent-side latch defers supersession while the
      // controlled child holds an execution lease, so a claim row can still read
      // `active` after its delegation closed — and if the parent never writes
      // again, it stays that way. A lifecycle-only check catches `parent-ended`
      // and misses `cursor-advanced`, letting the bearer report a result into a
      // delegation the parent has already left.
      const parent = await this.manager.load(record.delegation.parentRunId);
      const liveness = classifyDelegationLiveness(parent, record.delegation);
      if (liveness.kind === 'parent-unreadable') {
        return { status: 'unlinked', claim, reason: 'parent-missing' };
      }
      if (liveness.kind === 'closed') {
        return { status: 'superseded', claimId, ...this.describeSupersession(record, parent) };
      }
    }

    return { status: 'claimed', claimId, claim, record, state };
  }

  /**
   * List active claimed children that belong to a parent runbook.
   *
   * A claim is considered open only when the child state exists, is non-terminal,
   * still has delegation linkage matching the claim record, AND the parent's
   * corresponding delegated substep is not yet resolved. Terminal tombstones
   * retained for idempotent `rd pass/fail --claim-id` confirmation are
   * intentionally excluded, as are claims whose child state is missing on disk or
   * whose persisted linkage has diverged from the claim record.
   *
   * The parent-substep check closes the "advance wins the lock first" TOCTOU
   * ordering: if a concurrent bare parent advance resolved the delegated substep
   * before this claim landed, the claim is a stale record (the parent has moved
   * on) and must NOT count as open — otherwise it would wedge every future bare
   * parent transition until the orphaned child independently went terminal.
   *
   * Read-only: no transaction (consistent with getActiveForClaimId).
   *
   * The in-transaction half of this predicate is
   * `RunbookStore.openDelegatedChildrenFor`, which selects the same claims from
   * the `parent_run_id` column rather than the `delegation.parentRunId` filter
   * below. Its docblock owns the argument for why the two halves of the row
   * cannot name different parents; read it before changing either enumeration.
   *
   * @param parentRunId - Parent runbook whose open claimed children should be listed
   * @returns Claim records for non-terminal children still linked to this parent
   *   whose delegated substep remains unresolved
   */
  async listOpenClaimsForParent(parentRunId: RunId): Promise<ClaimRecord[]> {
    const session = await this.manager.loadSession();
    const parent = await this.manager.load(parentRunId);
    const parentSubstepStates = parent?.substepStates ?? [];
    const openClaims: ClaimRecord[] = [];

    for (const claim of Object.values(session.claims)) {
      if (claim.delegation?.parentRunId !== parentRunId) {
        continue;
      }

      const child = await this.manager.load(claim.controlledRunId);
      if (!child || child.lifecycle === 'completed' || child.lifecycle === 'stopped') {
        continue;
      }

      if (!linkageMatchesClaim(child.parentLinkage, claim)) {
        continue;
      }

      // Stale claim: the parent already resolved this delegated substep (advanced
      // past it) while the child is still non-terminal. Not an in-flight
      // delegation — exclude it so it cannot block bare parent transitions.
      const parentSubstep = findSubstepState(
        parentSubstepStates,
        claim.delegation.parentStepId,
        claim.delegation.parentFrameKey,
      );
      if (parentSubstep?.status === 'done') {
        continue;
      }

      openClaims.push(claim);
    }

    return openClaims;
  }

  /**
   * Run a parent-advancing transition write atomically with the
   * open-delegated-children check.
   *
   * The check IS atomic with the decisive write: the `advance` callback receives
   * a {@link ParentAdvanceGuard} it MUST pass into its store write, so the
   * open-delegated-children predicate is evaluated inside that write's
   * transaction, immediately before the run `UPDATE`. A claim committing in the
   * window between this method's cheap pre-check and the decisive write no longer
   * slips through: the guarded write finds the live child and aborts (rollback),
   * surfacing here as `open_delegated_children`. This restores the lock-era
   * invariant — claim-first ⇒ advance refuses, and the claimant's bearer is
   * preserved — without holding a transaction across the async advance compute.
   *
   * The leading `listOpenClaimsForParent` call is a cheap pre-check fast-path (a
   * clean early refusal and better UX); the in-transaction guard supplied to the
   * callback is the authoritative, race-closing refusal.
   *
   * The `advance` callback MUST pass the supplied guard into the DECISIVE
   * transition write (e.g. `RunbookCompletionService.recordManualCompletion` or
   * `RunbookActorService.sendAndSync`) and into no other write.
   *
   * A callback may legitimately span more than one store write: a drain applies
   * each queued completion in its own transaction. Only the first is decisive —
   * the write that advances the parent past the point where a live delegated
   * child matters. Re-arming the guard on a follow-on write would let an
   * unrelated child claiming mid-callback abort it, stranding the
   * already-committed decisive write behind a bare `open_delegated_children`
   * refusal that reports none of the transitions it committed.
   *
   * `RunbookCompletionService.drainResolvedCompletionsUnlocked` — the remaining
   * multi-write callback — enforces this by arming the guard on its first write
   * only. The lifecycle seam's fenced substep path no longer needs the rule: it
   * prepares every apply purely and commits them in ONE owned transaction, so
   * its callback performs exactly one guarded write by construction.
   *
   * Release steps run after the callback returns.
   *
   * @template T - Result type of the decisive advance write
   * @param parentRunId - Parent runbook whose advance must be guarded
   * @param advance - Decisive transition write. Receives the guard to thread into
   *   its store write; runs only when the pre-check finds no open claimed children.
   * @returns `{ kind: 'advanced', value }` carrying the callback result;
   *   `{ kind: 'delegation_collection_pending', parentRunId, outcomeCompletionKeys, message }`
   *   when a reported delegation outcome is still waiting for collection; or
   *   `{ kind: 'open_delegated_children', claims }` when the advance was refused
   *   by an open claimed child (pre-check or the in-transaction guard).
   */
  async runGuardedParentAdvance<T>(
    parentRunId: RunId,
    advance: (guard: ParentAdvanceGuard) => Promise<T>,
  ): Promise<
    | { readonly kind: 'advanced'; readonly value: T }
    | { readonly kind: 'open_delegated_children'; readonly claims: ClaimRecord[] }
    | {
        readonly kind: 'delegation_collection_pending';
        readonly parentRunId: RunId;
        readonly outcomeCompletionKeys: readonly string[];
        readonly message: typeof DELEGATION_COLLECTION_PENDING_MESSAGE;
      }
  > {
    const parentState = await this.manager.load(parentRunId);
    if (parentState) {
      const collectionPending = readDelegationCollectionPendingForPolicy(parentState);
      if (collectionPending.pending) {
        return {
          kind: 'delegation_collection_pending',
          parentRunId,
          outcomeCompletionKeys: collectionPending.outcomes.map((outcome) => outcome.completionKey),
          message: DELEGATION_COLLECTION_PENDING_MESSAGE,
        };
      }
    }
    // Cheap pre-check fast-path (defence-in-depth / UX). Authority is the
    // in-transaction guard threaded into the decisive write below.
    const openClaims = await this.listOpenClaimsForParent(parentRunId);
    if (openClaims.length > 0) {
      return { kind: 'open_delegated_children', claims: openClaims };
    }
    const guard = parentAdvanceGuard(parentRunId);
    try {
      return { kind: 'advanced', value: await advance(guard) };
    } catch (error: unknown) {
      if (isOpenDelegatedChildrenError(error)) {
        return { kind: 'open_delegated_children', claims: [...error.claims] };
      }
      throw error; // never mask a non-guard failure
    }
  }

  /**
   * Resolve the force-terminal plan for a bare `rd complete` / `rd stop`.
   *
   * Climbs `parentLinkage.kind === 'inline'` from the active runbook to find the
   * outermost contiguous-inline ancestor, stopping before any delegation
   * boundary. The returned `forceOrder` lists every runbook in the active inline
   * chain descendant-to-root (active first, root last) so the caller forces
   * inline descendants terminal before the root and no inline descendant remains
   * `running` under a terminal inline ancestor.
   *
   * Read-only: no transaction (consistent with {@link getActive}).
   *
   * Fail-closed: a missing inline parent or an inline parent cycle returns a
   * dedicated non-resolved status rather than guessing a target.
   *
   * @param kind - Force-terminal command kind driving the plan.
   * @param anchor - Optional chain start (from an explicit `--run` target);
   *   defaults to the active default-stack run when omitted.
   * @returns A discriminated plan describing the resolved chain or the reason
   *   resolution could not produce one.
   */
  async resolveActiveInlineForceTerminalPlan(
    kind: InlineForceTerminalKind,
    anchor?: RunbookState,
  ): Promise<ActiveInlineForceTerminalPlan> {
    const activeState = anchor ?? (await this.getActive());
    if (!activeState) return { status: 'none', kind };

    const chain: RunbookState[] = [activeState];
    const seen = new Set<RunId>([activeState.id]);
    let targetState = activeState;

    while (targetState.parentLinkage?.kind === 'inline') {
      const parentRunId = targetState.parentLinkage.parentRunId;
      if (seen.has(parentRunId)) {
        return { status: 'inline-cycle', kind, activeState, repeatedRunId: parentRunId };
      }

      const parentState = await this.manager.load(parentRunId);
      if (!parentState) {
        return {
          status: 'missing-inline-parent',
          kind,
          activeState,
          missingParentRunId: parentRunId,
        };
      }

      seen.add(parentRunId);
      chain.push(parentState);
      targetState = parentState;
    }

    const descendantStates = chain.slice(0, -1);
    return {
      status: 'resolved',
      kind,
      activeState,
      targetState,
      descendantStates,
      forceOrder: chain,
      releaseRunIds: chain.map((state) => state.id),
    };
  }

  /**
   * Release multiple runbooks from session targeting structures in one session
   * mutation, composed from {@link releaseFromSession} in a single transaction.
   *
   * Used by the inline force-terminal cascade to tear down the whole active
   * inline chain after every member reached terminal lifecycle. Callers may
   * retain the terminal root's claim while still deleting descendant claims.
   *
   * @param runbookIds - Run ids to release, in descendant-to-root order.
   * @param options - Aggregate terminal-claim retention policy.
   * @param options.retainClaimsAsTerminalRunId - Root run whose matching claims remain terminal.
   * @returns The released run ids and the next default-stack runbook id, if any.
   *   Refused `execution_in_progress` or `recovery_required` instead when the
   *   run is execution-owned or awaiting recovery; the value is absent then.
   */
  async releaseRunbooks(
    runbookIds: readonly RunId[],
    options: { readonly retainClaimsAsTerminalRunId?: RunId } = {},
  ): Promise<SessionMutationResult<ReleaseRunbooksResult>> {
    return this.mutateGuarded(runbookIds, (ctx) => {
      const releasedRunIds: RunId[] = [];
      for (const runbookId of runbookIds) {
        const released = this.releaseFromSession(ctx.session, runbookId, {
          retainClaimsAsTerminal: runbookId === options.retainClaimsAsTerminalRunId,
        });
        if (released.status === 'released') {
          releasedRunIds.push(runbookId);
        }
      }

      const { defaultStack } = ctx.session;
      return {
        releasedRunIds,
        nextDefaultRunbookId: defaultStack[defaultStack.length - 1] ?? null,
      };
    });
  }

  /**
   * Reset session targeting as the first step of an explicit prune-all operation.
   *
   * This deliberately does not load the existing session. `prune --all` is the
   * recovery path for persisted session shapes that the current version rejects,
   * so attempting to validate or adapt that data would make recovery impossible
   * or introduce a forbidden migration. The canonical empty session is written
   * in one transaction before run state is deleted, preserving prune's
   * release-before-delete convergence guarantee.
   *
   * @returns A promise that resolves after the canonical empty session is persisted.
   */
  async resetForPruneAll(): Promise<void> {
    await this.manager.saveSession({ defaultStack: [], claims: {} });
  }

  /**
   * Release a runbook from all session targeting structures by id.
   *
   * @param runbookId - Runbook id to release
   * @param options - Release options
   * @param options.retainClaimsAsTerminal - When true, leave matching claim
   *   records in place as terminal tombstones (so `getActiveForClaimId` resolves
   *   `terminal` rather than `missing`) instead of deleting them. Used by the
   *   natural-completion terminal-release path; explicit teardown deletes.
   * @returns Structured release result
   *   Refused `execution_in_progress` or `recovery_required` instead when the
   *   run is execution-owned or awaiting recovery; the value is absent then.
   */
  async releaseRunbook(
    runbookId: RunId,
    options: { readonly retainClaimsAsTerminal?: boolean } = {},
  ): Promise<SessionMutationResult<ReleaseRunbookResult>> {
    return this.mutateGuarded([runbookId], (ctx) =>
      this.releaseFromSession(ctx.session, runbookId, options),
    );
  }

  /**
   * Remove claim records whose child run is among `childRunIds`.
   *
   * Folds tombstone GC into pruning: when a terminal child run is deleted, its
   * retained claim tombstone is no longer meaningful and is removed alongside it.
   *
   * @param childRunIds - Child run ids being pruned.
   * @returns The claim lookup keys that were removed.
   *   Refused `execution_in_progress` or `recovery_required` instead when the
   *   run is execution-owned or awaiting recovery; the value is absent then.
   */
  async pruneClaimsForChildren(
    childRunIds: readonly string[],
  ): Promise<SessionMutationResult<ClaimLookupKey[]>> {
    // Only parseable run ids can name a run that could be under execution; the
    // rest are unparseable state-file names whose claims are pure tombstone GC.
    return this.mutateGuarded(childRunIds.filter(isRunId), (ctx) => {
      const targets = new Set<string>(childRunIds);
      const removed: ClaimLookupKey[] = [];
      for (const [claimKey, claim] of Object.entries(ctx.session.claims)) {
        if (targets.has(claim.controlledRunId)) {
          removed.push(claim.claimKey);
          delete ctx.session.claims[claimKey];
        }
      }
      return removed;
    });
  }

  /**
   * Release a runbook from an in-memory session (no IO, no transaction).
   *
   * Pure in-place mutation so composite operations — {@link releaseRunbooks},
   * {@link popRunbook} — can release several runbooks against one session
   * snapshot and commit once, instead of round-tripping per runbook.
   *
   * @param session - Session to mutate in place.
   * @param runbookId - Runbook id to release from session targeting structures
   * @param options - Release options (see {@link releaseRunbook})
   * @param options.retainClaimsAsTerminal - When true, retain matching claim
   *   records as terminal tombstones instead of deleting them.
   * @returns Structured release result describing what was removed
   */
  private releaseFromSession(
    session: SessionData,
    runbookId: RunId,
    options: { readonly retainClaimsAsTerminal?: boolean } = {},
  ): ReleaseRunbookResult {
    return projectRunbookRelease(session, runbookId, options);
  }

  /**
   * Pop a runbook from the active runbook stack.
   *
   * Used when completing or stopping a runbook. Removes the top runbook
   * and returns the new top (parent runbook) ID if one exists.
   *
   * @returns The new active runbook ID (parent), or null if the stack is empty
   *   Refused `execution_in_progress` or `recovery_required` instead when the
   *   run is execution-owned or awaiting recovery; the value is absent then.
   */
  async popRunbook(): Promise<SessionMutationResult<RunId | null>> {
    return this.mutateGuarded(topOfStack, (ctx) => {
      const { defaultStack } = ctx.session;
      const topId = defaultStack[defaultStack.length - 1];
      if (!topId) return null;
      const released = this.releaseFromSession(ctx.session, topId);
      return released.status === 'released' ? released.nextDefaultRunbookId : null;
    });
  }

  /**
   * Stash the currently active runbook to allow temporarily switching contexts.
   *
   * Resolves the active run and writes the stash slot in one guarded
   * transaction. The caller must not pre-read the active run: an unlocked
   * `getActive` followed by a separate stash write is the #666 check-then-act
   * shape, where a concurrent push means the run that gets parked is no longer
   * the one the caller resolved. Everything the caller needs to render the
   * outcome — including the stashed run's state — comes back on the result.
   *
   * The active run is resolved before the slot is inspected, matching the order
   * the two-step caller asked its questions in: it resolved the active run
   * first and returned `no-active-runbook` without ever reaching the slot.
   *
   * @returns Discriminated stash result describing success or the refusal reason.
   *   Refused `execution_in_progress` or `recovery_required` instead when the
   *   run is execution-owned or awaiting recovery; the value is absent then.
   */
  async stash(): Promise<SessionMutationResult<StashActiveResult>> {
    return this.mutateGuarded(topOfStack, (ctx): StashActiveResult => {
      const { session } = ctx;
      const stack = session.defaultStack;
      if (stack.length === 0) return { status: 'no-active-runbook' };
      const activeId = stack[stack.length - 1];

      // Read through the transaction, never `manager.load`: the state returned
      // to the caller must be the one the slot write lands on. A null here is
      // the state the `session_stack` foreign key forbids (see
      // StashActiveResult), and reports as the same idle outcome `getActive`
      // gave it rather than inventing an unreachable arm.
      const state = ctx.readState(activeId);
      if (state === null) return { status: 'no-active-runbook' };

      // Refuse to overwrite an existing stash — caller must unstash first.
      if (session.stashedRunbookId !== undefined) {
        return { status: 'slot-occupied', stashedRunbookId: session.stashedRunbookId };
      }

      stack.pop();
      session.stashedRunbookId = activeId;
      return { status: 'stashed', state };
    });
  }

  /**
   * Stash a claimed runbook by explicit claim id, atomically.
   *
   * The presented bearer is verified inside the same transaction that writes the
   * stash slot. The session write this replaced authorized on the run id alone —
   * it asked only whether *some* claim controlled the run — so a bearer rotated
   * between an unlocked resolve and the commit still succeeded (#666). Resolving
   * and committing in one `mutateSessionGuarded` cycle removes that window by
   * construction; there is no captured generation to re-check because there is
   * no gap for a rotation to land in. No bearer-blind stash remains on this
   * class: the shape survives only as `stashRunbookUnverified` in
   * `testing/session-fixtures.ts`, where product code cannot reach it.
   *
   * Unlike {@link unstashForClaimId}, the linkage and delegation-liveness checks
   * are guarded on `claim.delegation`: `stash --claim-id` accepts a run-control
   * bearer as well as a delegated one, and `linkageMatchesClaim` reports `false`
   * for a claim with no delegation.
   *
   * The claim record is deliberately left untouched — stash preserves it, and
   * the command is classified non-recording (#519).
   *
   * @param claimId - Bearer claim id for the runbook to stash
   * @returns Discriminated stash result describing success or the refusal reason.
   *   Refused `execution_in_progress` or `recovery_required` instead when the
   *   run is execution-owned or awaiting recovery; the value is absent then.
   */
  async stashForClaimId(claimId: ClaimId): Promise<SessionMutationResult<StashForClaimIdResult>> {
    // Hoisted out of the callback so the affected-run selector reads the same
    // parsed bearer the mutation does; the slot write is guarded against the
    // claim's controlled run.
    const parsed = parseClaimBearer(claimId);
    const affectedRun = (session: SessionData): readonly RunId[] => {
      if (!Object.hasOwn(session.claims, parsed.claimKey)) return [];
      const claim = session.claims[parsed.claimKey];
      return verifyClaimSecret(parsed.secret, claim.secretHash) ? [claim.controlledRunId] : [];
    };
    return this.mutateGuarded(affectedRun, (ctx): StashForClaimIdResult => {
      const { session } = ctx;
      if (!Object.hasOwn(session.claims, parsed.claimKey)) {
        // Same split as `unstashForClaimId`: a bearer the parent-side latch
        // tombstoned is superseded, not unknown. `ctx.claim` reads through the
        // open transaction, so the tombstone is read under the same snapshot.
        const presented = ctx.claim(parsed.claimKey);
        if (
          presented === null ||
          presented.status === 'active' ||
          !verifyClaimSecret(parsed.secret, presented.record.secretHash)
        ) {
          return { status: 'missing-claim', claimId };
        }
        const parentRunId = presented.record.delegation?.parentRunId;
        return {
          status: 'superseded',
          claimId,
          reason: this.describeSupersession(
            presented.record,
            parentRunId === undefined ? null : ctx.readState(parentRunId),
          ).reason,
        };
      }
      const claim = session.claims[parsed.claimKey];
      if (!verifyClaimSecret(parsed.secret, claim.secretHash)) {
        return { status: 'missing-claim', claimId };
      }
      // Narrowed the moment the bearer is proved, and it is `verified` — never
      // `claim` — that leaves this method: the persisted record carries
      // `secretHash`, and nothing outside the transaction has any use for it.
      const verified = verifiedClaimFromRecord(claim);
      const state = ctx.readState(claim.controlledRunId);
      if (!state) {
        // The claim's controlled run state cannot be read. The FK cascade deletes
        // a claim with its run, so this is not reachable through a supported
        // delete — but the caller-visible refusal taxonomy returns a typed
        // `missing-child` rather than throwing, so a corrupted database degrades
        // gracefully.
        return { status: 'missing-child', childRunId: claim.controlledRunId };
      }
      if (state.lifecycle === 'completed' || state.lifecycle === 'stopped') {
        return { status: 'terminal-child', claim: verified, lifecycle: state.lifecycle };
      }
      if (claim.delegation) {
        if (!linkageMatchesClaim(state.parentLinkage, claim)) {
          return { status: 'child-linkage-mismatch', claim: verified };
        }
        // Classified, not lifecycle-checked, for the reason given in
        // `getActiveForClaimId`: an active row whose delegation has closed must
        // still refuse, including the `cursor-advanced` case a lifecycle check
        // cannot see.
        const parent = ctx.readState(claim.delegation.parentRunId);
        const liveness = classifyDelegationLiveness(parent, claim.delegation);
        if (liveness.kind === 'parent-unreadable') {
          return { status: 'parent-missing', claim: verified };
        }
        if (liveness.kind === 'closed') {
          return { status: 'superseded', claimId, reason: liveness.reason };
        }
      }

      // Split, where the bearer-blind predecessor collapsed both into `null`.
      // `already-stashed` is the caller's own controlled run already in the slot;
      // `slot-occupied` is a *different* run holding it. Re-parking what you
      // already parked is a different mistake from colliding with someone else's
      // parked run, and the caller needs to be told which one happened.
      //
      // Both sit last, for the reason `getActiveForClaimId` gives its own
      // parked-runbook gate: between two simultaneously true refusals, the one
      // that ends the caller's work beats the one that invites more of it. A
      // terminal controlled run or a closed delegation is the real answer even
      // when the slot also happens to be busy — reporting the slot first would
      // send the caller to pop and retry only to meet the refusal that was true
      // all along, and would hide a closed delegation's no-retry signal behind it.
      if (session.stashedRunbookId === claim.controlledRunId) {
        return { status: 'already-stashed', claim: verified };
      }
      if (session.stashedRunbookId !== undefined) {
        return {
          status: 'slot-occupied',
          claim: verified,
          stashedRunbookId: session.stashedRunbookId,
        };
      }

      // The predecessor's `targetedByClaim` arm — does *some* claim control this
      // run — is not reproduced: the verified bearer's claim controls it, so the
      // question is satisfied by construction. Its stack filter is reproduced —
      // a run-control-claimed run is stack resident and must leave the stack
      // when it is parked.
      session.defaultStack = session.defaultStack.filter((id) => id !== claim.controlledRunId);
      session.stashedRunbookId = claim.controlledRunId;
      return { status: 'stashed', claim: verified, state };
    });
  }

  /**
   * Restore a stashed delegated runbook by explicit claim id.
   *
   * @param claimId - Claim id for the stashed child runbook
   * @returns Discriminated restore result describing success or the refusal reason
   *   Refused `execution_in_progress` or `recovery_required` instead when the
   *   run is execution-owned or awaiting recovery; the value is absent then.
   */
  async unstashForClaimId(
    claimId: ClaimId,
  ): Promise<SessionMutationResult<UnstashForClaimIdResult>> {
    // Hoisted out of the callback so the affected-run selector can read the same
    // parsed bearer the mutation does; clearing the stash slot is guarded against
    // the claim's controlled run.
    const parsed = parseClaimBearer(claimId);
    const affectedRun = (session: SessionData): readonly RunId[] => {
      if (!Object.hasOwn(session.claims, parsed.claimKey)) return [];
      const claim = session.claims[parsed.claimKey];
      return verifyClaimSecret(parsed.secret, claim.secretHash) ? [claim.controlledRunId] : [];
    };
    return this.mutateGuarded(affectedRun, (ctx): UnstashForClaimIdResult => {
      const { session } = ctx;
      if (!Object.hasOwn(session.claims, parsed.claimKey)) {
        // Same split as `getActiveForClaimId`: a bearer the parent-side latch
        // tombstoned is superseded, not unknown. `ctx.claim` reads through the
        // open transaction, so the tombstone is read under the same snapshot.
        const presented = ctx.claim(parsed.claimKey);
        if (
          presented === null ||
          presented.status === 'active' ||
          !verifyClaimSecret(parsed.secret, presented.record.secretHash)
        ) {
          return { status: 'missing-claim', claimId };
        }
        const parentRunId = presented.record.delegation?.parentRunId;
        return {
          status: 'superseded',
          claimId,
          reason: this.describeSupersession(
            presented.record,
            parentRunId === undefined ? null : ctx.readState(parentRunId),
          ).reason,
        };
      }
      const claim = session.claims[parsed.claimKey];
      if (!verifyClaimSecret(parsed.secret, claim.secretHash)) {
        return { status: 'missing-claim', claimId };
      }
      // Narrowed the moment the bearer is proved, and it is `verified` — never
      // `claim` — that leaves this method: the persisted record carries
      // `secretHash`, and nothing outside the transaction has any use for it.
      const verified = verifiedClaimFromRecord(claim);
      if (session.stashedRunbookId !== claim.controlledRunId) {
        return { status: 'not-stashed', claim: verified };
      }

      const state = ctx.readState(claim.controlledRunId);
      if (!state) {
        // The claim's controlled run state cannot be read. The FK cascade deletes
        // a claim with its run, so this is not reachable through a supported
        // delete — but the caller-visible refusal taxonomy (superseded plan
        // Task 6) returns a typed `missing-child` rather than throwing, so a
        // corrupted database degrades gracefully.
        return { status: 'missing-child', childRunId: claim.controlledRunId };
      }
      if (state.lifecycle === 'completed' || state.lifecycle === 'stopped') {
        return { status: 'terminal-child', claim: verified, lifecycle: state.lifecycle };
      }
      if (!linkageMatchesClaim(state.parentLinkage, claim)) {
        return { status: 'child-linkage-mismatch', claim: verified };
      }
      // Unreachable at runtime, and kept only to narrow `claim.delegation` for
      // the read below: `linkageMatchesClaim` returns `false` outright for a
      // claim with no delegation, so the check above has already refused every
      // input that could reach this one — with the identical status, which is
      // why the redundancy is invisible in behaviour. Do not write a test for
      // it (mutation testing reports the branch as unkillable, correctly), and
      // do not delete it: `claim.delegation` is optional, so dropping it moves
      // the failure to a compile error on the next line. `stashForClaimId`
      // guards the whole delegated block on `if (claim.delegation)` instead,
      // because stash accepts a run-control bearer where pop does not.
      if (!claim.delegation) {
        return { status: 'child-linkage-mismatch', claim: verified };
      }
      // Classified, not lifecycle-checked, for the reason given in
      // `getActiveForClaimId`: an active row whose delegation has closed must
      // still refuse, including the `cursor-advanced` case a lifecycle check
      // cannot see.
      const parent = ctx.readState(claim.delegation.parentRunId);
      const liveness = classifyDelegationLiveness(parent, claim.delegation);
      if (liveness.kind === 'parent-unreadable') {
        return { status: 'parent-missing', claim: verified };
      }
      if (liveness.kind === 'closed') {
        return { status: 'superseded', claimId, reason: liveness.reason };
      }

      session.stashedRunbookId = undefined;
      // Persisted at the claim seam, not by the wholesale reconciler: an
      // already-persisted claim is left untouched by `applySession`, so the
      // snapshot edit alone would not reach the row. `touchClaimUpdatedAt` is
      // distinct from `recordClaimSeen` on purpose — an unstash is a record
      // write, not evidence that the claim's holder is alive (#519).
      const now = this.now();
      ctx.touchClaimUpdatedAt(parsed.claimKey, now);
      session.claims[parsed.claimKey] = refreshedClaimRecord(claim, now);
      // `refreshedClaimRecord` moves `updatedAt` only, which `VerifiedClaim`
      // does not carry, so the pre-refresh narrowing is the same value — but it
      // is derived from the committed record so the two cannot drift if that
      // refresh ever touches a field the verified shape does keep.
      return {
        status: 'restored',
        claim: verifiedClaimFromRecord(session.claims[parsed.claimKey]),
        state,
      };
    });
  }

  /**
   * Unstash a previously stashed runbook to the active stack.
   *
   * Retrieves the stashed runbook ID and pushes it back onto the
   * stack, making it the active runbook again. Clears the stashed slot.
   *
   * @returns The restored runbook state, or null if nothing was stashed or runbook not found
   *   Refused `execution_in_progress` or `recovery_required` instead when the
   *   run is execution-owned or awaiting recovery; the value is absent then.
   */
  async unstash(): Promise<SessionMutationResult<RunbookState | null>> {
    return this.mutateGuarded(
      (session) => (session.stashedRunbookId ? [session.stashedRunbookId] : []),
      (ctx) => {
        const { session } = ctx;
        const stashedId = session.stashedRunbookId;

        if (!stashedId) return null;

        const targetedByDelegatedClaim = Object.values(session.claims).some(
          (claim) => claim.delegation !== undefined && claim.controlledRunId === stashedId,
        );
        if (targetedByDelegatedClaim) {
          return null;
        }

        const state = ctx.readState(stashedId);
        if (!state) {
          // Live, despite looking like the sibling of the `missing-active-state`
          // arm removed from `stash()` — and the difference is which session
          // structure `applySession` has to rewrite. That arm left a dangling id
          // in `defaultStack`, and `setStack` writes the stack unconditionally,
          // so the commit failed the `session_stack` foreign key before the arm
          // could be returned. Here the slot is written by `setStash`, whose
          // clearing form is a bare `DELETE FROM stash_slot` with no reference
          // to insert, so this repair commits. Reaching it still needs an
          // out-of-band delete with the cascade disabled — pinned by "unstash
          // clears a stash slot whose run row was removed out of band". Do not
          // fold this into the `!stashedId` guard: that would leave the corrupt
          // row in place and every later `unstash` returning null forever.
          session.stashedRunbookId = undefined;
          return null;
        }

        // Push back to stack
        session.defaultStack.push(stashedId);
        session.stashedRunbookId = undefined;

        return state;
      },
    );
  }

  /**
   * Get the ID of the currently stashed runbook, if any.
   *
   * @returns The stashed runbook ID, or null if nothing is stashed
   */
  async getStashedRunbookId(): Promise<RunId | null> {
    const session = await this.manager.loadSession();
    return session.stashedRunbookId ?? null;
  }
}
