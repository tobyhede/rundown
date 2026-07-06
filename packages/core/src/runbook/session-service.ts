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

import type { RunbookStateManager } from './state.js';
import type { RunId } from './run-id.js';
import { SessionLock } from './session-lock.js';
import {
  generateClaimCapability,
  hashCapabilitySecret,
  parseClaimCapability,
  parseRunCapability,
  verifyCapabilitySecret,
  type ClaimCapability,
  type CapabilityHash,
  type RunCapability,
} from './capability.js';
import {
  createClaimRecord,
  generateClaimId,
  type ClaimId,
  type ClaimIdResolution,
  type ClaimRecord,
  type ClaimRunbookResult,
} from './claim-id.js';
import type { DelegationLinkage, RunbookState } from './types.js';
import { findSubstepState } from './targeting.js';
import {
  DELEGATION_COLLECTION_PENDING_MESSAGE,
  readDelegationCollectionPendingForPolicy,
} from './delegation-lifecycle-read-model.js';

const CLAIM_LEASE_MS = 5 * 60 * 1000;

function readClaimRecord(
  claims: Record<string, ClaimRecord>,
  claimId: ClaimId,
): ClaimRecord | undefined {
  return Object.hasOwn(claims, claimId) ? claims[claimId] : undefined;
}

function mintClaimCapability(claimId: ClaimId): {
  readonly claimCapability: ClaimCapability;
  readonly claimCapabilityHash: CapabilityHash;
} {
  const claimCapability = generateClaimCapability(claimId);
  const parsedCapability = parseClaimCapability(claimCapability);
  return {
    claimCapability,
    claimCapabilityHash: hashCapabilitySecret(parsedCapability.secret),
  };
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

/** Result of restoring a stashed delegated child by claim id. */
export type UnstashForClaimIdResult =
  | { readonly status: 'restored'; readonly claim: ClaimRecord; readonly state: RunbookState }
  | { readonly status: 'missing-claim'; readonly claimId: ClaimId }
  | { readonly status: 'not-stashed'; readonly claim: ClaimRecord }
  | { readonly status: 'missing-child'; readonly claim: ClaimRecord }
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
  return {
    kind: 'delegation',
    parentRunId: claim.parentRunId,
    parentStepId: claim.parentStepId,
    tokenHash: claim.tokenHash,
    parentStep: claim.parentStep,
    parentFrameKey: claim.parentFrameKey,
    parentEntry: claim.parentEntry,
  };
}

/**
 * True when `linkage` is a delegation linkage that matches `claim`'s parent run / step / token hash.
 * Used to verify a child runbook's parentLinkage genuinely originated from the supplied claim record.
 *
 * @param linkage - Parent linkage stored on the child runbook state (any kind, including non-delegation or absent)
 * @param claim - Claim record whose parent run id, parent step id, and token hash must all match
 * @returns `true` only when `linkage.kind === 'delegation'` and every identifying field matches `claim`; `false` otherwise
 */
function linkageMatchesClaim(linkage: RunbookState['parentLinkage'], claim: ClaimRecord): boolean {
  return (
    linkage?.kind === 'delegation' &&
    linkage.parentRunId === claim.parentRunId &&
    linkage.parentStepId === claim.parentStepId &&
    linkage.tokenHash === claim.tokenHash
  );
}

/**
 * Manages runbook session stacks and stash operations.
 *
 * Provides a single active runbook stack and a single
 * stash slot for temporarily parking a runbook. Follows the same
 * constructor-injection pattern as {@link RunbookActorService}.
 */
export class SessionService {
  private readonly lock: SessionLock;

  /**
   * Create a new SessionService.
   *
   * @param manager - State manager for raw session and state persistence
   * @param lock - Optional pre-built session lock (defaults to one bound to `manager.cwd`)
   */
  constructor(
    private readonly manager: RunbookStateManager,
    lock?: SessionLock,
  ) {
    this.lock = lock ?? new SessionLock(manager.cwd);
  }

  /**
   * Run a load-modify-save mutation under the workspace session lock.
   *
   * Read-only methods bypass the lock — the worst case is a slightly stale snapshot.
   * Mutations must always go through this helper so concurrent CLI processes
   * cannot lose interleaved writes to `.rundown/session.json`.
   *
   * @param fn - Async mutation to execute while the session lock is held
   * @returns The value returned by `fn`
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.lock.acquire();
    // Best-effort scoped release: a failed unlink only leaks a self-healing lock
    // and must never mask the committed session mutation that `fn()` returns.
    await using _guard = this.lock.held();
    return await fn();
  }

  private findClaimByChildRunId(
    claims: Record<string, ClaimRecord>,
    childRunId: RunId,
  ): ClaimRecord | undefined {
    return Object.values(claims).find((claim) => claim.childRunId === childRunId);
  }

  private findClaimByDelegationLinkage(
    claims: Record<string, ClaimRecord>,
    linkage: DelegationLinkage,
  ): ClaimRecord | undefined {
    return Object.values(claims).find(
      (claim) =>
        claim.parentRunId === linkage.parentRunId &&
        claim.parentStepId === linkage.parentStepId &&
        claim.tokenHash === linkage.tokenHash,
    );
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
   * Read-only: bypasses the session lock (consistent with {@link getActive}).
   * Resolves only ids present on the session `defaultStack` (any depth) —
   * `--run` names authority over a run this session is orchestrating;
   * cross-session work stays claim-based. Claimed children are never stack
   * members, so `--run` can never substitute for `--claim-id`.
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
   * Read-only: bypasses the session lock (consistent with {@link getRunById},
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
   * Resolve a run capability to a running session-stack member.
   *
   * @param capability - Run capability presented by the caller
   * @returns `running` only when the embedded run id is active and the secret
   * matches the persisted run capability hash
   */
  async resolveRunningStackMemberByCapability(
    capability: RunCapability,
  ): Promise<RunningStackMemberResolution> {
    const parsed = parseRunCapability(capability);
    const resolved = await this.resolveRunningStackMember(parsed.runId);
    if (resolved.kind !== 'running') return resolved;
    const expected = resolved.state.orchestratorCapabilityHash;
    if (expected === undefined || !verifyCapabilitySecret(parsed.secret, expected)) {
      return { kind: 'not_on_stack' };
    }
    return resolved;
  }

  /**
   * Refresh an active claim lease after verifying the presented claim capability.
   *
   * @param capability - Claim capability held by the delegated child
   * @returns Refreshed claim record, or missing when the claim is absent or proof fails
   */
  async refreshClaimLease(
    capability: ClaimCapability,
  ): Promise<
    | { readonly status: 'refreshed'; readonly claim: ClaimRecord }
    | { readonly status: 'missing'; readonly claimId: ClaimId }
  > {
    return this.withLock(async () => {
      const parsed = parseClaimCapability(capability);
      const session = await this.manager.loadSession();
      const claim = readClaimRecord(session.claims, parsed.claimId);
      if (claim === undefined) {
        return { status: 'missing', claimId: parsed.claimId };
      }
      const expected = claim.claimCapabilityHash;
      if (expected === undefined || !verifyCapabilitySecret(parsed.secret, expected)) {
        return { status: 'missing', claimId: parsed.claimId };
      }
      const now = new Date().toISOString();
      const refreshed: ClaimRecord = {
        ...claim,
        leaseHeartbeatAt: now,
        leaseExpiresAt: new Date(Date.parse(now) + CLAIM_LEASE_MS).toISOString(),
        updatedAt: now,
      };
      session.claims[parsed.claimId] = refreshed;
      await this.manager.saveSession(session);
      return { status: 'refreshed', claim: refreshed };
    });
  }

  /**
   * Release an abandoned claim through an explicit operator recovery action.
   *
   * This does not record a child outcome. It only removes the claim routing
   * record so the parent-side operator can recover from a child that no longer
   * holds or can present its claim capability.
   *
   * @param claimId - Printed claim id to release
   * @param reason - Explicit operator recovery reason
   * @returns Released claim record, or missing when the claim does not exist
   */
  async operatorReleaseClaim(
    claimId: ClaimId,
    reason: 'abandoned-child',
  ): Promise<
    | {
        readonly status: 'released';
        readonly claim: ClaimRecord;
        readonly reason: 'abandoned-child';
      }
    | { readonly status: 'missing'; readonly claimId: ClaimId }
  > {
    return this.withLock(async () => {
      const session = await this.manager.loadSession();
      const claim = readClaimRecord(session.claims, claimId);
      if (claim === undefined) return { status: 'missing', claimId };
      delete session.claims[claimId];
      await this.manager.saveSession(session);
      return { status: 'released', claim, reason };
    });
  }

  /**
   * List open claims for a parent whose leases have expired.
   *
   * @param parentRunId - Parent run whose delegated children should be inspected
   * @param now - Time used for expiry comparison
   * @returns Expired open claim records
   */
  async listExpiredOpenClaimsForParent(
    parentRunId: RunId,
    now: Date = new Date(),
  ): Promise<ClaimRecord[]> {
    const openClaims = await this.listOpenClaimsForParent(parentRunId);
    const nowMs = now.getTime();
    return openClaims.filter((claim) => Date.parse(claim.leaseExpiresAt ?? '') <= nowMs);
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
    await this.withLock(async () => {
      const session = await this.manager.loadSession();
      session.defaultStack.push(id);
      await this.manager.saveSession(session);
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
    return this.withLock(async () => {
      const session = await this.manager.loadSession();
      return this.findClaimByDelegationLinkage(session.claims, linkage) ?? null;
    });
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
  async claimRunbook(childRunId: RunId, linkage: DelegationLinkage): Promise<ClaimRunbookResult> {
    return this.withLock(async () => {
      const session = await this.manager.loadSession();
      const now = new Date().toISOString();
      const existingForDelegation = this.findClaimByDelegationLinkage(session.claims, linkage);
      if (existingForDelegation !== undefined) {
        const existingState = await this.manager.load(existingForDelegation.childRunId);
        if (!existingState) {
          return { status: 'missing-child', childRunId: existingForDelegation.childRunId };
        }
        if (existingState.lifecycle === 'completed' || existingState.lifecycle === 'stopped') {
          return {
            status: 'terminal-child',
            childRunId: existingForDelegation.childRunId,
            lifecycle: existingState.lifecycle,
          };
        }
        if (!linkageMatchesLinkage(existingState.parentLinkage, linkage)) {
          return {
            status: 'linkage-mismatch',
            childRunId: existingForDelegation.childRunId,
            incoming: linkage,
            persisted: existingState.parentLinkage,
          };
        }
        const { claimCapability, claimCapabilityHash } = mintClaimCapability(
          existingForDelegation.claimId,
        );
        const refreshed = {
          ...existingForDelegation,
          claimCapabilityHash,
          leaseOwnerHash: claimCapabilityHash,
          leaseHeartbeatAt: now,
          leaseExpiresAt: new Date(Date.parse(now) + CLAIM_LEASE_MS).toISOString(),
          updatedAt: now,
        };
        session.claims[existingForDelegation.claimId] = refreshed;
        await this.manager.saveSession(session);
        return { status: 'claimed', claim: refreshed, claimCapability };
      }

      const childState = await this.manager.load(childRunId);
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
        const { claimCapability, claimCapabilityHash } = mintClaimCapability(existing.claimId);
        const refreshed = {
          ...existing,
          claimCapabilityHash,
          leaseOwnerHash: claimCapabilityHash,
          leaseHeartbeatAt: now,
          leaseExpiresAt: new Date(Date.parse(now) + CLAIM_LEASE_MS).toISOString(),
          updatedAt: now,
        };
        session.claims[existing.claimId] = refreshed;
        await this.manager.saveSession(session);
        return { status: 'claimed', claim: refreshed, claimCapability };
      }

      const claimId = generateClaimId();
      const { claimCapability, claimCapabilityHash } = mintClaimCapability(claimId);
      const claim = createClaimRecord(
        claimId,
        childRunId,
        linkage,
        now,
        claimCapabilityHash,
        new Date(Date.parse(now) + CLAIM_LEASE_MS).toISOString(),
      );
      session.claims[claimId] = claim;
      await this.manager.saveSession(session);
      return { status: 'claimed', claim, claimCapability };
    });
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
    const session = await this.manager.loadSession();
    if (!(claimId in session.claims)) {
      return { status: 'missing', claimId };
    }
    const claim = session.claims[claimId];

    if (options.includeStashed !== true && session.stashedRunbookId === claim.childRunId) {
      return { status: 'unlinked', claim, reason: 'stashed' };
    }

    const state = await this.manager.load(claim.childRunId);
    if (!state) {
      return { status: 'stale', claim, reason: 'missing-state' };
    }
    if (state.lifecycle === 'completed' || state.lifecycle === 'stopped') {
      return { status: 'terminal', claim, state, lifecycle: state.lifecycle };
    }
    if (!linkageMatchesClaim(state.parentLinkage, claim)) {
      return { status: 'unlinked', claim, reason: 'child-linkage-mismatch' };
    }

    const parent = await this.manager.load(claim.parentRunId);
    if (!parent) {
      return { status: 'unlinked', claim, reason: 'parent-missing' };
    }
    if (parent.lifecycle === 'completed' || parent.lifecycle === 'stopped') {
      return { status: 'unlinked', claim, reason: 'parent-ended' };
    }

    return { status: 'claimed', claim, state };
  }

  /**
   * Resolve a claim capability to an active child runbook after verifying its secret proof.
   *
   * @param capability - Claim capability presented by the caller
   * @param options - Optional resolution flags
   * @param options.includeStashed - When true, do not gate on the stashed runbook
   * @returns Claim resolution when the capability verifies, otherwise `missing`
   */
  async getActiveForClaimCapability(
    capability: ClaimCapability,
    options: { readonly includeStashed?: boolean } = {},
  ): Promise<ClaimIdResolution> {
    const parsed = parseClaimCapability(capability);
    const resolved = await this.getActiveForClaimId(parsed.claimId, options);
    if (!('claim' in resolved)) {
      return { status: 'missing', claimId: parsed.claimId };
    }
    if (
      resolved.claim.claimCapabilityHash === undefined ||
      !verifyCapabilitySecret(parsed.secret, resolved.claim.claimCapabilityHash)
    ) {
      return { status: 'missing', claimId: parsed.claimId };
    }
    return resolved;
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
   * Read-only: bypasses the session lock (consistent with getActiveForClaimId).
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
      if (claim.parentRunId !== parentRunId) {
        continue;
      }

      const child = await this.manager.load(claim.childRunId);
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
        claim.parentStepId,
        claim.parentFrameKey,
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
   * Holds the session lock across (1) re-validating that the parent has no open
   * claimed children and (2) the supplied decisive advance write. Because
   * {@link claimRunbook} also runs under the same lock, a concurrent claim
   * cannot slip between the check and the write: either the claim commits first
   * (this re-check sees it and refuses) or the advance commits first (the later
   * claim still records, but it now lands against an already-resolved substep, so
   * {@link listOpenClaimsForParent} stops counting it as open and it cannot wedge
   * future bare parent transitions). Together these close the check-then-act
   * TOCTOU on the open-delegated-children guard.
   *
   * The `advance` callback MUST perform only the decisive transition write
   * (e.g. `RunbookCompletionService.recordManualCompletion` or
   * `RunbookActorService.sendAndSync`) — neither acquires the session lock.
   * Nesting any session-lock'd call here would self-deadlock, since the lock is
   * non-reentrant. Downstream drain/release steps run outside this critical
   * section.
   *
   * @template T - Result type of the decisive advance write
   * @param parentRunId - Parent runbook whose advance must be guarded
   * @param advance - Decisive transition write, run under the lock only when no
   *   open claimed children remain
   * @returns `{ kind: 'advanced', value }` carrying the callback result;
   *   `{ kind: 'delegation_collection_pending', parentRunId, outcomeCompletionKeys, message }`
   *   when a reported delegation outcome is still waiting for collection; or
   *   `{ kind: 'open_delegated_children', claims }` when the advance was refused
   *   by an open claimed child
   */
  async runGuardedParentAdvance<T>(
    parentRunId: RunId,
    advance: () => Promise<T>,
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
    return this.withLock(async () => {
      const parentState = await this.manager.load(parentRunId);
      if (parentState) {
        const collectionPending = readDelegationCollectionPendingForPolicy(parentState);
        if (collectionPending.pending) {
          return {
            kind: 'delegation_collection_pending',
            parentRunId,
            outcomeCompletionKeys: collectionPending.outcomes.map(
              (outcome) => outcome.completionKey,
            ),
            message: DELEGATION_COLLECTION_PENDING_MESSAGE,
          };
        }
      }
      const openClaims = await this.listOpenClaimsForParent(parentRunId);
      if (openClaims.length > 0) {
        return { kind: 'open_delegated_children', claims: openClaims };
      }
      return { kind: 'advanced', value: await advance() };
    });
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
   * Read-only: bypasses the session lock (consistent with {@link getActive}).
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
   * mutation, composed from {@link releaseRunbookLocked} under a single lock.
   *
   * Used by the inline force-terminal cascade to tear down the whole active
   * inline chain after every member reached terminal lifecycle. This is explicit
   * teardown of default-stack inline composition, not natural claim completion,
   * so `retainClaimsAsTerminal` is intentionally not applied here.
   *
   * @param runbookIds - Run ids to release, in descendant-to-root order.
   * @returns The released run ids and the next default-stack runbook id, if any.
   */
  async releaseRunbooks(runbookIds: readonly RunId[]): Promise<ReleaseRunbooksResult> {
    return this.withLock(async () => {
      const releasedRunIds: RunId[] = [];
      for (const runbookId of runbookIds) {
        const released = await this.releaseRunbookLocked(runbookId);
        if (released.status === 'released') {
          releasedRunIds.push(runbookId);
        }
      }

      const session = await this.manager.loadSession();

      return {
        releasedRunIds,
        nextDefaultRunbookId: session.defaultStack[session.defaultStack.length - 1] ?? null,
      };
    });
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
  ): Promise<ReleaseRunbookResult> {
    return this.withLock(() => this.releaseRunbookLocked(runbookId, options));
  }

  /**
   * Remove claim records whose child run is among `childRunIds`.
   *
   * Folds tombstone GC into pruning: when a terminal child run is deleted, its
   * retained claim tombstone is no longer meaningful and is removed alongside it.
   *
   * @param childRunIds - Child run ids being pruned.
   * @returns The claim ids that were removed.
   */
  async pruneClaimsForChildren(childRunIds: readonly string[]): Promise<ClaimId[]> {
    return this.withLock(async () => {
      const targets = new Set<string>(childRunIds);
      const session = await this.manager.loadSession();
      const removed: ClaimId[] = [];
      for (const [claimId, claim] of Object.entries(session.claims)) {
        if (targets.has(claim.childRunId)) {
          removed.push(claimId as ClaimId);
          delete session.claims[claimId];
        }
      }
      if (removed.length > 0) {
        await this.manager.saveSession(session);
      }
      return removed;
    });
  }

  /**
   * Inner load-modify-save for releaseRunbook. Caller must hold the session lock.
   *
   * @param runbookId - Runbook id to release from session targeting structures
   * @param options - Release options (see {@link releaseRunbook})
   * @param options.retainClaimsAsTerminal - When true, retain matching claim
   *   records as terminal tombstones instead of deleting them.
   * @returns Structured release result describing what was removed
   */
  private async releaseRunbookLocked(
    runbookId: RunId,
    options: { readonly retainClaimsAsTerminal?: boolean } = {},
  ): Promise<ReleaseRunbookResult> {
    const session = await this.manager.loadSession();

    const originalDefaultStackLength = session.defaultStack.length;
    session.defaultStack = session.defaultStack.filter((id) => id !== runbookId);
    const removedFromDefaultStack = session.defaultStack.length !== originalDefaultStackLength;

    const removedClaimIds: string[] = [];
    const retainedClaimIds: string[] = [];
    for (const [claimId, claim] of Object.entries(session.claims)) {
      if (claim.childRunId === runbookId) {
        if (options.retainClaimsAsTerminal) {
          // Leave the record in place as a terminal tombstone so
          // getActiveForClaimId resolves `terminal` (not `missing`). Pruned
          // alongside the child run by `rd prune`.
          retainedClaimIds.push(claimId);
        } else {
          removedClaimIds.push(claimId);
          delete session.claims[claimId];
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

    await this.manager.saveSession(session);
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
  async popRunbook(): Promise<RunId | null> {
    return this.withLock(async () => {
      const session = await this.manager.loadSession();
      const topId = session.defaultStack[session.defaultStack.length - 1];
      if (!topId) return null;
      const released = await this.releaseRunbookLocked(topId);
      return released.status === 'released' ? released.nextDefaultRunbookId : null;
    });
  }

  /**
   * Stash the currently active runbook to allow temporarily switching contexts.
   *
   * Removes the active runbook from the stack and stores its ID
   * in the session's stashed slot. Only one runbook can be stashed at a time.
   *
   * @returns The stashed runbook ID, or null if no runbook was active or a stash already exists
   */
  async stash(): Promise<RunId | null> {
    return this.withLock(async () => {
      const session = await this.manager.loadSession();

      // Refuse to overwrite an existing stash — caller must unstash first
      if (session.stashedRunbookId) return null;

      const stack = session.defaultStack;
      if (stack.length === 0) return null;
      const activeId = stack.pop();

      if (!activeId) return null;

      session.stashedRunbookId = activeId;
      await this.manager.saveSession(session);

      return activeId;
    });
  }

  /**
   * Stash a specific runbook id from any session targeting structure.
   *
   * @param runbookId - Runbook id to move into the single session stash slot
   * @returns The stashed runbook id, or null if no slot is available or the runbook was not targeted
   */
  async stashRunbook(runbookId: RunId): Promise<RunId | null> {
    return this.withLock(async () => {
      const session = await this.manager.loadSession();
      if (session.stashedRunbookId) return null;

      const originalDefaultStackLength = session.defaultStack.length;
      session.defaultStack = session.defaultStack.filter((id) => id !== runbookId);
      const removedFromDefaultStack = session.defaultStack.length !== originalDefaultStackLength;

      const targetedByClaim = Object.values(session.claims).some(
        (claim) => claim.childRunId === runbookId,
      );

      if (!removedFromDefaultStack && !targetedByClaim) return null;

      session.stashedRunbookId = runbookId;
      await this.manager.saveSession(session);
      return runbookId;
    });
  }

  /**
   * Restore a stashed delegated runbook by explicit claim id.
   *
   * @param claimId - Claim id for the stashed child runbook
   * @returns Discriminated restore result describing success or the refusal reason
   */
  async unstashForClaimId(claimId: ClaimId): Promise<UnstashForClaimIdResult> {
    return this.withLock(async () => {
      const session = await this.manager.loadSession();
      if (!(claimId in session.claims)) {
        return { status: 'missing-claim', claimId };
      }
      const claim = session.claims[claimId];
      if (session.stashedRunbookId !== claim.childRunId) {
        return { status: 'not-stashed', claim };
      }

      const state = await this.manager.load(claim.childRunId);
      if (!state) {
        return { status: 'missing-child', claim };
      }
      if (state.lifecycle === 'completed' || state.lifecycle === 'stopped') {
        return { status: 'terminal-child', claim, lifecycle: state.lifecycle };
      }
      if (!linkageMatchesClaim(state.parentLinkage, claim)) {
        return { status: 'child-linkage-mismatch', claim };
      }
      const parent = await this.manager.load(claim.parentRunId);
      if (!parent) {
        return { status: 'parent-missing', claim };
      }
      if (parent.lifecycle === 'completed' || parent.lifecycle === 'stopped') {
        return { status: 'parent-ended', claim, lifecycle: parent.lifecycle };
      }

      session.stashedRunbookId = undefined;
      session.claims[claimId] = { ...claim, updatedAt: new Date().toISOString() };
      await this.manager.saveSession(session);
      return { status: 'restored', claim: session.claims[claimId], state };
    });
  }

  /**
   * Unstash a previously stashed runbook to the active stack.
   *
   * Retrieves the stashed runbook ID and pushes it back onto the
   * stack, making it the active runbook again. Clears the stashed slot.
   *
   * @returns The restored runbook state, or null if nothing was stashed or runbook not found
   */
  async unstash(): Promise<RunbookState | null> {
    return this.withLock(async () => {
      const session = await this.manager.loadSession();
      const stashedId = session.stashedRunbookId;

      if (!stashedId) return null;

      const targetedByClaim = Object.values(session.claims).some(
        (claim) => claim.childRunId === stashedId,
      );
      if (targetedByClaim) {
        return null;
      }

      const state = await this.manager.load(stashedId);
      if (!state) {
        session.stashedRunbookId = undefined;
        await this.manager.saveSession(session);
        return null;
      }

      // Push back to stack
      session.defaultStack.push(stashedId);
      session.stashedRunbookId = undefined;
      await this.manager.saveSession(session);

      return state;
    });
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
