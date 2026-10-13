import type { Lifecycle } from '@rundown-org/core';

/**
 * Get the display status string for a runbook state.
 *
 * Lifecycle only: under one writer per run there is no "active" or
 * "stashed" run, so a run is `running`, `complete`, `stopped` or
 * `abandoned`.
 *
 * @param state - The runbook state object
 * @param state.lifecycle - Lifecycle state of the runbook
 * @returns Status string: 'running', 'complete', 'stopped', or 'abandoned'
 */
export function getStatus(state: { lifecycle?: Lifecycle }): string {
  switch (state.lifecycle ?? 'running') {
    case 'completed':
      return 'complete';
    case 'stopped':
      return 'stopped';
    case 'abandoned':
      return 'abandoned';
    case 'running':
      return 'running';
    default: {
      const _exhaustive: never = state.lifecycle as never;
      return String(_exhaustive);
    }
  }
}
