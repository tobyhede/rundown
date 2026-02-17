// src/runbook/execution-lifecycle-service.ts
import type { RunbookStateManager } from './state.js';
import type { PendingStep } from './types.js';

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
