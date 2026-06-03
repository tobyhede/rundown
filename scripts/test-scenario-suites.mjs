#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { globSync } from 'glob';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

let passed = 0;
let failures = 0;

function formatDuration(start) {
  return `${Math.round(performance.now() - start).toString()}ms`;
}

const totalStart = performance.now();

const detailedTimingsEnabled = process.env.RUNDOWN_SCENARIO_COMMAND_TIMINGS === '1';

function writeIndented(stream, label, content) {
  if (!content) {
    return;
  }

  stream.write(`${label}:\n`);
  for (const line of content.trimEnd().split('\n')) {
    stream.write(`  ${line}\n`);
  }
}

// Find all scenario suite files. The root runbook pattern suite predates the
// `*.scenario-suite.yaml` naming convention, so keep it explicitly in CI.
const suites = [
  ...new Set([
    ...globSync('**/*.scenario-suite.yaml', {
      ignore: ['node_modules/**'],
    }),
    ...globSync('runbooks/scenario-suite.yaml', {
      ignore: ['node_modules/**'],
    }),
  ]),
];

if (suites.length === 0) {
  console.log('No scenario suite files found');
  process.exit(0);
}

// Run each scenario suite
for (const suite of suites) {
  const suiteStart = performance.now();
  console.log(`=== ${suite} ===`);

  const result = spawnSync(
    'node',
    ['packages/cli/dist/cli.js', 'scenario-suite', 'run', suite, '--all', '--quiet'],
    {
      encoding: 'utf-8',
    },
  );

  if (detailedTimingsEnabled && result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error) {
    console.error(`Failed to spawn process for ${suite}:`, result.error.message);
    failures += 1;
  } else if (result.status === 0) {
    passed += 1;
    console.log(`${suite}: passed (${formatDuration(suiteStart)})`);
  } else {
    console.log(`FAIL: ${suite}`);
    failures += 1;
    writeIndented(process.stdout, `${suite} stdout`, result.stdout);
    writeIndented(process.stderr, `${suite} stderr`, result.stderr);
    console.log(`${suite}: failed (${formatDuration(suiteStart)})`);
  }

  console.log('');
}

console.log(`${passed} suites passed, ${failures} failed (${formatDuration(totalStart)} total)`);
process.exit(failures === 0 ? 0 : 1);
