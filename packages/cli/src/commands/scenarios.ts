import type { Command } from 'commander';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OutputEmitter } from '../services/output-emitter.js';
import { formatStepAssertionDescription } from '../helpers/command-sequence.js';
import {
  loadScenarios,
  buildScenarioListRows,
  buildScenarioDetail,
  executeScenario,
} from '../helpers/scenario-workflow.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the CLI executable */
const CLI_PATH = join(__dirname, '..', 'cli.js');

/**
 * Emit a load-failure result to the output and exit.
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
    .option('--json', 'Output as JSON')
    .action(async (file: string, options: { json?: boolean }) => {
      const output = new OutputEmitter({ json: options.json });
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
        output.error(error instanceof Error ? error.message : 'Unknown error', 'UNKNOWN_ERROR');
        output.flush();
        process.exit(1);
      }
    });

  // rd scenario show <file> <name>
  scenario
    .command('show <file> <name>')
    .description('Show details for a specific scenario')
    .option('--json', 'Output as JSON')
    .action(async (file: string, scenarioName: string, options: { json?: boolean }) => {
      const output = new OutputEmitter({ json: options.json });
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
        output.error(error instanceof Error ? error.message : 'Unknown error', 'UNKNOWN_ERROR');
        output.flush();
        process.exit(1);
      }
    });

  // rd scenario run <file> <name>
  scenario
    .command('run <file> <name>')
    .description('Execute a scenario and verify the result')
    .option('-q, --quiet', 'Suppress command output')
    .option('--json', 'Output as JSON for programmatic use')
    .action(
      async (file: string, scenarioName: string, options: { quiet?: boolean; json?: boolean }) => {
        const output = new OutputEmitter({ json: options.json });

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

        const runQuiet = (options.quiet ?? false) || !!options.json;

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

        output.detail(detailData, 'scenario_result');

        // Display step assertions in text mode
        if (!options.json && runResult.stepAssertions && runResult.stepAssertions.length > 0) {
          output.message('', 'info');
          output.message('Step Assertions:', 'info');
          for (const sa of runResult.stepAssertions) {
            const icon = sa.matched ? '\u2713' : '\u2717';
            const status = sa.matched ? 'dim' : 'error';
            output.message(`  ${icon} ${formatStepAssertionDescription(sa)}`, status);
          }
        }

        output.flush();

        if (!runResult.passed) {
          process.exit(1);
        }
      },
    );
}
