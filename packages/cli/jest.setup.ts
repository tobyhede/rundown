import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Set bundled runbooks path to dist/runbooks for tests
process.env.BUNDLED_RUNBOOKS_PATH = path.join(__dirname, 'dist', 'runbooks');

// CLI commands and helpers signal failure by assigning `process.exitCode`
// (never `process.exit`, which would tear down the runner). Jest 30 does not
// clone `process` per test file, so a unit test that calls such a helper
// directly leaves the value set for every subsequent test in the same process.
// Under Stryker's in-band runner that crosses file boundaries and misattributes
// the stale code to an unrelated command.
afterEach(() => {
  process.exitCode = undefined;
});
