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
import {
  buildAgentOwnerKey,
  createAgentRunbookOwnership,
  type AgentOwnerIdentity,
  type AgentOwnerKey,
  type AgentRunbookOwnership,
  type OwnedRunbookResolution,
  type ReleaseRunbookResult,
} from './agent-ownership.js';
import type { DelegationLinkage, RunbookState } from './types.js';

/**
 * Manages runbook session stacks and stash operations.
 *
 * Provides a single active runbook stack and a single
 * stash slot for temporarily parking a runbook. Follows the same
 * constructor-injection pattern as {@link RunbookActorService}.
 */
export class SessionService {
  /**
   * Create a new SessionService.
   *
   * @param manager - State manager for raw session and state persistence
   */
  constructor(private readonly manager: RunbookStateManager) {}

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
    const session = await this.manager.loadSession();
    session.defaultStack.push(id);
    await this.manager.saveSession(session);
  }

  /**
   * Record that a caller owns a delegated child runbook.
   *
   * @param identity - Caller identity that claimed the delegation
   * @param childRunId - Child run id created or reused by claim
   * @param linkage - Delegation linkage written to the child state
   * @returns Persisted ownership record
   */
  async claimRunbookForOwner(
    identity: AgentOwnerIdentity,
    childRunId: RunbookState['id'],
    linkage: DelegationLinkage,
  ): Promise<ReturnType<typeof createAgentRunbookOwnership>> {
    const session = await this.manager.loadSession();
    const now = new Date().toISOString();
    const ownership = createAgentRunbookOwnership(identity, childRunId, linkage, now);
    session.ownedRunbooks[ownership.ownerKey] = ownership;
    await this.manager.saveSession(session);
    return ownership;
  }

  /**
   * Resolve the active runbook owned by a caller without falling back to the default stack.
   *
   * @param identity - Caller identity
   * @returns Owned, unowned, or stale resolution result
   */
  async getActiveForOwner(identity: AgentOwnerIdentity): Promise<OwnedRunbookResolution> {
    const session = await this.manager.loadSession();
    const ownerKey = buildAgentOwnerKey(identity);
    const ownership = Object.entries(session.ownedRunbooks).find(([key]) => key === ownerKey)?.[1];
    if (!ownership) {
      return { status: 'unowned', identity };
    }
    if (ownership.agent_id !== identity.agent_id) {
      return { status: 'stale', identity, ownership, reason: 'agent-mismatch' };
    }

    const state = await this.manager.load(ownership.childRunId);
    if (!state) {
      return { status: 'stale', identity, ownership, reason: 'missing-state' };
    }
    if (state.lifecycle !== 'running') {
      return { status: 'stale', identity, ownership, reason: 'not-running' };
    }
    return { status: 'owned', identity, ownership, state };
  }

  /**
   * Release a runbook from all session targeting structures by id.
   *
   * @param runbookId - Runbook id to release
   * @returns Structured release result
   */
  async releaseRunbook(runbookId: RunbookState['id']): Promise<ReleaseRunbookResult> {
    const session = await this.manager.loadSession();

    const originalDefaultStackLength = session.defaultStack.length;
    session.defaultStack = session.defaultStack.filter((id) => id !== runbookId);
    const removedFromDefaultStack = session.defaultStack.length !== originalDefaultStackLength;

    const removedOwnerKeys: AgentOwnerKey[] = [];
    for (const [ownerKey, ownership] of Object.entries(session.ownedRunbooks)) {
      if (ownership.childRunId === runbookId) {
        delete session.ownedRunbooks[ownerKey];
        removedOwnerKeys.push(ownerKey as AgentOwnerKey);
      }
    }

    if (!removedFromDefaultStack && removedOwnerKeys.length === 0) {
      return { status: 'not-found', runbookId };
    }

    await this.manager.saveSession(session);
    return {
      status: 'released',
      runbookId,
      removedFromDefaultStack,
      removedOwnerKeys,
      nextDefaultRunbookId: session.defaultStack[session.defaultStack.length - 1] ?? null,
    };
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
    const session = await this.manager.loadSession();
    const topId = session.defaultStack[session.defaultStack.length - 1];
    if (!topId) return null;
    const released = await this.releaseRunbook(topId);
    return released.status === 'released' ? released.nextDefaultRunbookId : null;
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
  }

  /**
   * Stash a specific runbook id from any session targeting structure.
   *
   * @param runbookId - Runbook id to move into the single session stash slot
   * @returns The stashed runbook id, or null if no slot is available or the runbook was not targeted
   */
  async stashRunbook(runbookId: RunbookState['id']): Promise<string | null> {
    const session = await this.manager.loadSession();
    if (session.stashedRunbookId) return null;

    const originalDefaultStackLength = session.defaultStack.length;
    session.defaultStack = session.defaultStack.filter((id) => id !== runbookId);
    const removedFromDefaultStack = session.defaultStack.length !== originalDefaultStackLength;

    let removedOwnership: AgentRunbookOwnership | undefined;
    for (const [ownerKey, ownership] of Object.entries(session.ownedRunbooks)) {
      if (ownership.childRunId === runbookId) {
        delete session.ownedRunbooks[ownerKey];
        removedOwnership = ownership;
      }
    }

    if (!removedFromDefaultStack && !removedOwnership) return null;

    session.stashedRunbookId = runbookId;
    if (removedOwnership) {
      session.stashedRunbookOwnership = removedOwnership;
    } else {
      session.stashedRunbookOwnership = undefined;
    }
    await this.manager.saveSession(session);
    return runbookId;
  }

  /**
   * Restore a stashed delegated runbook as owned by the given caller.
   *
   * @param identity - Caller identity that should own the restored delegated runbook
   * @param linkage - Delegation linkage from the stashed child state
   * @returns The restored runbook state, or null if no stashed runbook exists
   */
  async unstashForOwner(
    identity: AgentOwnerIdentity,
    linkage: DelegationLinkage,
  ): Promise<RunbookState | null> {
    const session = await this.manager.loadSession();
    const stashedId = session.stashedRunbookId;
    if (!stashedId) return null;

    const state = await this.manager.load(stashedId);
    if (!state) {
      session.stashedRunbookId = undefined;
      session.stashedRunbookOwnership = undefined;
      await this.manager.saveSession(session);
      return null;
    }

    const now = new Date().toISOString();
    const ownership = createAgentRunbookOwnership(identity, stashedId, linkage, now);
    session.stashedRunbookId = undefined;
    session.stashedRunbookOwnership = undefined;
    session.ownedRunbooks[ownership.ownerKey] = ownership;
    await this.manager.saveSession(session);
    return state;
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
    const session = await this.manager.loadSession();
    const stashedId = session.stashedRunbookId;

    if (!stashedId) return null;

    const state = await this.manager.load(stashedId);
    if (!state) {
      session.stashedRunbookId = undefined;
      session.stashedRunbookOwnership = undefined;
      await this.manager.saveSession(session);
      return null;
    }

    // Push back to stack
    session.defaultStack.push(stashedId);
    session.stashedRunbookId = undefined;
    session.stashedRunbookOwnership = undefined;
    await this.manager.saveSession(session);

    return state;
  }

  /**
   * Get the ownership record captured with the currently stashed runbook, if any.
   *
   * @returns Captured stashed ownership, or null for legacy/default-stack stashes
   */
  async getStashedRunbookOwnership(): Promise<AgentRunbookOwnership | null> {
    const session = await this.manager.loadSession();
    return session.stashedRunbookOwnership ?? null;
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
