import type { Command } from 'commander';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getErrorMessage } from '@rundown-org/core';
import { OutputEmitter } from '../services/output-emitter.js';
import {
  formatErrorAssertionDescription,
  formatArtifactAssertionDescription,
  formatEnteredAssertionDescription,
  formatStepAssertionDescription,
} from '../helpers/command-sequence.js';
import {
  loadScenarios,
  buildScenarioListRows,
  buildScenarioDetail,
  executeScenario,
} from '../helpers/scenario-workflow.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the CLI executable — resolves from compiled output or source (ts-jest). */
const CLI_PATH = (() => {
  const adjacent = join(__dirname, '..', 'cli.js');
  if (existsSync(adjacent)) return adjacent;
  return join(__dirname, '..', '..', 'dist', 'cli.js');
})();

/**
 * Emit a load-failure result to the output and exit.
 * @param result - Load failure result containing error information
 * @param result.error - Human-readable error message
 * @param result.code - Machine-readable error code
 * @param result.details - Optional detailed validation messages
 * @param output - Output emitter for rendering the error
 */
function emitLoadError(
  result: { error: string; code: string; details?: string[] },
  output: OutputEmitter,
): never {
  output.error(result.error, result.code);
  if (result.details) {
    for (const detail of result.details) {
      output.message(`  - ${detail}`, 'error');
    }
  }
  output.flush();
  process.exit(1);
}

/**
 * Register the scenarios command with subcommands for listing, showing, and running scenarios.
 *
 * @param program - The Commander program instance to register the command on
 */
export function registerScenariosCommand(program: Command): void {
  const scenario = program
    .command('scenario')
    .description('List, show, or run scenarios from a runbook');

  // rd scenario ls <file>
  scenario
    .command('ls <file>')
    .description('List all scenarios in a runbook')
    .option('--text', 'Output as human-readable text')
    .action(async (file: string, options: { text?: boolean }) => {
      const output = new OutputEmitter({ text: options.text, command: 'scenario ls' });
      try {
        const result = await loadScenarios(file, process.cwd());
        if (!result.ok) {
          emitLoadError(result, output);
        }

        const rows = buildScenarioListRows(result.loaded.scenarios);
        output.list(rows, [
          { header: 'NAME', key: 'name' },
          { header: 'EXPECTED', key: 'expected' },
          { header: 'DESCRIPTION', key: 'description' },
          { header: 'TAGS', key: 'tags' },
        ]);
        output.flush();
      } catch (error) {
        output.error(getErrorMessage(error), 'UNKNOWN_ERROR');
        output.flush();
        process.exit(1);
      }
    });

  // rd scenario show <file> <name>
  scenario
    .command('show <file> <name>')
    .description('Show details for a specific scenario')
    .option('--text', 'Output as human-readable text')
    .action(async (file: string, scenarioName: string, options: { text?: boolean }) => {
      const output = new OutputEmitter({ text: options.text, command: 'scenario show' });
      try {
        const result = await loadScenarios(file, process.cwd());
        if (!result.ok) {
          emitLoadError(result, output);
        }

        const detail = buildScenarioDetail(scenarioName, result.loaded.scenarios);
        if (!detail) {
          output.error(`Scenario "${scenarioName}" not found`, 'SCENARIO_NOT_FOUND', {
            available: Object.keys(result.loaded.scenarios),
          });
          output.flush();
          process.exit(1);
        }

        // Build detail data for output, including expect block when present
        const detailData: Record<string, unknown> = {
          name: detail.name,
          description: detail.description,
          expected: detail.expected,
          commands: detail.commands,
          tags: detail.tags,
        };

        if (detail.expect) {
          detailData.expect = detail.expect;
        }

        output.detail(detailData, 'scenario');
        output.flush();
      } catch (error) {
        output.error(getErrorMessage(error), 'UNKNOWN_ERROR');
        output.flush();
        process.exit(1);
      }
    });

  // rd scenario run <file> <name>
  scenario
    .command('run <file> <name>')
    .description('Execute a scenario and verify the result')
    .option('-q, --quiet', 'Suppress command output')
    .option('--text', 'Output as human-readable text')
    .action(
      async (file: string, scenarioName: string, options: { quiet?: boolean; text?: boolean }) => {
        const output = new OutputEmitter({ text: options.text, command: 'scenario run' });

        const result = await loadScenarios(file, process.cwd());
        if (!result.ok) {
          emitLoadError(result, output);
        }

        if (!(scenarioName in result.loaded.scenarios)) {
          output.error(`Scenario "${scenarioName}" not found`, 'SCENARIO_NOT_FOUND', {
            available: Object.keys(result.loaded.scenarios),
          });
          output.flush();
          process.exit(1);
        }

        const runQuiet = (options.quiet ?? false) || !options.text;

        const runResult = await executeScenario(
          result.loaded,
          scenarioName,
          runQuiet,
          output,
          CLI_PATH,
        );

        // Build output data including assertions if present
        const detailData: Record<string, unknown> = {
          result: runResult.passed,
          scenario: runResult.scenario,
          expected: runResult.expected,
          actual: runResult.actual,
        };

        if (runResult.stepAssertions) {
          detailData.stepAssertions = runResult.stepAssertions;
        }
        if (runResult.errorAssertions) {
          detailData.errorAssertions = runResult.errorAssertions;
        }
        if (runResult.artifactAssertions) {
          detailData.artifactAssertions = runResult.artifactAssertions;
        }
        if (runResult.enteredAssertions) {
          detailData.enteredAssertions = runResult.enteredAssertions;
        }

        output.detail(detailData, 'scenario_result');

        // Display step assertions in text mode
        if (options.text && runResult.stepAssertions && runResult.stepAssertions.length > 0) {
          output.message('', 'info');
          output.message('Step Assertions:', 'info');
          for (const sa of runResult.stepAssertions) {
            const icon = sa.matched ? '\u2713' : '\u2717';
            const status = sa.matched ? 'dim' : 'error';
            output.message(`  ${icon} ${formatStepAssertionDescription(sa)}`, status);
          }
        }
        if (options.text && runResult.errorAssertions && runResult.errorAssertions.length > 0) {
          output.message('', 'info');
          output.message('Error Assertions:', 'info');
          for (const ea of runResult.errorAssertions) {
            const icon = ea.matched ? '\u2713' : '\u2717';
            const status = ea.matched ? 'dim' : 'error';
            output.message(`  ${icon} ${formatErrorAssertionDescription(ea)}`, status);
          }
        }
        if (
          options.text &&
          runResult.artifactAssertions &&
          runResult.artifactAssertions.length > 0
        ) {
          output.message('', 'info');
          output.message('Artifact Assertions:', 'info');
          for (const aa of runResult.artifactAssertions) {
            const icon = aa.matched ? '\u2713' : '\u2717';
            const status = aa.matched ? 'dim' : 'error';
            output.message(`  ${icon} ${formatArtifactAssertionDescription(aa)}`, status);
          }
        }
        if (options.text && runResult.enteredAssertions && runResult.enteredAssertions.length > 0) {
          output.message('', 'info');
          output.message('Entered Assertions:', 'info');
          for (const ea of runResult.enteredAssertions) {
            const icon = ea.matched ? '\u2713' : '\u2717';
            const status = ea.matched ? 'dim' : 'error';
            output.message(`  ${icon} ${formatEnteredAssertionDescription(ea)}`, status);
          }
        }

        output.flush();

        if (!runResult.passed) {
          process.exit(1);
        }
      },
    );
}
