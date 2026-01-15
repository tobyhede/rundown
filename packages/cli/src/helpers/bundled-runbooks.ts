import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Get the path to bundled runbooks directory.
 * Bundled runbooks are shipped with the CLI package for common patterns.
 *
 * @returns Absolute path to the bundled runbooks directory
 */
export function getBundledRunbooksPath(): string {
  // Allow override for testing or custom deployments
  if (process.env.BUNDLED_RUNBOOKS_PATH) {
    return process.env.BUNDLED_RUNBOOKS_PATH;
  }
  // In dist: dist/helpers/bundled-runbooks.js -> dist/runbooks/
  return join(__dirname, '..', 'runbooks');
}
