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
  isOpenDelegatedChildrenError,
  type ParentAdvanceGuard,
  type SessionMutationResult,
  type SessionMutationTxn,
} from './storage/runbook-store.js';
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
  type ClaimAndInitialLinkInput,
  type ClaimAndInitialLinkResult,
  type ClaimVerificationResult,
  type DelegationClaimLinkage,
  type VerifiedClaim,
} from './claim-id.js';
import type { DelegationLinkage, RunbookState } from './types.js';
import { classifyDelegationLiveness, findSubstepState, linkageMatchesClaim } from './targeting.js';
import {
  DELEGATION_COLLECTION_PENDING_MESSAGE,
  readDelegationCollectionPendingForPolicy,
} from './delegation-lifecycle-read-model.js';
import type { ExecutionEpoch } from './storage/mutation-result.js';
import { assertClaimGeneration } from './storage/mutation-result.js';

class ParentInitialLinkConflictError extends Error {
  constructor(readonly parentRunId: RunId) {
    super(`Parent run ${parentRunId} changed before its initial child link committed.`);
    this.name = 'ParentInitialLinkConflictError';
  }
}

/** Result of removing a runbook from session targeting structures. */
export type ReleaseRunbookResult =
  | { readonly status: 'not-found'; readonly runbookId: RunId }
  | {
      readonly status: 'released';
      readonly runbookId: RunId;
      readonly removedFromDefaultStack: boolean;
      readonly nextDefaultRunbookId: RunId | null;
    };

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
      /** The named id is not on the session default stack (or its state file is missing). */
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

/** Result of restoring a stashed delegated child by claim id. */
export type UnstashForClaimIdResult =
  | { readonly status: 'restored'; readonly claim: ClaimRecord; readonly state: RunbookState }
  | { readonly status: 'missing-claim'; readonly claimId: ClaimId }
  | { readonly status: 'missing-child'; readonly childRunId: RunId }
  | { readonly status: 'not-stashed'; readonly claim: ClaimRecord }
  | {
      readonly status: 'terminal-child';
      readonly claim: ClaimRecord;
      readonly lifecycle: 'completed' | 'stopped';
    }
  | { readonly status: 'child-linkage-mismatch'; readonly claim: ClaimRecord }
  | { readonly status: 'parent-missing'; readonly claim: ClaimRecord }
  | {
      readonly status: 'parent-ended';
      readonly claim: ClaimRecord;
      readonly lifecycle: 'completed' | 'stopped';
    };

/** Ownership refusal arm returned by a session mutation. */
export type SessionMutationRefusal = Exclude<
  SessionMutationResult<unknown>,
  { readonly status: 'committed' }
>;

/** Command-facing spelling of a session ownership refusal. */
export type SessionMutationRefusalOutcome =
  | {
      readonly kind: 'execution_in_progress';
      readonly runId: RunId;
      readonly message: string;
    }
  | {
      readonly kind: 'recovery_required';
      readonly runId: RunId;
      readonly epoch: ExecutionEpoch;
      readonly message: string;
    };

/**
 * Convert the storage-facing session refusal spelling to the command-facing one.
 *
 * The payload is forwarded verbatim so callers never reconstruct run identity,
 * recovery epoch, or operator text.
 *
 * @param refusal - Non-committed session mutation result.
 * @returns The corresponding command-facing refusal.
 */
export function sessionMutationRefusalOutcome(
  refusal: SessionMutationRefusal,
): SessionMutationRefusalOutcome {
  switch (refusal.status) {
    case 'execution-in-progress':
      return {
        kind: 'execution_in_progress',
        runId: refusal.runId,
        message: refusal.message,
      };
    case 'recovery-required':
      return {
        kind: 'recovery_required',
        runId: refusal.runId,
        epoch: refusal.epoch,
        message: refusal.message,
      };
    default: {
      const _exhaustive: never = refusal;
      return _exhaustive;
    }
  }
}

/**
 * True when persisted child linkage matches an incoming delegation linkage on the
 * three identifying fields (`parentRunId`, `parentStepId`, `tokenHash`).
 *
 * Used by {@link SessionService.claimRunbook} to refuse a claim when the child's
 * persisted linkage disagrees with the freshly token-validated linkage the caller
 * is presenting — a fail-closed signal for state corruption.
 *
 * @param persisted - Parent linkage stored on the child runbook state
 * @param incoming - Freshly built delegation linkage offered by the caller
 * @returns `true` only when both are delegation-shaped and all identifying fields agree
 */
function linkageMatchesLinkage(
  persisted: RunbookState['parentLinkage'],
  incoming: DelegationLinkage,
): boolean {
  return (
    persisted?.kind === 'delegation' &&
    persisted.parentRunId === incoming.parentRunId &&
    persisted.parentStepId === incoming.parentStepId &&
    persisted.tokenHash === incoming.tokenHash
  );
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
  private mutate<T>(work: (ctx: SessionMutationTxn) => T): Promise<T> {
    return this.manager.mutateSession(work);
  }

  private mutateGuarded<T>(
    runIds: readonly RunId[] | ((session: SessionData) => readonly RunId[]),
    work: (ctx: SessionMutationTxn) => T,
  ): Promise<SessionMutationResult<T>> {
    return this.manager.mutateSessionGuarded(runIds, work);
  }

  private findClaimByChildRunId(
    claims: Record<string, ClaimRecord>,
    childRunId: RunId,
  ): ClaimRecord | undefined {
    return Object.values(claims).find((claim) => claim.controlledRunId === childRunId);
  }

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
   */
  async issueRunControlClaim(
    runId: RunId,
  ): Promise<SessionMutationResult<{ readonly claimId: ClaimId; readonly claim: ClaimRecord }>> {
    return this.mutateGuarded([runId], (ctx) => this.mintRunControlClaim(ctx.session, runId));
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
  private mintRunControlClaim(
    session: SessionData,
    runId: RunId,
  ): { readonly claimId: ClaimId; readonly claim: ClaimRecord } {
    const now = this.now();
    const parsed = parseClaimBearer(generateClaimBearer());
    const claim = createClaimRecord({
      claimKey: parsed.claimKey,
      secretHash: hashClaimSecret(parsed.secret),
      controlledRunId: runId,
      grants: createRunControlGrants(runId),
      now,
    });
    // Uphold the SessionDataSchema controlledRunId-uniqueness invariant: a run has
    // at most one run-control claim. Re-issuing supersedes (rotates) any existing
    // claim for this run rather than appending a duplicate that would render the
    // session unreadable. The prior bearer is invalidated by construction.
    for (const [existingKey, existingClaim] of Object.entries(session.claims)) {
      if (existingClaim.controlledRunId === runId) {
        delete session.claims[existingKey];
      }
    }
    session.claims[claim.claimKey] = claim;
    return { claimId: parsed.claimId, claim };
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
   *   and `session.json` is a local file. A backward step moves both, so the older
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
   * incoming `linkage` on the three identifying fields. A mismatch indicates
   * state corruption (manual edits, stale persisted linkage from a prior
   * delegation, cross-host state merge) and is refused rather than silently
   * propagated into the claim record.
   *
   * @param childRunId - Child run id created or reused by claim
   * @param linkage - Delegation linkage to record in the claim. Caller must build
   *   this from freshly token-validated parent state.
   * @returns A claim record on success, or a failure variant when the child is
   *   missing, terminal, or its persisted linkage diverges from `linkage`.
   */
  async claimRunbook(
    childRunId: RunId,
    linkage: DelegationLinkage,
  ): Promise<SessionMutationResult<ClaimRunbookResult>> {
    return this.mutateGuarded([childRunId], (ctx) =>
      this.claimRunbookInTransaction(ctx, childRunId, linkage, false),
    );
  }

  /**
   * Atomically claim a delegated child and establish its first parent link.
   *
   * @param input - Exact child and delegation linkage to claim and link.
   * @returns The committed domain result or a typed ownership refusal.
   */
  async claimAndInitialLink(
    input: ClaimAndInitialLinkInput,
  ): Promise<SessionMutationResult<ClaimAndInitialLinkResult>> {
    try {
      return await this.mutateGuarded(
        [input.childRunId, input.linkage.parentRunId],
        (ctx): ClaimAndInitialLinkResult => {
          const claim = this.claimRunbookInTransaction(ctx, input.childRunId, input.linkage, true);
          if (claim.status === 'already-claimed' && claim.childRunId !== input.childRunId) {
            throw new ParentInitialLinkConflictError(input.linkage.parentRunId);
          }
          if (claim.status !== 'claimed' && claim.status !== 'already-claimed') return claim;
          if (ctx.linkInitialDelegation(input, this.now()) === 'conflict') {
            throw new ParentInitialLinkConflictError(input.linkage.parentRunId);
          }
          return claim;
        },
      );
    } catch (error: unknown) {
      if (!(error instanceof ParentInitialLinkConflictError)) throw error;
      return {
        status: 'committed',
        value: {
          status: 'parent-concurrent-modification',
          parentRunId: error.parentRunId,
          message: `Parent run ${error.parentRunId} changed before its initial child link committed.`,
        },
      };
    }
  }

  /**
   * Roll back a just-created claim/link pair without clearing a newer link.
   *
   * @param input - Exact token and child link originally established.
   * @returns Whether the matching pair was removed or was already absent.
   */
  async rollbackInitialLink(
    input: ClaimAndInitialLinkInput,
  ): Promise<SessionMutationResult<{ readonly status: 'rolled-back' | 'already-absent' }>> {
    return this.mutateGuarded([input.childRunId, input.linkage.parentRunId], (ctx) => {
      const cleared = ctx.clearInitialDelegation(input, this.now());
      if (cleared !== 'cleared') return { status: 'already-absent' as const };
      const claim = this.findClaimByDelegationLinkage(ctx.session.claims, input.linkage);
      if (claim !== undefined && claim.controlledRunId === input.childRunId) {
        delete ctx.session.claims[claim.claimKey];
      }
      return { status: 'rolled-back' as const };
    });
  }

  private claimRunbookInTransaction(
    ctx: SessionMutationTxn,
    childRunId: RunId,
    linkage: DelegationLinkage,
    insertImmediately: boolean,
  ): ClaimRunbookResult {
    const { session } = ctx;
    const now = this.now();

    // Claim-side half of the durable latch (R2). Validate the exact delegation
    // is still live in the parent state read inside THIS transaction, before
    // any existing-claim refresh or fresh insertion. If the parent commit that
    // moved past this delegation already landed, refuse — the tombstoned bearer
    // cannot be resurrected by a later reset. A parent that cannot be read is a
    // hard integrity error, not a routine close (the nested missing-child throw
    // below only covers the existing-claim path, never a fresh claim).
    const parent = ctx.readState(linkage.parentRunId);
    const liveness = classifyDelegationLiveness(parent, linkage);
    if (liveness.kind === 'parent-unreadable') {
      throw new Error(
        `Parent run ${linkage.parentRunId} is missing while claiming delegation ${linkage.parentStepId}; the runbook database is inconsistent.`,
      );
    }
    if (liveness.kind === 'closed') {
      return {
        status: 'delegation-superseded',
        parentRunId: linkage.parentRunId,
        parentStepId: linkage.parentStepId,
        childRunId,
      };
    }

    const existingForDelegation = this.findClaimByDelegationLinkage(session.claims, linkage);
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
      if (!linkageMatchesLinkage(existingState.parentLinkage, linkage)) {
        return {
          status: 'linkage-mismatch',
          childRunId: existingForDelegation.controlledRunId,
          incoming: linkage,
          persisted: existingState.parentLinkage,
        };
      }
      return {
        status: 'already-claimed',
        childRunId: existingForDelegation.controlledRunId,
        claim: existingForDelegation,
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
    if (insertImmediately) {
      const generation =
        ctx.tx
          .prepare('SELECT claim_generation AS generation FROM runs WHERE id = :runId')
          .get<{ readonly generation: number }>({ runId: childRunId })?.generation ?? 0;
      ctx.insertClaim(claim, assertClaimGeneration(generation));
    }
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
      return { status: 'missing', claimId };
    }
    const record = session.claims[parsed.claimKey];
    if (!verifyClaimSecret(parsed.secret, record.secretHash)) {
      return { status: 'invalid-secret', claimId };
    }
    const claim = verifiedClaimFromRecord(record);

    if (options.includeStashed !== true && session.stashedRunbookId === record.controlledRunId) {
      return { status: 'unlinked', claim, reason: 'stashed' };
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
      const parent = await this.manager.load(record.delegation.parentRunId);
      if (!parent) {
        return { status: 'unlinked', claim, reason: 'parent-missing' };
      }
      if (parent.lifecycle === 'completed' || parent.lifecycle === 'stopped') {
        return { status: 'unlinked', claim, reason: 'parent-ended' };
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
   * The `advance` callback MUST perform only the decisive transition write
   * (e.g. `RunbookCompletionService.recordManualCompletion` or
   * `RunbookActorService.sendAndSync`), passing the supplied guard into it.
   * Downstream drain/release steps run afterwards.
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
   * inline chain after every member reached terminal lifecycle. This is explicit
   * teardown of default-stack inline composition, not natural claim completion,
   * so `retainClaimsAsTerminal` is intentionally not applied here.
   *
   * @param runbookIds - Run ids to release, in descendant-to-root order.
   * @returns The released run ids and the next default-stack runbook id, if any.
   */
  async releaseRunbooks(
    runbookIds: readonly RunId[],
  ): Promise<SessionMutationResult<ReleaseRunbooksResult>> {
    return this.mutateGuarded(runbookIds, (ctx) => {
      const releasedRunIds: RunId[] = [];
      for (const runbookId of runbookIds) {
        const released = this.releaseFromSession(ctx.session, runbookId);
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
   */
  async pruneClaimsForChildren(
    childRunIds: readonly string[],
  ): Promise<SessionMutationResult<ClaimLookupKey[]>> {
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
    const originalDefaultStackLength = session.defaultStack.length;
    session.defaultStack = session.defaultStack.filter((id) => id !== runbookId);
    const removedFromDefaultStack = session.defaultStack.length !== originalDefaultStackLength;

    const removedClaimIds: string[] = [];
    const retainedClaimIds: string[] = [];
    for (const [claimKey, claim] of Object.entries(session.claims)) {
      if (claim.controlledRunId === runbookId) {
        if (options.retainClaimsAsTerminal) {
          // Leave the record in place as a terminal tombstone so
          // getActiveForClaimId resolves `terminal` (not `missing`). Pruned
          // alongside the child run by `rd prune`.
          retainedClaimIds.push(claimKey);
        } else {
          removedClaimIds.push(claimKey);
          delete session.claims[claimKey];
        }
      }
    }

    const removedFromStash = session.stashedRunbookId === runbookId;
    if (removedFromStash) {
      session.stashedRunbookId = undefined;
    }

    if (
      !removedFromDefaultStack &&
      removedClaimIds.length === 0 &&
      retainedClaimIds.length === 0 &&
      !removedFromStash
    ) {
      return { status: 'not-found', runbookId } satisfies ReleaseRunbookResult;
    }

    return {
      status: 'released',
      runbookId,
      removedFromDefaultStack,
      nextDefaultRunbookId: session.defaultStack[session.defaultStack.length - 1] ?? null,
    } satisfies ReleaseRunbookResult;
  }

  /**
   * Pop a runbook from the active runbook stack.
   *
   * Used when completing or stopping a runbook. Removes the top runbook
   * and returns the new top (parent runbook) ID if one exists.
   *
   * @returns The new active runbook ID (parent), or null if the stack is empty
   */
  async popRunbook(): Promise<SessionMutationResult<RunId | null>> {
    return this.mutateGuarded(
      (session) => {
        const topId = session.defaultStack[session.defaultStack.length - 1];
        return topId ? [topId] : [];
      },
      (ctx) => {
        const { defaultStack } = ctx.session;
        const topId = defaultStack[defaultStack.length - 1];
        if (!topId) return null;
        const released = this.releaseFromSession(ctx.session, topId);
        return released.status === 'released' ? released.nextDefaultRunbookId : null;
      },
    );
  }

  /**
   * Stash the currently active runbook to allow temporarily switching contexts.
   *
   * Removes the active runbook from the stack and stores its ID
   * in the session's stashed slot. Only one runbook can be stashed at a time.
   *
   * @returns The stashed runbook ID, or null if no runbook was active or a stash already exists
   */
  async stash(): Promise<SessionMutationResult<RunId | null>> {
    return this.mutateGuarded(
      (session) => {
        const activeId = session.defaultStack[session.defaultStack.length - 1];
        return activeId ? [activeId] : [];
      },
      (ctx) => {
        const { session } = ctx;

        // Refuse to overwrite an existing stash — caller must unstash first
        if (session.stashedRunbookId) return null;

        const stack = session.defaultStack;
        if (stack.length === 0) return null;
        const activeId = stack.pop();

        if (!activeId) return null;

        session.stashedRunbookId = activeId;
        return activeId;
      },
    );
  }

  /**
   * Stash a specific runbook id from any session targeting structure.
   *
   * @param runbookId - Runbook id to move into the single session stash slot
   * @returns The stashed runbook id, or null if no slot is available or the runbook was not targeted
   */
  async stashRunbook(runbookId: RunId): Promise<SessionMutationResult<RunId | null>> {
    return this.mutateGuarded([runbookId], (ctx) => {
      const { session } = ctx;
      if (session.stashedRunbookId) return null;

      const originalDefaultStackLength = session.defaultStack.length;
      session.defaultStack = session.defaultStack.filter((id) => id !== runbookId);
      const removedFromDefaultStack = session.defaultStack.length !== originalDefaultStackLength;

      const targetedByClaim = Object.values(session.claims).some(
        (claim) => claim.controlledRunId === runbookId,
      );

      if (!removedFromDefaultStack && !targetedByClaim) return null;

      session.stashedRunbookId = runbookId;
      return runbookId;
    });
  }

  /**
   * Restore a stashed delegated runbook by explicit claim id.
   *
   * @param claimId - Claim id for the stashed child runbook
   * @returns Discriminated restore result describing success or the refusal reason
   */
  async unstashForClaimId(
    claimId: ClaimId,
  ): Promise<SessionMutationResult<UnstashForClaimIdResult>> {
    const parsed = parseClaimBearer(claimId);
    return this.mutateGuarded(
      (session) => {
        if (!Object.hasOwn(session.claims, parsed.claimKey)) return [];
        const claim = session.claims[parsed.claimKey];
        return verifyClaimSecret(parsed.secret, claim.secretHash) ? [claim.controlledRunId] : [];
      },
      (ctx): UnstashForClaimIdResult => {
        const { session } = ctx;
        if (!Object.hasOwn(session.claims, parsed.claimKey)) {
          return { status: 'missing-claim', claimId };
        }
        const claim = session.claims[parsed.claimKey];
        if (!verifyClaimSecret(parsed.secret, claim.secretHash)) {
          return { status: 'missing-claim', claimId };
        }
        if (session.stashedRunbookId !== claim.controlledRunId) {
          return { status: 'not-stashed', claim };
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
          return { status: 'terminal-child', claim, lifecycle: state.lifecycle };
        }
        if (!linkageMatchesClaim(state.parentLinkage, claim)) {
          return { status: 'child-linkage-mismatch', claim };
        }
        if (!claim.delegation) {
          return { status: 'child-linkage-mismatch', claim };
        }
        const parent = ctx.readState(claim.delegation.parentRunId);
        if (!parent) {
          return { status: 'parent-missing', claim };
        }
        if (parent.lifecycle === 'completed' || parent.lifecycle === 'stopped') {
          return { status: 'parent-ended', claim, lifecycle: parent.lifecycle };
        }

        session.stashedRunbookId = undefined;
        session.claims[parsed.claimKey] = refreshedClaimRecord(claim, this.now());
        return { status: 'restored', claim: session.claims[parsed.claimKey], state };
      },
    );
  }

  /**
   * Unstash a previously stashed runbook to the active stack.
   *
   * Retrieves the stashed runbook ID and pushes it back onto the
   * stack, making it the active runbook again. Clears the stashed slot.
   *
   * @returns The restored runbook state, or null if nothing was stashed or runbook not found
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
