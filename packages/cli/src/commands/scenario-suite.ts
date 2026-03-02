/**
 * CLI commands for external scenario suite files.
 *
 * Provides `rd scenario-suite ls|show|run` commands for working with
 * standalone `*.scenario-suite.yaml` files.
 *
 * @module commands/scenario-suite
 */

import type { Command } from 'commander';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { parse as shellParse } from 'shell-quote';
import { OutputEmitter } from '../services/output-emitter.js';
import { loadScenarioSuite, type ScenarioSuiteCase } from '../schemas/scenario-suite.js';
import type { AssertionResult, PersistedState } from '../helpers/scenario-workflow.js';
import { evaluateExpectations } from '../helpers/scenario-workflow.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the CLI executable */
const CLI_PATH = join(__dirname, '..', 'cli.js');

/**
 * Get effective result for a suite case, preferring `result` over `expect.result`.
 *
 * @param c - A validated suite case
 * @returns The effective terminal result ('COMPLETE' or 'STOP')
 * @throws {Error} When neither `result` nor `expect.result` is defined
 */
function getCaseEffectiveResult(c: ScenarioSuiteCase): 'COMPLETE' | 'STOP' {
  const result = c.result ?? c.expect?.result;
  if (result === undefined) {
    throw new Error('Suite case has neither result nor expect.result defined');
  }
  return result;
}

/**
 * Execute a single suite case in an isolated temp workspace.
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
  assertions?: AssertionResult[];
}> {
  const effectiveResult = getCaseEffectiveResult(suiteCase);
  const runbookPath = resolve(suiteDir, suiteCase.file);
  const runbookFilename = basename(runbookPath);

  const tmpDir = mkdtempSync(join(tmpdir(), 'rd-suite-'));

  try {
    const runbooksDir = join(tmpDir, '.claude', 'rundown', 'runbooks');
    mkdirSync(runbooksDir, { recursive: true });

    try {
      copyFileSync(runbookPath, join(runbooksDir, runbookFilename));
    } catch {
      return {
        passed: false,
        scenario: caseName,
        expected: effectiveResult,
        actual: `RUNBOOK_NOT_FOUND: ${suiteCase.file}`,
      };
    }

    if (!quiet) {
      output.message('', 'info');
      output.message(`Case: ${caseName}`, 'dim');
      output.message('\u2500'.repeat(50), 'dim');
      output.message('', 'info');
    }

    for (const cmd of suiteCase.commands) {
      if (!quiet) {
        output.message(`$ ${cmd}`, 'info');
      }

      const rdMatch = /^rd\s+(.*)$/.exec(cmd);
      try {
        if (rdMatch) {
          const parsed = shellParse(rdMatch[1]);
          const hasOperators = parsed.some((entry) => typeof entry !== 'string');
          if (hasOperators) {
            throw new Error(
              `Unsupported shell operators in suite command: ${cmd}. ` +
                'Split into separate commands instead of using &&, ||, |, etc.',
            );
          }
          const args = parsed as string[];
          execFileSync('node', [CLI_PATH, ...args], {
            cwd: tmpDir,
            encoding: 'utf-8',
            stdio: quiet ? 'pipe' : 'inherit',
            env: { ...process.env, RUNDOWN_LOG: '0' },
          });
        } else {
          execSync(cmd, {
            cwd: tmpDir,
            encoding: 'utf-8',
            stdio: quiet ? 'pipe' : 'inherit',
            env: { ...process.env, RUNDOWN_LOG: '0' },
          });
        }
      } catch (err: unknown) {
        if (err instanceof Error && !('status' in err)) {
          throw err;
        }
      }
    }

    // Read final state
    const runsDir = join(tmpDir, '.claude', 'rundown', 'runs');
    let actualResult = 'UNKNOWN';
    let persistedState: PersistedState = {};

    try {
      const stateFiles = readdirSync(runsDir).filter((f) => f.endsWith('.json'));
      if (stateFiles.length > 0) {
        const latestFile = stateFiles
          .map((f) => ({ name: f, path: join(runsDir, f) }))
          .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)[0];

        const stateContent = readFileSync(latestFile.path, 'utf-8');
        persistedState = JSON.parse(stateContent) as PersistedState;

        if (persistedState.variables?.completed) {
          actualResult = 'COMPLETE';
        } else if (persistedState.variables?.stopped) {
          actualResult = 'STOP';
        }
      }
    } catch {
      // State file may not exist
    }

    // Evaluate rich assertions if expect block is present
    let assertions: AssertionResult[] | undefined;
    if (suiteCase.expect) {
      const expectResult = evaluateExpectations(persistedState, suiteCase.expect);
      assertions = expectResult.assertions;
      const resultPassed = actualResult === effectiveResult;
      const allPassed = resultPassed && expectResult.passed;
      return {
        passed: allPassed,
        scenario: caseName,
        expected: effectiveResult,
        actual: actualResult,
        assertions,
      };
    }

    const passed = actualResult === effectiveResult;
    return { passed, scenario: caseName, expected: effectiveResult, actual: actualResult };
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
          expected: getCaseEffectiveResult(c),
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
          expected: getCaseEffectiveResult(c),
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
            const caseResult = await executeSuiteCase(name, c, suiteDir, runQuiet, output);
            caseResults.push(caseResult);
            if (caseResult.passed) {
              passedCount++;
            } else {
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

          if (caseResult.assertions) {
            detailData.assertions = caseResult.assertions;
          }

          output.detail(detailData, 'custom');

          if (!options.json && caseResult.assertions) {
            output.message('', 'info');
            output.message('Assertions:', 'info');
            for (const assertion of caseResult.assertions) {
              const icon = assertion.passed ? '\u2713' : '\u2717';
              const status = assertion.passed ? 'dim' : 'error';
              output.message(
                `  ${icon} ${assertion.field}: expected ${JSON.stringify(assertion.expected)}, got ${JSON.stringify(assertion.actual)}`,
                status,
              );
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
      },
    );
}
