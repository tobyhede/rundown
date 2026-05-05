import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  if (Object.hasOwn(process.env, 'BUNDLED_RUNBOOKS_PATH')) {
    return process.env.BUNDLED_RUNBOOKS_PATH || join(process.cwd(), '.disabled-bundled-runbooks');
  }
  const candidates = [
    // In dist: dist/helpers/bundled-runbooks.js -> dist/runbooks/
    join(__dirname, '..', 'runbooks'),
    // In source tests: packages/cli/src/helpers -> repo/runbooks/
    join(__dirname, '..', '..', '..', '..', 'runbooks'),
    // Workspace root or package root depending on how npm invoked Jest.
    join(process.cwd(), 'runbooks'),
    join(process.cwd(), '..', '..', 'runbooks'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}
