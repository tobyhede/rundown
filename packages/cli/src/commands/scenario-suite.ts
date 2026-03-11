/**
 * CLI commands for external scenario suite files.
 *
 * Provides `rd scenario-suite ls|show|run` commands for working with
 * standalone `*.scenario-suite.yaml` files.
 *
 * @module commands/scenario-suite
 */

import type { Command } from 'commander';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { OutputEmitter } from '../services/output-emitter.js';
import { loadScenarioSuite, type ScenarioSuiteCase } from '../schemas/scenario-suite.js';
import {
  executeCommandSequence,
  extractRunbookReferences,
  matchStepAssertions,
  formatStepAssertionDescription,
  type StepAssertionResult,
} from '../helpers/command-sequence.js';
import { getEffectiveResult } from '../schemas/scenarios.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the CLI executable — resolves from compiled output or source (ts-jest). */
const CLI_PATH = (() => {
  const adjacent = join(__dirname, '..', 'cli.js');
  if (existsSync(adjacent)) return adjacent;
  return join(__dirname, '..', '..', 'dist', 'cli.js');
})();

/**
 * Check if an error is an ENOENT filesystem error using duck-typing.
 *
 * Avoids `instanceof Error` which fails across ESM realm boundaries
 * (e.g., Jest's experimental VM modules).
 *
 * @param err - The caught error value
 * @returns True if the error has an ENOENT code
 */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

/**
 * Validate that a relative path does not escape its parent directory.
 *
 * @param relPath - The relative path to validate
 * @throws {Error} When the path is absolute or contains traversal segments
 */
function validateRelativePath(relPath: string): void {
  if (isAbsolute(relPath)) {
    throw new Error(`Absolute paths are not allowed in suite case files: ${relPath}`);
  }
  const normalized = normalize(relPath);
  if (normalized.startsWith('..')) {
    throw new Error(`Path traversal is not allowed in suite case files: ${relPath}`);
  }
}

/**
 * Execute a single suite case in an isolated temp workspace.
 * @param caseName - Name of the suite case being executed
 * @param suiteCase - Suite case definition with file, commands, and expectations
 * @param suiteDir - Directory containing the suite file (for resolving relative paths)
 * @param quiet - Whether to suppress child process output
 * @param output - Output emitter for rendering progress messages
 * @returns Result with pass/fail status, expected vs actual outcome, and optional step assertions
 */
async function executeSuiteCase(
  caseName: string,
  suiteCase: ScenarioSuiteCase,
  suiteDir: string,
  quiet: boolean,
  output: OutputEmitter,
): Promise<{
  passed: boolean;
  scenario: string;
  expected: string;
  actual: string;
  stepAssertions?: StepAssertionResult[];
}> {
  const effectiveResult = getEffectiveResult(suiteCase);
  const runbookPath = resolve(suiteDir, suiteCase.file);
  const tmpDir = mkdtempSync(join(tmpdir(), 'rd-suite-'));

  try {
    const runbooksDir = join(tmpDir, '.claude', 'rundown', 'runbooks');
    mkdirSync(runbooksDir, { recursive: true });

    // Path-preserving copy: preserve subdirectory structure for suite cases
    const relPath = suiteCase.file; // e.g., "transitions/default-implicit.runbook.md"
    validateRelativePath(relPath);
    const destPath = join(runbooksDir, relPath);
    mkdirSync(dirname(destPath), { recursive: true });

    try {
      copyFileSync(runbookPath, destPath);
    } catch (err: unknown) {
      if (isEnoent(err)) {
        return {
          passed: false,
          scenario: caseName,
          expected: effectiveResult,
          actual: `RUNBOOK_NOT_FOUND: ${suiteCase.file}`,
        };
      }
      throw err;
    }

    // Also copy flat to runbooks root so bare-filename commands resolve
    const flatDest = join(runbooksDir, basename(suiteCase.file));
    if (flatDest !== destPath) {
      try {
        copyFileSync(runbookPath, flatDest);
      } catch (err: unknown) {
        if (!isEnoent(err)) {
          throw err;
        }
        // ENOENT non-fatal: structured copy at destPath already succeeded
      }
    }

    // Copy any referenced child runbooks into the isolated workspace
    const mainBasename = basename(suiteCase.file);
    const allRefs = extractRunbookReferences(suiteCase.commands);
    const referenced = allRefs.filter((r) => r !== suiteCase.file && r !== mainBasename);
    const mainRunbookSourceDir = dirname(resolve(suiteDir, suiteCase.file));
    for (const ref of referenced) {
      validateRelativePath(ref);
      const dest = join(runbooksDir, ref);
      mkdirSync(dirname(dest), { recursive: true });
      // Try main runbook's directory first (bare filenames), then suite directory (nested paths)
      let copied = false;
      for (const base of [mainRunbookSourceDir, suiteDir]) {
        try {
          copyFileSync(resolve(base, ref), dest);
          copied = true;
          break;
        } catch (e: unknown) {
          if (isEnoent(e)) {
            continue; // try next base
          }
          throw e; // permission/IO errors propagate immediately
        }
      }
      if (!copied) {
        throw new Error(
          `CHILD_RUNBOOK_NOT_FOUND: ${ref} (required by case "${caseName}", ` +
            `searched in: ${[mainRunbookSourceDir, suiteDir].join(', ')})`,
        );
      }
    }

    if (!quiet) {
      output.message('', 'info');
      output.message(`Case: ${caseName}`, 'dim');
      output.message('\u2500'.repeat(50), 'dim');
      output.message('', 'info');
    }

    const seqResult = await executeCommandSequence({
      commands: suiteCase.commands,
      cwd: tmpDir,
      cliPath: CLI_PATH,
      quiet,
      onCommandStart: quiet
        ? undefined
        : (cmd) => {
            output.message(`$ ${cmd}`, 'info');
          },
    });

    const actualResult = seqResult.terminalResult;

    let stepAssertions: StepAssertionResult[] | undefined;
    if (suiteCase.expect?.steps) {
      stepAssertions = matchStepAssertions(suiteCase.expect.steps, seqResult.transitions);
    }

    const resultPassed = actualResult === effectiveResult;
    const assertionsPassed = stepAssertions ? stepAssertions.every((a) => a.matched) : true;

    return {
      passed: resultPassed && assertionsPassed,
      scenario: caseName,
      expected: effectiveResult,
      actual: actualResult,
      stepAssertions,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Register the scenario-suite command with subcommands.
 *
 * @param program - The Commander program instance to register the command on
 */
export function registerScenarioSuiteCommand(program: Command): void {
  const suite = program
    .command('scenario-suite')
    .description('List, show, or run cases from a scenario suite file');

  // rd scenario-suite ls <suite-file>
  suite
    .command('ls <suite-file>')
    .description('List all cases in a scenario suite')
    .option('--json', 'Output as JSON')
    .action(async (suiteFile: string, options: { json?: boolean }) => {
      const output = new OutputEmitter({ json: options.json });
      try {
        const result = await loadScenarioSuite(suiteFile);
        if (!result.ok) {
          output.error(result.error, 'VALIDATION_ERROR');
          if (result.details) {
            for (const detail of result.details) {
              output.message(`  - ${detail}`, 'error');
            }
          }
          output.flush();
          process.exit(1);
        }

        const rows = Object.entries(result.suite.cases).map(([name, c]) => ({
          name,
          file: c.file,
          expected: getEffectiveResult(c),
          description: c.description ?? '',
          tags: c.tags?.join(', ') ?? '',
        }));

        output.list(rows, [
          { header: 'NAME', key: 'name' },
          { header: 'FILE', key: 'file' },
          { header: 'EXPECTED', key: 'expected' },
          { header: 'DESCRIPTION', key: 'description' },
          { header: 'TAGS', key: 'tags' },
        ]);
        output.flush();
      } catch (error) {
        output.error(error instanceof Error ? error.message : 'Unknown error', 'UNKNOWN_ERROR');
        output.flush();
        process.exit(1);
      }
    });

  // rd scenario-suite show <suite-file> <case>
  suite
    .command('show <suite-file> <case>')
    .description('Show details for a specific case in a suite')
    .option('--json', 'Output as JSON')
    .action(async (suiteFile: string, caseName: string, options: { json?: boolean }) => {
      const output = new OutputEmitter({ json: options.json });
      try {
        const result = await loadScenarioSuite(suiteFile);
        if (!result.ok) {
          output.error(result.error, 'VALIDATION_ERROR');
          output.flush();
          process.exit(1);
        }

        if (!(caseName in result.suite.cases)) {
          output.error(`Case "${caseName}" not found`, 'SCENARIO_NOT_FOUND', {
            available: Object.keys(result.suite.cases),
          });
          output.flush();
          process.exit(1);
        }

        const c = result.suite.cases[caseName];
        const detailData: Record<string, unknown> = {
          name: caseName,
          file: c.file,
          description: c.description,
          expected: getEffectiveResult(c),
          commands: c.commands,
          tags: c.tags,
        };

        if (c.expect) {
          detailData.expect = c.expect;
        }

        output.detail(detailData, 'custom');
        output.flush();
      } catch (error) {
        output.error(error instanceof Error ? error.message : 'Unknown error', 'UNKNOWN_ERROR');
        output.flush();
        process.exit(1);
      }
    });

  // rd scenario-suite run <suite-file> <case> OR --all
  suite
    .command('run <suite-file> [case]')
    .description('Execute a case (or all cases with --all) from a suite')
    .option('--all', 'Run all cases in the suite')
    .option('-q, --quiet', 'Suppress command output')
    .option('--json', 'Output as JSON')
    .action(
      async (
        suiteFile: string,
        caseName: string | undefined,
        options: { all?: boolean; quiet?: boolean; json?: boolean },
      ) => {
        const output = new OutputEmitter({ json: options.json });
        try {
          const result = await loadScenarioSuite(suiteFile);
          if (!result.ok) {
            output.error(result.error, 'VALIDATION_ERROR');
            if (result.details) {
              for (const detail of result.details) {
                output.message(`  - ${detail}`, 'error');
              }
            }
            output.flush();
            process.exit(1);
          }

          const suiteDir = dirname(resolve(suiteFile));
          const runQuiet = (options.quiet ?? false) || !!options.json;

          if (options.all) {
            // Run all cases
            const caseResults = [];
            let passedCount = 0;
            let failedCount = 0;

            for (const [name, c] of Object.entries(result.suite.cases)) {
              try {
                const caseResult = await executeSuiteCase(name, c, suiteDir, runQuiet, output);
                caseResults.push(caseResult);
                if (caseResult.passed) {
                  passedCount++;
                } else {
                  failedCount++;
                }
              } catch (err: unknown) {
                const msg =
                  typeof err === 'object' && err !== null && 'message' in err
                    ? String((err as { message: unknown }).message)
                    : String(err);
                caseResults.push({
                  passed: false,
                  scenario: name,
                  expected: getEffectiveResult(c),
                  actual: `ERROR: ${msg}`,
                });
                failedCount++;
              }
            }

            const allPassed = failedCount === 0;

            output.detail(
              {
                result: allPassed,
                suite: result.suite.name,
                total: caseResults.length,
                passed: passedCount,
                failed: failedCount,
                cases: caseResults,
              },
              'custom',
            );

            // Display per-case summary in text mode
            if (!options.json) {
              output.message('', 'info');
              for (const cr of caseResults) {
                const icon = cr.passed ? '\u2713' : '\u2717';
                const status = cr.passed ? 'dim' : 'error';
                output.message(
                  `  ${icon} ${cr.scenario}: expected ${cr.expected}, got ${cr.actual}`,
                  status,
                );
              }
            }

            output.flush();

            if (!allPassed) {
              process.exit(1);
            }
          } else if (caseName) {
            // Run single case
            if (!(caseName in result.suite.cases)) {
              output.error(`Case "${caseName}" not found`, 'SCENARIO_NOT_FOUND', {
                available: Object.keys(result.suite.cases),
              });
              output.flush();
              process.exit(1);
            }

            const c = result.suite.cases[caseName];
            const caseResult = await executeSuiteCase(caseName, c, suiteDir, runQuiet, output);

            const detailData: Record<string, unknown> = {
              result: caseResult.passed,
              scenario: caseResult.scenario,
              expected: caseResult.expected,
              actual: caseResult.actual,
            };

            if (caseResult.stepAssertions) {
              detailData.stepAssertions = caseResult.stepAssertions;
            }

            output.detail(detailData, 'custom');

            if (
              !options.json &&
              caseResult.stepAssertions &&
              caseResult.stepAssertions.length > 0
            ) {
              output.message('', 'info');
              output.message('Step Assertions:', 'info');
              for (const sa of caseResult.stepAssertions) {
                const icon = sa.matched ? '\u2713' : '\u2717';
                const status = sa.matched ? 'dim' : 'error';
                output.message(`  ${icon} ${formatStepAssertionDescription(sa)}`, status);
              }
            }

            output.flush();

            if (!caseResult.passed) {
              process.exit(1);
            }
          } else {
            output.error('Specify a case name or use --all to run all cases', 'VALIDATION_ERROR');
            output.flush();
            process.exit(1);
          }
        } catch (error) {
          output.error(error instanceof Error ? error.message : 'Unknown error', 'UNKNOWN_ERROR');
          output.flush();
          process.exit(1);
        }
      },
    );
}
