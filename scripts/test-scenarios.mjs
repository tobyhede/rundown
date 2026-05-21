#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { globSync } from 'glob';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { extractFrontmatter } from '../packages/parser/dist/index.js';
import { parseScenarios } from '../packages/cli/dist/schemas/scenarios.js';

let passed = 0;
let failures = 0;

function formatDuration(start) {
  return `${Math.round(performance.now() - start).toString()}ms`;
}

function formatDiagnostics(diagnostics) {
  return diagnostics
    .map((diagnostic) => {
      const location = diagnostic.line === undefined ? '' : `line ${diagnostic.line.toString()}: `;
      return `${diagnostic.severity}: ${location}${diagnostic.message}`;
    })
    .join('; ');
}

const totalStart = performance.now();

const detailedTimingsEnabled = process.env.RUNDOWN_SCENARIO_COMMAND_TIMINGS === '1';

function listScenarioNames(runbook) {
  const content = readFileSync(runbook, 'utf-8');
  const { frontmatter, diagnostics } = extractFrontmatter(content);
  if (diagnostics.length > 0) {
    throw new Error(`Invalid frontmatter in ${runbook}: ${formatDiagnostics(diagnostics)}`);
  }
  if (!frontmatter) {
    throw new Error(`No frontmatter found in ${runbook}`);
  }

  const { scenarios, errors } = parseScenarios(frontmatter);
  if (errors.length > 0) {
    throw new Error(`Invalid scenarios in ${runbook}: ${errors.join('; ')}`);
  }
  if (!scenarios || Object.keys(scenarios).length === 0) {
    throw new Error(`No scenarios defined in ${runbook}`);
  }

  return Object.keys(scenarios);
}

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
  const runbookStart = performance.now();
  let runbookPassed = 0;
  let runbookFailures = 0;

  try {
    const scenarios = listScenarioNames(runbook);

    for (const scenario of scenarios) {
      const result = spawnSync(
        'node',
        ['packages/cli/dist/cli.js', 'scenario', 'run', runbook, scenario, '--quiet'],
        {
          encoding: 'utf-8',
        },
      );

      if (result.error) {
        console.error(
          `Failed to spawn process for ${runbook} :: ${scenario}:`,
          result.error.message,
        );
        failures += 1;
        runbookFailures += 1;
      } else if (result.status === 0) {
        passed += 1;
        runbookPassed += 1;
      } else {
        console.log(`FAIL: ${runbook} :: ${scenario}`);
        failures += 1;
        runbookFailures += 1;
      }
      if (detailedTimingsEnabled && result.stderr) {
        process.stderr.write(result.stderr);
      }
    }
  } catch (error) {
    console.error(
      `Error processing ${runbook}:`,
      error instanceof Error ? error.message : String(error),
    );
    failures += 1;
    runbookFailures += 1;
  }

  console.log(
    `${runbook}: ${runbookPassed.toString()} passed, ${runbookFailures.toString()} failed (${formatDuration(runbookStart)})`,
  );
}

console.log('');
console.log(`${passed} passed, ${failures} failed (${formatDuration(totalStart)} total)`);
process.exit(failures === 0 ? 0 : 1);
