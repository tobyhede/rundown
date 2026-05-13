#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { globSync } from 'glob';
import process from 'node:process';

let passed = 0;
let failures = 0;

// Find all runbooks with scenarios in frontmatter
const runbooks = globSync('runbooks/**/*.runbook.md').filter((file) => {
  try {
    const content = readFileSync(file, 'utf-8');
    return content.includes('scenarios:');
  } catch {
    return false;
  }
});

if (runbooks.length === 0) {
  console.log('No runbooks with scenarios found');
  process.exit(0);
}

// For each runbook, list and run its scenarios
for (const runbook of runbooks) {
  try {
    const listResult = spawnSync('node', ['packages/cli/dist/cli.js', 'scenario', 'ls', runbook], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (listResult.error) {
      throw listResult.error;
    }
    if (listResult.status !== 0) {
      throw new Error(`scenario ls failed for ${runbook}: ${listResult.stderr ?? ''}`.trim());
    }
    const scenarios = JSON.parse(listResult.stdout);

    for (const scenario of scenarios) {
      const result = spawnSync('node', [
        'packages/cli/dist/cli.js',
        'scenario',
        'run',
        runbook,
        scenario.name,
        '--quiet',
      ]);

      if (result.status === 0) {
        passed += 1;
      } else {
        console.log(`FAIL: ${runbook} :: ${scenario.name}`);
        failures += 1;
      }
    }
  } catch (error) {
    console.error(
      `Error processing ${runbook}:`,
      error instanceof Error ? error.message : String(error),
    );
    failures += 1;
  }
}

console.log('');
console.log(`${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
