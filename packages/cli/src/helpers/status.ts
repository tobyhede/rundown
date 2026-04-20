import type { Lifecycle } from '@rundown-org/core';

/**
 * Get the display status string for a runbook state.
 *
 * @param state - The runbook state object
 * @param state.id - Unique identifier for this runbook state
 * @param state.lifecycle - Lifecycle state of the runbook
 * @param activeState - The currently active runbook state (if any)
 * @param stashedId - The ID of the stashed runbook (if any)
 * @returns Status string: 'active', 'stashed', 'complete', 'stopped', or 'inactive'
 */
export function getStatus(
  state: { id: string; lifecycle?: Lifecycle },
  activeState: { id: string } | null,
  stashedId: string | null,
): string {
  if (activeState?.id === state.id) return 'active';
  if (state.id === stashedId) return 'stashed';
  if (state.lifecycle === 'completed') return 'complete';
  if (state.lifecycle === 'stopped') return 'stopped';
  return 'inactive';
}
