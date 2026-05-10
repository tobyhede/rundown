#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docPath = resolve(repoRoot, 'docs/internal/xstate-patterns.md');
const xstatePkgPath = resolve(repoRoot, 'node_modules/xstate/package.json');

const installed = JSON.parse(readFileSync(xstatePkgPath, 'utf8')).version;
const banner = readFileSync(docPath, 'utf8').match(/xstate@(\d+\.\d+\.\d+)/);

if (!banner) {
  console.error(`error: no \`xstate@<version>\` banner found in ${docPath}`);
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
