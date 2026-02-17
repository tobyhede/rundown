import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Set bundled runbooks path to dist/runbooks for tests
process.env.BUNDLED_RUNBOOKS_PATH = path.join(__dirname, 'dist', 'runbooks');
