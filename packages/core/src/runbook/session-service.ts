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
import { SessionLock } from './session-lock.js';
import { type ReleaseRunbookResult } from './agent-ownership.js';
import {
  createClaimRecord,
  generateClaimId,
  type ClaimId,
  type ClaimIdResolution,
  type ClaimRecord,
  type ClaimRunbookResult,
} from './claim-id.js';
import type { DelegationLinkage, RunbookState } from './types.js';

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
    childRunId: RunbookState['id'],
  ): ClaimRecord | undefined {
    return Object.values(claims).find((claim) => claim.childRunId === childRunId);
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
  async pushRunbook(id: string): Promise<void> {
    await this.withLock(async () => {
      const session = await this.manager.loadSession();
      session.defaultStack.push(id);
      await this.manager.saveSession(session);
    });
  }

  /**
   * Record that a delegation token has been claimed for a child runbook.
   *
   * @param childRunId - Child run id created or reused by claim
   * @param linkage - Delegation linkage written to the child state
   * @returns Claim record for explicit child targeting
   */
  async claimRunbook(
    childRunId: RunbookState['id'],
    linkage: DelegationLinkage,
  ): Promise<ClaimRunbookResult> {
    return this.withLock(async () => {
      const session = await this.manager.loadSession();
      const now = new Date().toISOString();
      const existing = this.findClaimByChildRunId(session.claims, childRunId);
      if (existing !== undefined) {
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
   * @param claimId - Claim id returned by `rd claim`
   * @returns Claim resolution result
   */
  async getActiveForClaimId(claimId: ClaimId): Promise<ClaimIdResolution> {
    const session = await this.manager.loadSession();
    const claim = session.claims[claimId];
    if (claim === undefined) {
      return { status: 'missing', claimId };
    }

    const state = await this.manager.load(claim.childRunId);
    if (!state) {
      return { status: 'stale', claim, reason: 'missing-state' };
    }
    if (state.lifecycle === 'completed' || state.lifecycle === 'stopped') {
      return { status: 'terminal', claim, lifecycle: state.lifecycle };
    }
    if (
      state.parentLinkage?.kind !== 'delegation' ||
      state.parentLinkage.parentRunId !== claim.parentRunId ||
      state.parentLinkage.parentStepId !== claim.parentStepId ||
      state.parentLinkage.tokenHash !== claim.tokenHash
    ) {
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
   * @returns Structured release result
   */
  async releaseRunbook(runbookId: RunbookState['id']): Promise<ReleaseRunbookResult> {
    return this.withLock(() => this.releaseRunbookLocked(runbookId));
  }

  /**
   * Inner load-modify-save for releaseRunbook. Caller must hold the session lock.
   *
   * @param runbookId - Runbook id to release from session targeting structures
   * @returns Structured release result describing what was removed
   */
  private async releaseRunbookLocked(runbookId: RunbookState['id']): Promise<ReleaseRunbookResult> {
    const session = await this.manager.loadSession();

    const originalDefaultStackLength = session.defaultStack.length;
    session.defaultStack = session.defaultStack.filter((id) => id !== runbookId);
    const removedFromDefaultStack = session.defaultStack.length !== originalDefaultStackLength;

    const removedClaimIds: string[] = [];
    for (const [claimId, claim] of Object.entries(session.claims)) {
      if (claim.childRunId === runbookId) {
        removedClaimIds.push(claimId);
        delete session.claims[claimId];
      }
    }

    const removedFromStash = session.stashedRunbookId === runbookId;
    if (removedFromStash) {
      session.stashedRunbookId = undefined;
    }

    if (!removedFromDefaultStack && removedClaimIds.length === 0 && !removedFromStash) {
      return { status: 'not-found', runbookId } satisfies ReleaseRunbookResult;
    }

    await this.manager.saveSession(session);
    return {
      status: 'released',
      runbookId,
      removedFromDefaultStack,
      removedOwnerKeys: [],
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
  async popRunbook(): Promise<string | null> {
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
  async stash(): Promise<string | null> {
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
  async stashRunbook(runbookId: RunbookState['id']): Promise<string | null> {
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
   * @returns The restored runbook state, or null if no stashed runbook exists
   */
  async unstashForClaimId(claimId: ClaimId): Promise<RunbookState | null> {
    return this.withLock(async () => {
      const session = await this.manager.loadSession();
      const claim = session.claims[claimId];
      if (claim === undefined || session.stashedRunbookId !== claim.childRunId) {
        return null;
      }

      const state = await this.manager.load(claim.childRunId);
      if (!state || state.lifecycle !== 'running') {
        return null;
      }

      session.stashedRunbookId = undefined;
      session.claims[claimId] = { ...claim, updatedAt: new Date().toISOString() };
      await this.manager.saveSession(session);
      return state;
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
  async getStashedRunbookId(): Promise<string | null> {
    const session = await this.manager.loadSession();
    return session.stashedRunbookId ?? null;
  }
}
