#!/usr/bin/env node
/**
 * Validate all built-in runbooks pass syntax validation.
 * Pattern: mirrors packages/cli/scripts/copy-runbooks.js structure
 */
import { execSync } from 'child_process';
import { readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const runbooksDir = join(__dirname, '..', 'runbooks');
const cliPath = join(__dirname, '..', '..', 'cli', 'dist', 'cli.js');

if (!existsSync(cliPath)) {
  console.error(`CLI not found at ${cliPath}. Build the CLI first.`);
  process.exit(1);
}

/**
 * Recursively find all .runbook.md files in a directory.
 * @param {string} dir - Directory to search
 * @returns {string[]} - Array of absolute paths to runbook files
 */
function findRunbooks(dir) {
  if (!existsSync(dir)) return [];
  const runbooks = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      runbooks.push(...findRunbooks(fullPath));
    } else if (entry.endsWith('.runbook.md')) {
      runbooks.push(fullPath);
    }
  }
  return runbooks;
}

const runbooks = findRunbooks(runbooksDir);
if (runbooks.length === 0) {
  console.log('No runbooks found, skipping validation.');
  process.exit(0);
}

let failed = 0;
for (const runbook of runbooks) {
  try {
    execSync(`node "${cliPath}" check "${runbook}"`, { stdio: 'pipe' });
    console.log(`PASS: ${runbook}`);
  } catch (error) {
    console.error(`FAIL: ${runbook}`);
    // Extract error message from execSync error object
    const stderr = error.stderr?.toString();
    const stdout = error.stdout?.toString();
    const message = stderr || stdout || error.message || 'Unknown error';
    console.error(message);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} runbook(s) failed validation`);
  process.exit(1);
}
console.log(`\nAll ${runbooks.length} runbooks passed validation`);
