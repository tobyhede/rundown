// packages/claude-code-plugin/src/shared/utils.ts
import * as path from 'node:path';

/**
 * Ensures that a path is strictly contained within a base directory.
 * Prevents path traversal attacks.
 *
 * @param base - The base directory (jail root)
 * @param target - The path to check
 * @returns True if target is inside base, false otherwise
 */
export function isPathInside(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Safely joins path segments and ensures the result is within the base directory.
 *
 * @param base - The base directory (jail root)
 * @param segments - Path segments to join
 * @returns The absolute joined path if safe
 * @throws {Error} if the resulting path escapes the base directory
 */
export function safeJoin(base: string, ...segments: string[]): string {
  const joined = path.join(base, ...segments);
  if (!isPathInside(base, joined) && joined !== base) {
    throw new Error(
      `Security violation: path traversal detected attempting to access ${joined} outside of ${base}`,
    );
  }
  return joined;
}

/**
 * Sanitize a string to be used as a filename or path segment.
 * Removes path separators and parent directory references.
 *
 * @param segment - The raw string to sanitize
 * @returns Sanitized string safe for use as a path segment
 */
export function sanitizePathSegment(segment: string): string {
  return segment
    .replace(/[/\\]/g, '_') // Replace separators with underscore
    .replace(/\.\./g, '__'); // Replace parent references
}

/**
 * Escapes a string for safe use in a shell command.
 * Primarily handles double quotes, backticks and dollar signs for use inside double quotes.
 *
 * @param str - The string to escape
 * @returns Shell-safe escaped string
 */
export function shellEscape(str: string): string {
  return str.replace(/(["`\\$])/g, '\\$1');
}
