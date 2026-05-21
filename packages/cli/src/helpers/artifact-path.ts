import { isAbsolute } from 'node:path';

/**
 * Assert that an ARTIFACTS file reference is relative and contains no unsafe path segments.
 *
 * @param ref - Artifact file reference to validate
 * @param message - Error message to use when the reference is unsafe
 * @throws {Error} When the reference is absolute or contains empty, dot, or parent segments
 */
export function assertSafeRelativeArtifactPath(ref: string, message: string): void {
  const segments = ref.split(/[\\/]/);
  const hasUnsafeSegment = segments.some(
    (segment) => segment === '' || segment === '.' || segment === '..',
  );
  if (isAbsolute(ref) || hasUnsafeSegment) {
    throw new Error(message);
  }
}
