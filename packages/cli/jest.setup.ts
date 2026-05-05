import path from 'node:path';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Set bundled runbooks path to dist/runbooks for tests, falling back to the
// source-tree runbooks directory before the package has been built.
const distRunbooks = path.join(__dirname, 'dist', 'runbooks');
process.env.BUNDLED_RUNBOOKS_PATH = existsSync(distRunbooks)
  ? distRunbooks
  : path.join(__dirname, '..', '..', 'runbooks');
