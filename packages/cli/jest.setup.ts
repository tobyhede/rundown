import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Set bundled runbooks path to dist/runbooks for tests
process.env.BUNDLED_RUNBOOKS_PATH = path.join(__dirname, 'dist', 'runbooks');
