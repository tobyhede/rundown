/**
 * Get the display status string for a runbook state.
 * 
 * @param state - The runbook state object
 * @param activeState - The currently active runbook state (if any)
 * @param stashedId - The ID of the stashed runbook (if any)
 * @returns Status string: 'active', 'stashed', 'complete', 'stopped', or 'inactive'
 */
export function getStatus(
  state: { id: string; variables: { completed?: boolean; stopped?: boolean } },
  activeState: { id: string } | null,
  stashedId: string | null
): string {
  if (activeState?.id === state.id) return 'active';
  if (state.id === stashedId) return 'stashed';
  if (state.variables.completed) return 'complete';
  if (state.variables.stopped) return 'stopped';
  return 'inactive';
}
