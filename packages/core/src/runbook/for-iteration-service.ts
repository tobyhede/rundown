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

import type { Step, RunbookState, ForContext } from './types.js';
import type { ActorSyncResult } from './actor-service.js';
import type { RunbookEvent } from './compiler.js';
import { resolveForValue } from './source-resolver.js';
import {
  isRunbookComplete,
  isRunbookStopped,
  asTerminalSnapshot,
  asTerminalSnapshotOrDefault,
} from './snapshot-utils.js';

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

/** Minimal state-reading contract needed by ForIterationService. */
export interface ForStateReader {
  /**
   * Load persisted runbook state.
   *
   * @param id - Runbook instance ID
   * @returns The state, or null if not found
   */
  load(id: string): Promise<RunbookState | null>;

  /**
   * Persist an updated FOR context stack.
   *
   * @param id - Runbook instance ID
   * @param forStack - The updated FOR context stack to persist
   * @returns The updated runbook state
   */
  updateForContext(id: string, forStack: ForContext[]): Promise<RunbookState>;
}

/** Minimal actor-operation contract needed by ForIterationService. */
export interface ForActorOperations {
  /**
   * Send an event to the runbook actor and synchronise persisted state.
   *
   * @param id - Runbook instance ID
   * @param steps - Parsed step definitions for actor creation
   * @param event - The event to send (e.g., PASS to trigger loop-exit guard)
   * @returns The sync result, or null if the actor could not be created
   */
  sendAndSync(id: string, steps: Step[], event: RunbookEvent): Promise<ActorSyncResult | null>;
}

/**
 * Service that owns the full "prepare iteration" lifecycle for FOR loops.
 *
 * Resolves the current iteration's value from any source type (range, array,
 * file), persists it, and handles exhaustion by sending PASS to the machine
 * to trigger the loop-exit guard.
 */
export class ForIterationService {
  /**
   * @param manager - State reader for loading/updating runbook state
   * @param actorService - Actor operations for XState event dispatch
   */
  constructor(
    private readonly manager: ForStateReader,
    private readonly actorService: ForActorOperations,
  ) {}

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

    // Send PASS to trigger the machine's loop-exit guard (hasMoreIterations returns false)
    const syncResult = await this.actorService.sendAndSync(id, steps, { type: 'PASS' });
    if (!syncResult) {
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

    if (!asTerminalSnapshot(syncResult.snapshot)) {
      console.warn(
        `Unexpected snapshot shape after sendAndSync for runbook "${id}"; using active-state default. ` +
          `Snapshot: ${JSON.stringify(syncResult.snapshot)}`,
      );
    }
    const terminalSnapshot = asTerminalSnapshotOrDefault(syncResult.snapshot);

    const complete = isRunbookComplete(terminalSnapshot);
    const stopped = isRunbookStopped(terminalSnapshot);

    return {
      status: 'exhausted',
      state: syncResult.state,
      terminal: complete ? 'complete' : stopped ? 'stopped' : undefined,
    };
  }
}
