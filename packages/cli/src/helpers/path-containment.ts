import { sep } from 'node:path';

/**
 * Assert that a candidate path is contained by the given root path.
 *
 * @param root - Absolute root path that must contain the candidate
 * @param candidate - Absolute candidate path to validate
 * @param message - Error message to use when the candidate escapes the root
 * @throws {Error} When the candidate is outside the root
 */
export function assertContainedPath(root: string, candidate: string, message: string): void {
  const prefix = root === sep ? root : root + sep;
  if (!(candidate === root || candidate.startsWith(prefix))) {
    throw new Error(message);
  }
}
