// packages/shared/src/utils.ts
import * as fs from 'fs/promises';
/**
 * Check if a file exists at the given path.
 * Used by config and context modules to probe file system.
 */
export async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=utils.js.map