/**
 * Business logic for the scenario command.
 *
 * Extracts loading, formatting, and execution logic from commands/scenarios.ts
 * into testable functions. The command file becomes a thin shell.
 *
 * @module helpers/scenario-workflow
 */

import { readFile, rm } from 'node:fs/promises';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isNodeError } from '@rundown-org/core';
import {
  parseScenarios,
  getEffectiveResult,
  type Scenario,
  type Scenarios,
  type ScenarioExpect,
} from '../schemas/scenarios.js';
import { resolveRunbookFile } from './resolve-runbook.js';
import { extractFrontmatter } from '@rundown-org/parser';
import type { OutputEmitter } from '../services/output-emitter.js';
import {
  executeCommandSequence,
  extractRunbookReferences,
  matchStepAssertions,
  type StepAssertionResult,
} from './command-sequence.js';

/**
 * A loaded runbook with its scenarios.
 */
export interface LoadedRunbook {
  /** Absolute path to the runbook source file. */
  filePath: string;
  /** Display name from frontmatter or derived from filename. */
  name: string;
  /** Optional description from frontmatter. */
  description?: string;
  /** Parsed scenario definitions from the runbook. */
  scenarios: Scenarios;
}

/**
 * Result of loading scenarios.
 */
export type ScenarioLoadResult =
  | { ok: true; loaded: LoadedRunbook }
  | { ok: false; error: string; code: string; details?: string[] };

/**
 * Result of running a scenario.
 */
export interface ScenarioRunResult {
  /** Whether the scenario produced the expected outcome. */
  passed: boolean;
  /** Name of the scenario that was executed. */
  scenario: string;
  /** Expected final state (e.g. "COMPLETE", "STOP"). */
  expected: string;
  /** Actual final state observed after execution. */
  actual: string;
  /** Per-step assertion results (present when expect.steps block is used). */
  stepAssertions?: StepAssertionResult[];
}

/**
 * Load and validate scenarios from a runbook file.
 *
 * Returns a result type instead of calling process.exit().
 *
 * @param file - Runbook file path or name
 * @param cwd - Current working directory
 * @returns ScenarioLoadResult with loaded data or error details
 */
export async function loadScenarios(file: string, cwd: string): Promise<ScenarioLoadResult> {
  const filePath = await resolveRunbookFile(cwd, file);

  if (!filePath) {
    return { ok: false, error: `Runbook file not found: ${file}`, code: 'RUNBOOK_NOT_FOUND' };
  }

  const content = await readFile(filePath, 'utf-8');
  const { frontmatter } = extractFrontmatter(content);

  if (!frontmatter) {
    return { ok: false, error: 'No frontmatter found in this runbook', code: 'VALIDATION_ERROR' };
  }

  const { scenarios, errors } = parseScenarios(frontmatter);

  if (errors.length > 0) {
    return {
      ok: false,
      error: 'Invalid scenarios in frontmatter:',
      code: 'VALIDATION_ERROR',
      details: errors,
    };
  }

  if (!scenarios || Object.keys(scenarios).length === 0) {
    return { ok: false, error: 'No scenarios defined in this runbook', code: 'VALIDATION_ERROR' };
  }

  const name = frontmatter.name ?? file;
  const description = frontmatter.description;

  return { ok: true, loaded: { filePath, name, description, scenarios } };
}

/**
 * Build list rows from scenarios for output.list().
 *
 * @param scenarios - Map of scenario names to definitions
 * @returns Array of row objects for tabular display
 */
export function buildScenarioListRows(
  scenarios: Scenarios,
): { name: string; expected: string; description: string; tags: string }[] {
  return Object.entries(scenarios).map(([name, scenario]) => {
    return {
      name,
      expected: getEffectiveResult(scenario),
      description: scenario.description ?? '',
      tags: scenario.tags?.join(', ') ?? '',
    };
  });
}

/**
 * Build detail data for a specific scenario.
 *
 * @param name - Scenario name to look up
 * @param scenarios - Map of scenario names to definitions
 * @returns Detail object or null if not found
 */
export function buildScenarioDetail(
  name: string,
  scenarios: Scenarios,
): {
  name: string;
  description?: string;
  expected: string;
  commands: string[];
  tags?: string[];
  expect?: ScenarioExpect;
} | null {
  if (!(name in scenarios)) {
    return null;
  }

  const scenario = scenarios[name];
  return {
    name,
    description: scenario.description,
    expected: getEffectiveResult(scenario),
    commands: scenario.commands,
    tags: scenario.tags,
    expect: scenario.expect,
  };
}

/**
 * Extract referenced runbook files from scenario commands.
 *
 * @param scenario - The scenario to extract references from
 * @returns Array of runbook filenames referenced in commands
 */
export function extractReferencedRunbooks(scenario: Scenario): string[] {
  return extractRunbookReferences(scenario.commands);
}

/**
 * Execute a scenario in an isolated temp workspace and evaluate the result.
 *
 * Creates a temp directory, copies runbook files, executes commands via
 * executeCommandSequence, and compares against expected result. When an
 * `expect.steps` block is present, evaluates step assertions against the
 * captured transition stream.
 *
 * @param loadedRunbook - The loaded runbook with scenario definitions
 * @param scenarioName - Name of the scenario to execute
 * @param quiet - Whether to suppress command output
 * @param output - OutputEmitter for progress output
 * @param cliPath - Path to the CLI entry point
 * @returns ScenarioRunResult with pass/fail evaluation
 * @throws {Error} When a command fails with a non-zero exit code and no terminal result is parsed
 * @throws {Error} When the temp workspace cannot be created or cleaned up
 */
export async function executeScenario(
  loadedRunbook: LoadedRunbook,
  scenarioName: string,
  quiet: boolean,
  output: OutputEmitter,
  cliPath: string,
): Promise<ScenarioRunResult> {
  const { filePath, scenarios } = loadedRunbook;
  const scenario = scenarios[scenarioName];
  const effectiveResult = getEffectiveResult(scenario);
  const runbookFilename = basename(loadedRunbook.filePath);

  // Create isolated temp workspace
  const tmpDir = mkdtempSync(join(tmpdir(), 'rd-scenario-'));

  try {
    const runbooksDir = join(tmpDir, '.claude', 'rundown', 'runbooks');
    mkdirSync(runbooksDir, { recursive: true });
    // Copy runbook and any referenced child runbooks
    copyFileSync(filePath, join(runbooksDir, runbookFilename));

    const referenced = extractReferencedRunbooks(scenario);
    const sourceDir = dirname(filePath);
    for (const ref of referenced) {
      if (ref !== runbookFilename) {
        try {
          copyFileSync(join(sourceDir, ref), join(runbooksDir, ref));
        } catch (err: unknown) {
          if (isNodeError(err) && err.code === 'ENOENT') {
            throw new Error(`Referenced runbook not found: ${ref} (searched in: ${sourceDir})`);
          }
          throw err;
        }
      }
    }

    // Verbose display — print scenario header only
    if (!quiet) {
      output.message('', 'info');
      output.message(`Scenario:  ${scenarioName}`, 'dim');
      output.message('\u2500'.repeat(50), 'dim');
      output.message('', 'info');
    }

    // Execute all commands, tee child output, and capture JSON stdout
    const seqResult = await executeCommandSequence({
      commands: scenario.commands,
      cwd: tmpDir,
      cliPath,
      quiet,
      onCommandStart: quiet
        ? undefined
        : (cmd) => {
            output.message('', 'info');
            output.message('\u2501'.repeat(50), 'dim');
            output.message(`$ ${cmd}`, 'info');
            output.message('', 'info');
          },
    });

    const actualResult = seqResult.terminalResult;

    // Evaluate step assertions if present
    let stepAssertions: StepAssertionResult[] | undefined;
    if (scenario.expect?.steps) {
      stepAssertions = matchStepAssertions(scenario.expect.steps, seqResult.transitions);
    }

    const resultPassed = actualResult === effectiveResult;
    const assertionsPassed = stepAssertions ? stepAssertions.every((a) => a.matched) : true;

    if (!quiet) {
      output.message('', 'info');
    }

    return {
      passed: resultPassed && assertionsPassed,
      scenario: scenarioName,
      expected: effectiveResult,
      actual: actualResult,
      stepAssertions,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
