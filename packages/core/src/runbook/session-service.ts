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
  createClaimRecord,
  generateClaimId,
  type ClaimId,
  type ClaimIdResolution,
  type ClaimRecord,
  type ClaimRunbookResult,
} from './claim-id.js';
import type { DelegationLinkage, RunbookState } from './types.js';

/** Result of removing a runbook from session targeting structures. */
export type ReleaseRunbookResult =
  | { readonly status: 'not-found'; readonly runbookId: RunId }
  | {
      readonly status: 'released';
      readonly runbookId: RunId;
      readonly removedFromDefaultStack: boolean;
      readonly nextDefaultRunbookId: RunId | null;
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
    try {
      return await fn();
    } finally {
      await this.lock.release();
    }
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
        const refreshed = { ...existingForDelegation, updatedAt: now };
        session.claims[existingForDelegation.claimId] = refreshed;
        await this.manager.saveSession(session);
        return { status: 'claimed', claim: refreshed };
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
        const refreshed = { ...existing, updatedAt: now };
        session.claims[existing.claimId] = refreshed;
        await this.manager.saveSession(session);
        return { status: 'claimed', claim: refreshed };
      }

      const claimId = generateClaimId();
      const claim = createClaimRecord(claimId, childRunId, linkage, now);
      session.claims[claimId] = claim;
      await this.manager.saveSession(session);
      return { status: 'claimed', claim };
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
   * Inner load-modify-save for releaseRunbook. Caller must hold the session lock.
   *
   * @param runbookId - Runbook id to release from session targeting structures
   * @param options - Release options (see {@link releaseRunbook})
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
