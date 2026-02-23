/**
 * Business logic for the scenario command.
 *
 * Extracts loading, formatting, and execution logic from commands/scenarios.ts
 * into testable functions. The command file becomes a thin shell.
 *
 * @module helpers/scenario-workflow
 */

import { readFile, rm } from 'node:fs/promises';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { parse as shellParse } from 'shell-quote';
import { parseScenarios, type Scenario, type Scenarios } from '../schemas/scenarios.js';
import { resolveRunbookFile } from './resolve-runbook.js';
import { extractRawFrontmatter } from './extract-raw-frontmatter.js';
import type { OutputEmitter } from '../services/output-emitter.js';

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
  /** Expected final state (e.g. "complete", "stopped"). */
  expected: string;
  /** Actual final state observed after execution. */
  actual: string;
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
  const { frontmatter } = extractRawFrontmatter(content);

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

  const name = (typeof frontmatter.name === 'string' ? frontmatter.name : undefined) ?? file;
  const description =
    typeof frontmatter.description === 'string' ? frontmatter.description : undefined;

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
      expected: scenario.result,
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
} | null {
  if (!(name in scenarios)) {
    return null;
  }

  const scenario = scenarios[name];
  return {
    name,
    description: scenario.description,
    expected: scenario.result,
    commands: scenario.commands,
    tags: scenario.tags,
  };
}

/**
 * Extract referenced runbook files from scenario commands.
 *
 * @param scenario - The scenario to extract references from
 * @returns Array of runbook filenames referenced in commands
 */
export function extractReferencedRunbooks(scenario: Scenario): string[] {
  const referenced: string[] = [];
  const runbookPattern = /(?:^|[\s])([^\s=]+\.runbook\.md)/g;

  for (const cmd of scenario.commands) {
    for (const match of cmd.matchAll(runbookPattern)) {
      const ref = match[1];
      if (!referenced.includes(ref)) {
        referenced.push(ref);
      }
    }
  }

  return referenced;
}

/**
 * Execute a scenario in an isolated temp workspace and evaluate the result.
 *
 * Creates a temp directory, copies runbook files, executes commands, reads
 * final state, and compares against expected result.
 *
 * @param loadedRunbook - The loaded runbook with scenario definitions
 * @param scenarioName - Name of the scenario to execute
 * @param quiet - Whether to suppress command output
 * @param output - OutputEmitter for progress output
 * @param cliPath - Path to the CLI entry point
 * @returns ScenarioRunResult with pass/fail evaluation
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
          if (
            !(
              err instanceof Error &&
              'code' in err &&
              (err as NodeJS.ErrnoException).code === 'ENOENT'
            )
          ) {
            throw err;
          }
        }
      }
    }

    // Execute commands in sequence
    // Print scenario header (verbose mode only)
    if (!quiet) {
      output.message('', 'info');
      output.message(`Scenario:  ${scenarioName}`, 'dim');
      output.message('\u2500'.repeat(50), 'dim');
      output.message('', 'info');
    }

    for (const cmd of scenario.commands) {
      if (!quiet) {
        output.message('', 'info');
        output.message('\u2501'.repeat(50), 'dim');
        output.message(`$ ${cmd}`, 'info');
        output.message('', 'info');
      }

      // Route 'rd' commands through execFileSync to avoid shell injection
      const rdMatch = /^rd\s+(.*)$/.exec(cmd);
      try {
        if (rdMatch) {
          const parsed = shellParse(rdMatch[1]);
          const hasOperators = parsed.some((entry) => typeof entry !== 'string');
          if (hasOperators) {
            throw new Error(
              `Unsupported shell operators in scenario command: ${cmd}. ` +
                'Split into separate commands instead of using &&, ||, |, etc.',
            );
          }
          const args = parsed as string[];
          execFileSync('node', [cliPath, ...args], {
            cwd: tmpDir,
            encoding: 'utf-8',
            stdio: quiet ? 'pipe' : 'inherit',
            env: { ...process.env, RUNDOWN_LOG: '0' },
          });
        } else {
          // Non-rd commands are author-defined scenario commands — inherently trusted
          execSync(cmd, {
            cwd: tmpDir,
            encoding: 'utf-8',
            stdio: quiet ? 'pipe' : 'inherit',
            env: { ...process.env, RUNDOWN_LOG: '0' },
          });
        }
      } catch (err: unknown) {
        // Re-throw non-exec errors (e.g. unsupported shell operators)
        if (err instanceof Error && !('status' in err)) {
          throw err;
        }
        // Non-zero exit codes are expected for STOP/FAIL scenarios — continue
      }
    }

    if (!quiet) {
      output.message('', 'info');
    }

    // Check final state
    const runsDir = join(tmpDir, '.claude', 'rundown', 'runs');
    let actualResult = 'UNKNOWN';

    try {
      const stateFiles = readdirSync(runsDir).filter((f) => f.endsWith('.json'));
      if (stateFiles.length > 0) {
        // Get most recently modified state file
        const latestFile = stateFiles
          .map((f) => ({ name: f, path: join(runsDir, f) }))
          .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)[0];

        const stateContent = readFileSync(latestFile.path, 'utf-8');
        const state = JSON.parse(stateContent) as {
          variables?: { completed?: boolean; stopped?: boolean };
        };

        if (state.variables?.completed) {
          actualResult = 'COMPLETE';
        } else if (state.variables?.stopped) {
          actualResult = 'STOP';
        }
      }
    } catch {
      // State file may not exist
    }

    const passed = actualResult === scenario.result;
    return { passed, scenario: scenarioName, expected: scenario.result, actual: actualResult };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
