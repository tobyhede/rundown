// src/runbook/execution-lifecycle-service.ts
import type { RunbookStateManager } from './state.js';
import {
  buildCompletionKey,
  deriveActiveFrame,
  buildFrameKey,
  parseCompletionKey,
} from './targeting.js';
import type { PendingStep, ResolvedCompletion, RunbookState } from './types.js';

/**
 * Service for execution-flow helpers that read/write specific fields
 * on persisted runbook state.
 *
 * Encapsulates operations like recording step results, querying parent/child
 * runbook status, and managing the pending-step queue. Each method delegates
 * to {@link RunbookStateManager.update} or {@link RunbookStateManager.load}
 * internally.
 */
export class ExecutionLifecycleService {
  /**
   * @param manager - State manager for raw state persistence
   */
  constructor(private readonly manager: RunbookStateManager) {}

  /**
   * Set the last result (pass/fail) for a runbook step.
   *
   * @param id - The runbook state ID
   * @param result - The result to record ('pass' or 'fail')
   * @throws Error if the runbook with the given ID is not found
   */
  async setLastResult(id: string, result: 'pass' | 'fail'): Promise<void> {
    await this.manager.update(id, { lastResult: result });
  }

  /**
   * Check if a parent runbook was started in prompted mode.
   *
   * @param parentRunbookId - The parent runbook state ID
   * @returns True if the parent runbook has prompted flag set, false otherwise
   */
  async isParentPrompted(parentRunbookId: string): Promise<boolean> {
    const parent = await this.manager.load(parentRunbookId);
    return parent?.prompted ?? false;
  }

  /**
   * Push a pending step onto the runbook's pending step queue.
   *
   * Pending steps are used to correlate Step tool dispatch with SubagentStart
   * events in orchestration scenarios.
   *
   * @param id - The runbook state ID
   * @param pending - The pending step to push (includes stepId and optional child runbook path)
   * @throws Error if the runbook with the given ID is not found
   * @remarks This method uses a load-then-update pattern. It is safe under
   * Rundown's single-process-per-runbook execution model but would need an
   * atomic update if concurrent access were introduced.
   */
  async pushPendingStep(id: string, pending: PendingStep): Promise<void> {
    const state = await this.manager.load(id);
    if (!state) throw new Error(`Runbook ${id} not found`);

    await this.manager.update(id, {
      pendingSteps: [...state.pendingSteps, pending],
    });
  }

  /**
   * Pop the first pending step from the runbook's pending step queue.
   *
   * @param id - The runbook state ID
   * @returns The first pending step, or null if the queue is empty or runbook not found
   * @remarks Uses load-then-update; safe under single-process execution.
   * See {@link pushPendingStep} for details.
   */
  async popPendingStep(id: string): Promise<PendingStep | null> {
    const state = await this.manager.load(id);
    if (!state || state.pendingSteps.length === 0) return null;

    const [first, ...rest] = state.pendingSteps;
    await this.manager.update(id, { pendingSteps: rest });
    return first;
  }

  /**
   * Ensure active frame/entry identity is initialized and current.
   *
   * Entry increments when execution enters a frame from another frame, or when
   * control-flow re-enters the same frame via GOTO/RETRY.
   *
   * @param id - The runbook state ID
   * @param previousState - State before a transition (optional)
   * @param nextState - State after a transition (optional)
   * @returns Persisted state with active frame/entry fields populated
   * @throws {Error} If the runbook with the given ID is not found
   */
  async ensureActiveEntry(
    id: string,
    previousState?: RunbookState,
    nextState?: RunbookState,
  ): Promise<{ state: RunbookState; frameKey: string; entry: number }> {
    const base = nextState ?? (await this.manager.load(id));
    if (!base) throw new Error(`Runbook ${id} not found`);

    const activeFrame = deriveActiveFrame(base);
    const previousFrame = previousState ? deriveActiveFrame(previousState) : undefined;

    const frameEntries = { ...(base.frameEntries ?? {}) };
    const knownEntry = frameEntries[activeFrame.frameKey] ?? 0;

    let entry = base.activeEntry ?? knownEntry;
    if (!entry || entry < 1) {
      entry = knownEntry > 0 ? knownEntry : 1;
    }

    const fromFrameKey = previousFrame?.frameKey;
    const toFrameKey = activeFrame.frameKey;
    const reenteredSameFrame =
      fromFrameKey === toFrameKey &&
      nextState !== undefined &&
      (nextState.lastAction?.type === 'GOTO' || nextState.lastAction?.type === 'RETRY');
    const switchedFrame =
      fromFrameKey !== undefined && toFrameKey !== fromFrameKey && nextState !== undefined;

    if (!base.activeFrameKey || base.activeEntry === undefined) {
      // First-time initialization: use known history or start at 1
      entry = knownEntry > 0 ? knownEntry : 1;
    } else if (reenteredSameFrame || switchedFrame) {
      // Bump entry on re-entry (GOTO/RETRY) or frame switch to isolate completion scopes
      entry = Math.max(knownEntry, entry) + 1;
    } else if (base.activeFrameKey !== toFrameKey) {
      // Frame key drift without explicit transition — also bumps to isolate scopes
      entry = Math.max(knownEntry, entry) + 1;
    }

    frameEntries[toFrameKey] = Math.max(frameEntries[toFrameKey] ?? 0, entry);

    const unchanged =
      base.activeFrameKey === toFrameKey &&
      base.activeEntry === entry &&
      (base.frameEntries?.[toFrameKey] ?? 0) === frameEntries[toFrameKey];
    if (unchanged) {
      return {
        state: {
          ...base,
          activeFrameKey: toFrameKey,
          activeEntry: entry,
          frameEntries,
        },
        frameKey: toFrameKey,
        entry,
      };
    }

    const updated = await this.manager.update(id, {
      activeFrameKey: toFrameKey,
      activeEntry: entry,
      frameEntries,
    });

    return { state: updated, frameKey: toFrameKey, entry };
  }

  /**
   * Store or replace a resolved completion keyed by canonical completion key.
   *
   * @param id - The runbook state ID
   * @param key - Canonical completion key (`frame|entry|substep`)
   * @param completion - Resolved completion payload
   * @throws {Error} If the runbook with the given ID is not found
   */
  async upsertResolvedCompletion(
    id: string,
    key: string,
    completion: ResolvedCompletion,
  ): Promise<void> {
    const state = await this.manager.load(id);
    if (!state) throw new Error(`Runbook ${id} not found`);

    await this.manager.update(id, {
      resolvedCompletions: {
        ...(state.resolvedCompletions ?? {}),
        [key]: completion,
      },
    });
  }

  /**
   * Read a resolved completion by key without consuming it.
   *
   * @param id - The runbook state ID
   * @param key - Canonical completion key (`frame|entry|substep`)
   * @returns The resolved completion if present, otherwise null
   */
  async getResolvedCompletion(id: string, key: string): Promise<ResolvedCompletion | null> {
    const state = await this.manager.load(id);
    if (!state) return null;
    return state.resolvedCompletions?.[key] ?? null;
  }

  /**
   * Consume (read and remove) a resolved completion by canonical completion key.
   *
   * @param id - The runbook state ID
   * @param key - Canonical completion key (`frame|entry|substep`)
   * @returns The resolved completion if present, otherwise null
   */
  async consumeResolvedCompletion(id: string, key: string): Promise<ResolvedCompletion | null> {
    const state = await this.manager.load(id);
    if (!state) return null;

    const existing = state.resolvedCompletions?.[key];
    if (!existing) return null;

    const next = { ...(state.resolvedCompletions ?? {}) };
    delete next[key];
    await this.manager.update(id, {
      resolvedCompletions: Object.keys(next).length > 0 ? next : {},
    });
    return existing;
  }

  /**
   * List resolved completions for a specific frame+entry.
   *
   * @param id - The runbook state ID
   * @param frameKey - Frame key (`step|iteration`)
   * @param entry - Frame entry number
   * @returns Array of key/completion pairs matching the frame+entry prefix
   */
  async listResolvedCompletions(
    id: string,
    frameKey: string,
    entry: number,
  ): Promise<ReadonlyArray<{ key: string; completion: ResolvedCompletion }>> {
    const state = await this.manager.load(id);
    if (!state) return [];

    const prefix = `${frameKey}|${String(entry)}|`;
    return Object.entries(state.resolvedCompletions ?? {})
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, completion]) => ({ key, completion }));
  }

  /**
   * Build a completion key for the active frame in a state.
   *
   * @param state - Current runbook state
   * @param substep - Optional substep identifier
   * @returns Canonical completion key for the active frame
   */
  buildActiveCompletionKey(state: RunbookState, substep?: string): string {
    const frame = deriveActiveFrame(state);
    const entry = state.activeEntry ?? 1;
    return buildCompletionKey(frame.frameKey, entry, substep);
  }

  /**
   * Resolve frame key from canonical target identity.
   *
   * @param targetStep - Target step identifier
   * @param targetIteration - Optional FOR loop iteration number
   * @returns Pipe-delimited frame key
   */
  buildTargetFrameKey(targetStep: string, targetIteration?: number): string {
    return buildFrameKey(targetStep, targetIteration);
  }

  /**
   * Parse completion key helper for callers that need frame/entry extraction.
   *
   * @param key - Pipe-delimited completion key to parse
   * @returns Parsed components, or null if the key format is invalid
   */
  parseCompletionKey(key: string): { frameKey: string; entry: number; substep?: string } | null {
    return parseCompletionKey(key);
  }

  /**
   * Get the result of a child runbook execution.
   *
   * Determines the result based on the child runbook's variables:
   * - Returns 'fail' if stopped is true
   * - Returns 'pass' if completed is true or runbook not found
   * - Returns null if the runbook is still in progress
   *
   * @param childId - The child runbook state ID
   * @returns 'pass', 'fail', or null if still in progress
   */
  async getChildRunbookResult(childId: string): Promise<'pass' | 'fail' | null> {
    const child = await this.manager.load(childId);
    if (!child) return 'pass';

    if (child.variables.stopped === true) return 'fail';
    if (child.variables.completed === true) return 'pass';

    return null;
  }
}
