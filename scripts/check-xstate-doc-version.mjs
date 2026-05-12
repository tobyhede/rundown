#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docPath = resolve(repoRoot, 'docs/internal/xstate-patterns.md');
const require = createRequire(import.meta.url);
const xstatePkgPath = require.resolve('xstate/package.json');

let installed;
try {
  installed = JSON.parse(readFileSync(xstatePkgPath, 'utf8')).version;
} catch (err) {
  console.error(`error: failed to read ${xstatePkgPath}: ${err.message}`);
  process.exit(1);
}

let banner;
try {
  banner = readFileSync(docPath, 'utf8').match(
    /^> Living reference\. Verified against xstate@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?) on \d{4}-\d{2}-\d{2}\. Re-verify on each xstate upgrade\.\r?$/m,
  );
} catch (err) {
  console.error(`error: failed to read ${docPath}: ${err.message}`);
  process.exit(1);
}

if (!banner) {
  console.error(
    `error: no \`> Living reference. Verified against xstate@<version> on YYYY-MM-DD. ...\` banner found in ${docPath}`,
  );
  process.exit(1);
}

const documented = banner[1];

if (documented !== installed) {
  console.error(
    `error: docs/internal/xstate-patterns.md banner says xstate@${documented} but installed is xstate@${installed}.`,
  );
  console.error(
    "Re-verify the doc's claims against the installed version, then update the verification banner.",
  );
  process.exit(1);
}

console.log(`docs/internal/xstate-patterns.md banner matches installed xstate@${installed}`);
