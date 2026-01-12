// packages/shared/src/utils.ts
import * as fs from 'fs/promises';

/**
 * Check if a file exists at the given path.
 *
 * Used by config and context modules to probe the file system.
 * Returns true if the file is accessible, false otherwise.
 *
 * @param filePath - The absolute or relative path to check
 * @returns Promise resolving to true if the file exists and is accessible, false otherwise
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
