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

import type { RunbookState } from './types.js';
import type { RunbookStateManager } from './state.js';

/**
 * Manages runbook session stacks and stash operations.
 *
 * Provides a single active runbook stack and a single
 * stash slot for temporarily parking a runbook. Follows the same
 * constructor-injection pattern as {@link RunbookActorService}.
 */
export class SessionService {
  /**
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
   * Pop a runbook from the active runbook stack.
   *
   * Used when completing or stopping a runbook. Removes the top runbook
   * and returns the new top (parent runbook) ID if one exists.
   *
   * @returns The new active runbook ID (parent), or null if the stack is empty
   */
  async popRunbook(): Promise<string | null> {
    const session = await this.manager.loadSession();
    if (session.defaultStack.length === 0) return null;
    session.defaultStack.pop();
    const parentRunbook = session.defaultStack[session.defaultStack.length - 1] ?? null;
    await this.manager.saveSession(session);
    return parentRunbook;
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
      await this.manager.saveSession(session);
      return null;
    }

    // Push back to stack
    session.defaultStack.push(stashedId);
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
