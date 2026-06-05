// src/runbook/execution-lifecycle-service.ts
import type { RunbookStateManager } from './state.js';
import { merge, replace } from './state-update-ops.js';
import {
  SENTINEL_ENTRY,
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  completionEntryForFrame,
  deriveActiveFrame,
  inactiveFrame,
  parseCompletionKey,
  type Frame,
  type FrameKey,
} from './targeting.js';
import type { ResolvedCompletion, RunbookState } from './types.js';

/**
 * Service for execution-flow helpers that read/write specific fields
 * on persisted runbook state.
 *
 * Encapsulates operations like recording step results, querying runbook
 * status, and managing resolved completions. Each method delegates
 * to {@link RunbookStateManager.update} or {@link RunbookStateManager.load}
 * internally.
 */
export class ExecutionLifecycleService {
  /**
   * Create a new ExecutionLifecycleService.
   *
   * @param manager - State manager for raw state persistence
   */
  constructor(private readonly manager: RunbookStateManager) {}

  /**
   * Set the last result (pass/fail) for a runbook step.
   *
   * @param id - The runbook state ID
   * @param result - The result to record ('pass' or 'fail')
   * @throws {Error} If the runbook with the given ID is not found
   */
  async setLastResult(id: string, result: 'pass' | 'fail'): Promise<void> {
    await this.manager.update(id, { lastResult: result });
  }

  /**
   * Clear the last result display field after a non-result transition.
   *
   * GOTO is a navigation action, not a pass/fail result. Clearing this field in
   * core prevents stale PASS/FAIL status from leaking into CLI status rendering
   * without requiring the CLI to rewrite machine-owned lastAction data.
   *
   * @param id - The runbook state ID
   * @throws {Error} If the runbook with the given ID is not found
   */
  async clearLastResult(id: string): Promise<void> {
    await this.manager.update(id, { lastResult: undefined });
  }

  /**
   * Check if a runbook was started in prompted mode.
   *
   * @param runbookId - The runbook state ID to check
   * @returns True if the runbook has prompted flag set, false otherwise
   */
  async isPrompted(runbookId: string): Promise<boolean> {
    const state = await this.manager.load(runbookId);
    return state?.prompted ?? false;
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
  ): Promise<{ state: RunbookState; frameKey: FrameKey; entry: number }> {
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
      frameEntries: replace(frameEntries),
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
    await this.manager.update(id, {
      resolvedCompletions: merge({ [key]: completion }),
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
    let consumed: ResolvedCompletion | null = null;

    await this.manager.updateWithStateIfExists(id, (state) => {
      let existing = state.resolvedCompletions?.[key];
      let actualKey = key;

      // Fall back to sentinel entry if exact key not found
      if (!existing) {
        const parsed = parseCompletionKey(key);
        if (parsed && parsed.entry !== SENTINEL_ENTRY) {
          const sentinelKey = buildCompletionKey(inactiveFrame(parsed.frameKey), parsed.substep);
          const sentinelMatch = state.resolvedCompletions?.[sentinelKey];
          if (sentinelMatch) {
            existing = sentinelMatch;
            actualKey = sentinelKey;
          }
        }
      }

      if (!existing) return null;

      consumed = existing;
      const next = { ...(state.resolvedCompletions ?? {}) };
      delete next[actualKey];
      return {
        resolvedCompletions: replace(next),
      };
    });

    return consumed;
  }

  /**
   * List resolved completions for a frame target.
   *
   * @param id - The runbook state ID
   * @param frame - Frame target to list
   * @returns Array of key/completion pairs matching the frame target
   */
  async listResolvedCompletions(
    id: string,
    frame: Frame,
  ): Promise<ReadonlyArray<{ key: string; completion: ResolvedCompletion }>> {
    const state = await this.manager.load(id);
    if (!state) return [];

    const entry = completionEntryForFrame(frame);
    const exactPrefix = `${frame.frameKey}|${String(entry)}|`;
    const sentinelPrefix = `${frame.frameKey}|${String(SENTINEL_ENTRY)}|`;
    return Object.entries(state.resolvedCompletions ?? {})
      .filter(([key]) => {
        if (frame.kind === 'active') {
          return key.startsWith(exactPrefix) || key.startsWith(sentinelPrefix);
        }
        return key.startsWith(exactPrefix);
      })
      .map(([key, completion]) => ({ key, completion }));
  }

  /**
   * Observe all persisted completions for a frame key across entries.
   *
   * @param id - The runbook state ID
   * @param frameKey - Frame key to observe
   * @returns Array of key/completion pairs with matching persisted target frame
   */
  async listResolvedCompletionsForFrameObservation(
    id: string,
    frameKey: FrameKey,
  ): Promise<ReadonlyArray<{ key: string; completion: ResolvedCompletion }>> {
    const state = await this.manager.load(id);
    if (!state) return [];

    return Object.entries(state.resolvedCompletions ?? {})
      .filter(([, completion]) => completion.targetFrameKey === frameKey)
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
    const frameKey = state.activeFrameKey ?? frame.frameKey;
    return buildCompletionKey(activeFrame(frameKey, state.activeEntry ?? 1), substep);
  }

  /**
   * Resolve frame key from canonical target identity.
   *
   * @param targetStep - Target step identifier
   * @param targetIteration - Optional FOR loop iteration number
   * @returns Pipe-delimited frame key
   */
  buildTargetFrameKey(targetStep: string, targetIteration?: number): FrameKey {
    return buildFrameKey(targetStep, targetIteration);
  }

  /**
   * Parse completion key helper for callers that need frame/entry extraction.
   *
   * @param key - Pipe-delimited completion key to parse
   * @returns Parsed components, or null if the key format is invalid
   */
  parseCompletionKey(key: string): { frameKey: FrameKey; entry: number; substep?: string } | null {
    return parseCompletionKey(key);
  }

  /**
   * Get the result of a child runbook execution.
   *
   * Determines the result based on the child runbook's lifecycle field:
   * - Returns 'fail' if lifecycle is 'stopped'
   * - Returns 'pass' if lifecycle is 'completed' or runbook not found
   * - Returns null if the runbook is still in progress
   *
   * @param childId - The child runbook state ID
   * @returns 'pass', 'fail', or null if still in progress
   */
  async getChildRunbookResult(childId: string): Promise<'pass' | 'fail' | null> {
    const child = await this.manager.load(childId);
    if (!child) return 'pass';

    if (child.lifecycle === 'stopped') return 'fail';
    if (child.lifecycle === 'completed') return 'pass';

    return null;
  }
}
