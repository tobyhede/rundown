// packages/core/src/runbook/snapshot-utils.ts

/**
 * Utility functions for inspecting XState runbook snapshots.
 *
 * These helpers centralise terminal-state detection so both CLI and core
 * services share a single code path instead of duplicating inline checks.
 *
 * @module
 */

/**
 * Check if a runbook snapshot indicates successful completion.
 *
 * @param snapshot - XState snapshot with status and value
 * @returns True if the runbook has completed successfully
 */
export function isRunbookComplete(snapshot: { status: string; value: unknown }): boolean {
  return snapshot.status === 'done' && snapshot.value === 'COMPLETE';
}

/**
 * Check if a runbook snapshot indicates a stopped (aborted) state.
 *
 * @param snapshot - XState snapshot with status and value
 * @returns True if the runbook has been stopped
 */
export function isRunbookStopped(snapshot: { status: string; value: unknown }): boolean {
  return snapshot.status === 'done' && snapshot.value === 'STOPPED';
}

/**
 * Safely narrow an unknown snapshot to the shape expected by terminal-state helpers.
 *
 * @param snapshot - Raw persisted XState snapshot (unknown type)
 * @returns The snapshot cast to terminal shape, or null if it doesn't match
 */
export function asTerminalSnapshot(snapshot: unknown): { status: string; value: unknown } | null {
  if (
    typeof snapshot === 'object' &&
    snapshot !== null &&
    'status' in snapshot &&
    'value' in snapshot
  ) {
    return snapshot as { status: string; value: unknown };
  }
  return null;
}
