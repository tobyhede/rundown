#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { globSync } from 'glob';
import process from 'node:process';

let passed = 0;
let failures = 0;

// Find all scenario suite files
const suites = globSync('**/*.scenario-suite.yaml', {
  ignore: ['node_modules/**'],
});

if (suites.length === 0) {
  console.log('No scenario suite files found');
  process.exit(0);
}

// Run each scenario suite
for (const suite of suites) {
  console.log(`=== ${suite} ===`);

  const result = spawnSync('node', [
    'packages/cli/dist/cli.js',
    'scenario-suite',
    'run',
    suite,
    '--all',
    '--quiet',
  ]);

  if (result.status === 0) {
    passed += 1;
  } else {
    console.log(`FAIL: ${suite}`);
    failures += 1;
  }

  console.log('');
}

console.log(`${passed} suites passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
