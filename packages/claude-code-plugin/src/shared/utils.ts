// packages/claude-code-plugin/src/shared/utils.ts
import * as fs from 'fs/promises';

/**
 * Check if a file exists at the given path.
 * Used by config and context modules to probe file system.
 *
 * @param filePath - The absolute path to check
 * @returns Promise resolving to true if file exists and is accessible, false otherwise
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
