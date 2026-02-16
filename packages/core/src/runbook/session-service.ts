// packages/core/src/runbook/session-service.ts

/**
 * Session stack orchestration service for runbooks.
 *
 * Owns which runbook is active per-agent, push/pop lifecycle,
 * and stash/restore operations. Composes {@link RunbookStateManager}
 * for raw session persistence — does not own disk I/O.
 *
 * @module
 */

import type { RunbookState } from './types.js';
import type { RunbookStateManager } from './state.js';

/**
 * Manages runbook session stacks and stash operations.
 *
 * Provides per-agent isolation of active runbook stacks and a single
 * stash slot for temporarily parking a runbook. Follows the same
 * constructor-injection pattern as {@link RunbookActorService}.
 */
export class SessionService {
  /**
   * @param manager - State manager for raw session and state persistence
   */
  constructor(private readonly manager: RunbookStateManager) {}

  /**
   * Get the currently active runbook for an agent.
   *
   * Returns the top runbook from the agent's stack.
   *
   * @param agentId - Optional agent ID; if omitted, uses the default stack
   * @returns The active runbook state, or null if no runbook is active
   */
  async getActive(agentId?: string): Promise<RunbookState | null> {
    const session = await this.manager.loadSession();

    let stack: string[];
    if (agentId) {
      stack = session.stacks[agentId] ?? [];
    } else {
      stack = session.defaultStack;
    }

    const topId = stack[stack.length - 1];
    return topId ? await this.manager.load(topId) : null;
  }

  /**
   * Push a runbook onto an agent's runbook stack.
   *
   * Used when starting a new runbook or entering a nested/child runbook.
   * The pushed runbook becomes the active runbook for the agent.
   *
   * @param id - The runbook state ID to push
   * @param agentId - Optional agent ID; if omitted, uses the default stack
   */
  async pushRunbook(id: string, agentId?: string): Promise<void> {
    const session = await this.manager.loadSession();

    if (agentId) {
      const stack = session.stacks[agentId];
      if (stack) {
        stack.push(id);
      } else {
        session.stacks[agentId] = [id];
      }
    } else {
      session.defaultStack.push(id);
    }

    await this.manager.saveSession(session);
  }

  /**
   * Pop a runbook from an agent's runbook stack.
   *
   * Used when completing or stopping a runbook. Removes the top runbook
   * and returns the new top (parent runbook) ID if one exists.
   *
   * @param agentId - Optional agent ID; if omitted, uses the default stack
   * @returns The new active runbook ID (parent), or null if the stack is empty
   */
  async popRunbook(agentId?: string): Promise<string | null> {
    const session = await this.manager.loadSession();

    let stack: string[];
    if (agentId) {
      const existing = session.stacks[agentId];
      if (!existing || existing.length === 0) return null;
      existing.pop();
      if (existing.length === 0) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete session.stacks[agentId];
      }
      stack = existing;
    } else {
      stack = session.defaultStack;
      if (stack.length === 0) return null;
      stack.pop();
    }

    await this.manager.saveSession(session);

    // Return new top (parent runbook)
    return stack[stack.length - 1] ?? null;
  }

  /**
   * Stash the currently active runbook to allow temporarily switching contexts.
   *
   * Removes the active runbook from the agent's stack and stores its ID
   * in the session's stashed slot. Only one runbook can be stashed at a time.
   *
   * @param agentId - Optional agent ID; if omitted, uses the default stack
   * @returns The stashed runbook ID, or null if no runbook was active
   */
  async stash(agentId?: string): Promise<string | null> {
    const session = await this.manager.loadSession();

    let activeId: string | undefined;
    if (agentId) {
      const stack = session.stacks[agentId];
      if (!stack || stack.length === 0) return null;
      activeId = stack.pop();
    } else {
      const stack = session.defaultStack;
      if (stack.length === 0) return null;
      activeId = stack.pop();
    }

    if (!activeId) return null;

    session.stashedRunbookId = activeId;
    await this.manager.saveSession(session);

    return activeId;
  }

  /**
   * Unstash a previously stashed runbook to the active stack.
   *
   * Retrieves the stashed runbook ID and pushes it back onto the agent's
   * stack, making it the active runbook again. Clears the stashed slot.
   *
   * @param agentId - Optional agent ID; if omitted, uses the default stack
   * @returns The restored runbook state, or null if nothing was stashed or runbook not found
   */
  async unstash(agentId?: string): Promise<RunbookState | null> {
    const session = await this.manager.loadSession();
    const stashedId = session.stashedRunbookId;

    if (!stashedId) return null;

    const state = await this.manager.load(stashedId);
    if (!state) {
      session.stashedRunbookId = undefined;
      await this.manager.saveSession(session);
      return null;
    }

    // Push back to appropriate stack
    if (agentId) {
      const stack = session.stacks[agentId];
      if (stack) {
        stack.push(stashedId);
      } else {
        session.stacks[agentId] = [stashedId];
      }
    } else {
      session.defaultStack.push(stashedId);
    }

    session.stashedRunbookId = undefined;
    await this.manager.saveSession(session);

    return state;
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
