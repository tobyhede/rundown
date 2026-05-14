import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';

/**
 * Canonicalise a test project root before passing it to resolver-level APIs.
 *
 * Production code gets this guarantee from `RunbookStateManager`. Direct unit
 * tests that bypass the manager should use this helper so they exercise the
 * same containment-check contract.
 *
 * @param projectRoot - Raw test project root path.
 * @returns The resolved real path.
 */
export async function canonicalProjectRootForTest(projectRoot: string): Promise<string> {
  return await realpath(projectRoot);
}

/**
 * Synchronous variant of {@link canonicalProjectRootForTest}.
 *
 * @param projectRoot - Raw test project root path.
 * @returns The resolved real path.
 */
export function canonicalProjectRootSyncForTest(projectRoot: string): string {
  return realpathSync(projectRoot);
}
