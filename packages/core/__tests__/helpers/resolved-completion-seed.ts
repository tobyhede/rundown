import type { RunbookStateManager } from '../../src/runbook/state.js';
import { merge } from '../../src/runbook/state-update-ops.js';
import type { ResolvedCompletion } from '../../src/runbook/types.js';

/**
 * Seed a resolved-completion record directly into persisted state for tests.
 *
 * Production writes resolved completions only through
 * `RunbookCompletionService.recordManualCompletion`, which records the
 * completion atomically alongside its mirrored substep state. The read-side
 * lifecycle API (`getResolvedCompletion` / `consumeResolvedCompletion` /
 * `listResolvedCompletions`) therefore needs a fixture seam to establish the
 * precondition without dragging in substep state. This helper performs the
 * minimal locked write of just the `resolvedCompletions` map.
 *
 * @param manager - The state manager bound to the test workspace.
 * @param id - The runbook state ID to seed.
 * @param key - Canonical completion key (`frame|entry|substep`).
 * @param completion - Resolved completion payload to store.
 */
export async function seedResolvedCompletion(
  manager: RunbookStateManager,
  id: string,
  key: string,
  completion: ResolvedCompletion,
): Promise<void> {
  await manager.update(id, {
    resolvedCompletions: merge({ [key]: completion }),
  });
}
