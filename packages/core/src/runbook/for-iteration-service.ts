// packages/core/src/runbook/for-iteration-service.ts

/**
 * Core service for FOR loop iteration lifecycle.
 *
 * Composes the source resolver with the state manager to provide a single
 * entry point for preparing each iteration. This creates a refactoring seam
 * between orchestration logic and persistence — the CLI calls one method
 * instead of directly manipulating actors, forStack, and snapshots.
 *
 * @module
 */

import type { Step, RunbookState } from './types.js';
import type { RunbookStateManager } from './state.js';
import { resolveForValue } from './source-resolver.js';
import { isRunbookComplete, isRunbookStopped } from './snapshot-utils.js';

/**
 * Result of preparing a FOR loop iteration.
 *
 * - `ready`: Value resolved, state updated — caller should re-enter the loop.
 * - `no-resolution-needed`: No dynamic source or value already populated — proceed to execution.
 * - `exhausted`: Data source depleted; `terminal` indicates how the machine exited.
 */
export type IterationResult =
  | { readonly status: 'ready'; readonly state: RunbookState }
  | { readonly status: 'no-resolution-needed'; readonly state: RunbookState }
  | {
      readonly status: 'exhausted';
      readonly state: RunbookState;
      readonly terminal?: 'complete' | 'stopped';
    };

/**
 * Service that owns the full "prepare iteration" lifecycle for FOR loops.
 *
 * Resolves the current iteration's value from any source type (range, array,
 * file), persists it, and handles exhaustion by sending PASS to the machine
 * to trigger the loop-exit guard.
 */
export class ForIterationService {
  /** @param manager - State manager for reading/writing runbook state */
  constructor(private readonly manager: RunbookStateManager) {}

  /**
   * Prepare the next FOR loop iteration.
   *
   * If the top of the forStack has an unresolved `currentValue` (i.e., the
   * machine advanced the iteration counter but the value hasn't been read),
   * this method resolves it and updates persisted state.
   *
   * If the data source is exhausted, it caps the loop and sends PASS to the
   * actor so the machine's exit guard fires.
   *
   * @param id - Runbook instance ID
   * @param steps - Parsed step definitions for actor creation
   * @returns An IterationResult indicating next action for the caller
   * @throws {Error} When state has no current step
   */
  async prepareIteration(id: string, steps: Step[]): Promise<IterationResult> {
    const state = await this.manager.load(id);
    if (!state) {
      throw new Error(`Runbook ${id} not found`);
    }

    // No active FOR loop — nothing to resolve
    if (!state.forStack?.length) {
      return { status: 'no-resolution-needed', state };
    }

    const top = state.forStack[state.forStack.length - 1];

    // Value already populated or implicit loop — skip resolution
    if (top.currentValue !== undefined || top.implicit) {
      return { status: 'no-resolution-needed', state };
    }

    // Range sources: value is always derivable from the iteration counter.
    // buildStepVariables reads String(top.iteration) directly, so no
    // persistence roundtrip is needed.
    if (top.source.kind === 'range') {
      return { status: 'no-resolution-needed', state };
    }

    const result = await resolveForValue(top);

    if (result.kind === 'resolved') {
      // Build updated forStack with resolved value
      const updatedStack = [...state.forStack];
      updatedStack[updatedStack.length - 1] = result.context;
      const updated = await this.manager.updateForContext(id, updatedStack);
      return { status: 'ready', state: updated };
    }

    // Exhausted: cap the loop end so hasMoreIterations returns false,
    // then send PASS to trigger the machine's loop-exit guard.
    const cappedStack = [...state.forStack];
    cappedStack[cappedStack.length - 1] = result.capped;
    await this.manager.updateForContext(id, cappedStack);

    const actor = await this.manager.createActor(id, steps);
    if (!actor) {
      const cappedState = await this.manager.load(id);
      if (!cappedState) {
        throw new Error(`Runbook ${id} not found after capping`);
      }
      return {
        status: 'exhausted',
        state: cappedState,
        terminal: 'stopped',
      };
    }

    actor.send({ type: 'PASS' });
    const exitState = await this.manager.updateFromActor(id, actor, steps);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const snapshot = actor.getPersistedSnapshot() as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const complete = isRunbookComplete(snapshot);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const stopped = isRunbookStopped(snapshot);

    return {
      status: 'exhausted',
      state: exitState,
      terminal: complete ? 'complete' : stopped ? 'stopped' : undefined,
    };
  }
}
