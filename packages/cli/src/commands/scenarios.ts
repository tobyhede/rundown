import { type Command } from 'commander';
import { readFile, rm } from 'fs/promises';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  info,
  dim,
  colorizeStatus,
} from '@rundown-org/core';
import { parseScenarios, type Scenario, type Scenarios } from '../schemas/scenarios.js';
import { resolveRunbookFile } from '../helpers/resolve-runbook.js';
import { extractRawFrontmatter } from '../helpers/extract-raw-frontmatter.js';
import { OutputEmitter } from '../services/output-emitter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the CLI executable */
const CLI_PATH = join(__dirname, '..', 'cli.js');

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
      await handleList(file, options.json);
    });

  // rd scenario show <file> <name>
  scenario
    .command('show <file> <name>')
    .description('Show details for a specific scenario')
    .option('--json', 'Output as JSON')
    .action(async (file: string, scenarioName: string, options: { json?: boolean }) => {
      await handleShow(file, scenarioName, options.json);
    });

  // rd scenario run <file> <name>
  scenario
    .command('run <file> <name>')
    .description('Execute a scenario and verify the result')
    .option('-q, --quiet', 'Suppress command output')
    .option('--json', 'Output as JSON for programmatic use')
    .action(async (file: string, scenarioName: string, options: { quiet?: boolean; json?: boolean }) => {
      await runScenario(file, scenarioName, options.quiet ?? false, options.json);
    });
}

/**
 * Load and validate scenarios from a runbook file.
 *
 * @param file - Runbook file path
 * @returns Object with filePath and validated scenarios
 */
interface LoadedRunbook {
  filePath: string;
  name: string;
  description?: string;
  scenarios: Scenarios;
}

async function loadScenarios(file: string, output: OutputEmitter): Promise<LoadedRunbook> {
  const cwd = process.cwd();
  const filePath = await resolveRunbookFile(cwd, file);

  if (!filePath) {
    output.error(`Runbook file not found: ${file}`, 'RUNBOOK_NOT_FOUND');
    output.flush();
    process.exit(1);
  }

  const content = await readFile(filePath, 'utf-8');
  const { frontmatter } = extractRawFrontmatter(content);

  if (!frontmatter) {
    output.error('No frontmatter found in this runbook', 'VALIDATION_ERROR');
    output.flush();
    process.exit(1);
  }

  const { scenarios, errors } = parseScenarios(frontmatter);

  if (errors.length > 0) {
    output.error('Invalid scenarios in frontmatter:', 'VALIDATION_ERROR');
    for (const error of errors) {
      output.message(`  - ${error}`, 'error');
    }
    output.flush();
    process.exit(1);
  }

  if (!scenarios || Object.keys(scenarios).length === 0) {
    output.error('No scenarios defined in this runbook', 'VALIDATION_ERROR');
    output.flush();
    process.exit(1);
  }

  const name = (frontmatter.name as string | undefined) ?? file;
  const description = frontmatter.description as string | undefined;

  return { filePath, name, description, scenarios };
}

/**
 * List all scenarios in a runbook.
 *
 * @param file - Runbook file path
 * @param json - Whether to output as JSON
 */
async function handleList(file: string, json?: boolean): Promise<void> {
  const output = new OutputEmitter({ json });
  try {
    const { scenarios } = await loadScenarios(file, output);
    listScenarios(scenarios, output);
  } catch (error) {
    output.error(error instanceof Error ? error.message : 'Unknown error', 'UNKNOWN_ERROR');
    output.flush();
    process.exit(1);
  }
}

/**
 * Show details for a specific scenario.
 *
 * @param file - Runbook file path
 * @param scenarioName - Name of the scenario to show
 * @param json - Whether to output as JSON
 */
async function handleShow(file: string, scenarioName: string, json?: boolean): Promise<void> {
  const output = new OutputEmitter({ json });
  try {
    const { scenarios } = await loadScenarios(file, output);
    showScenarioDetails(scenarioName, scenarios, output, json);
  } catch (error) {
    output.error(error instanceof Error ? error.message : 'Unknown error', 'UNKNOWN_ERROR');
    output.flush();
    process.exit(1);
  }
}

/**
 * Display a list of all scenarios with their metadata.
 *
 * @param scenarios - Map of scenario names to their definitions
 * @param output - OutputEmitter instance
 */
function listScenarios(scenarios: Scenarios, output: OutputEmitter): void {
  const rows = Object.entries(scenarios).map(([name, scenario]) => {
    const scenarioWithTags = scenario as { tags?: string[] };
    return {
      name,
      expected: scenario.result,
      description: scenario.description ?? '',
      tags: scenarioWithTags.tags?.join(', ') ?? '',
    };
  });

  output.list(rows, [
    { header: 'NAME', key: 'name' },
    { header: 'EXPECTED', key: 'expected' },
    { header: 'DESCRIPTION', key: 'description' },
    { header: 'TAGS', key: 'tags' },
  ]);
  output.flush();
}

/**
 * Display detailed information for a specific scenario.
 *
 * @param name - The name of the scenario to display
 * @param scenarios - Map of scenario names to their definitions
 * @param output - OutputEmitter instance
 * @param json - Whether to output as JSON
 */
function showScenarioDetails(name: string, scenarios: Scenarios, output: OutputEmitter, json?: boolean): void {
  const writer = output.getWriter();

  if (!(name in scenarios)) {
    if (json) {
      output.detail({
        error: true,
        message: `Scenario "${name}" not found`,
        available: Object.keys(scenarios)
      }, 'custom');
      output.flush();
    } else {
      output.error(`Scenario "${name}" not found`, 'SCENARIO_NOT_FOUND', {
        available: Object.keys(scenarios)
      });
      // Write "Available:" to stderr to match expected behavior
      writer.writeError(`Available: ${Object.keys(scenarios).join(', ')}`);
      output.flush();
    }
    process.exit(1);
  }

  const scenario = scenarios[name];

  if (json) {
    output.detail({
      name,
      description: scenario.description,
      expected: scenario.result,
      commands: scenario.commands,
      tags: (scenario as { tags?: string[] }).tags
    }, 'scenario');
    output.flush();
    return;
  }

  // Aligned keys (12 chars = "Description:")
  writer.writeLine(`Name:        ${name}`);
  if (scenario.description) {
    writer.writeLine(`Description: ${scenario.description}`);
  }
  writer.writeLine(`Expected:    ${scenario.result}`);
  writer.writeLine('Commands:');
  for (const cmd of scenario.commands) {
    writer.writeLine(`  $ ${cmd}`);
  }
}

/**
 * Extract referenced runbook files from scenario commands.
 *
 * @param scenario - The scenario to extract references from
 * @returns Array of runbook filenames referenced in commands
 */
function extractReferencedRunbooks(scenario: Scenario): string[] {
  const referenced: string[] = [];
  const runbookPattern = /(\S+\.runbook\.md)/g;

  for (const cmd of scenario.commands) {
    const matches = cmd.match(runbookPattern);
    if (matches) {
      for (const match of matches) {
        if (!referenced.includes(match)) {
          referenced.push(match);
        }
      }
    }
  }

  return referenced;
}

/**
 * Execute a scenario and verify the result.
 *
 * @param file - Runbook file path
 * @param scenarioName - Name of the scenario to run
 * @param quiet - Whether to suppress command output
 * @param json - Whether to output as JSON
 */
async function runScenario(file: string, scenarioName: string, quiet: boolean, json?: boolean): Promise<void> {
  const output = new OutputEmitter({ json });

  // 1. Load and validate scenarios
  const { filePath, scenarios } = await loadScenarios(file, output);

  if (!(scenarioName in scenarios)) {
    if (json) {
      output.detail({
        scenario: scenarioName,
        error: true,
        message: `Scenario "${scenarioName}" not found`,
        available: Object.keys(scenarios),
      });
      output.flush();
    } else {
      output.error(`Scenario "${scenarioName}" not found`, 'SCENARIO_NOT_FOUND', {
        available: Object.keys(scenarios)
      });
      // Write "Available:" to stderr to match expected behavior
      output.getWriter().writeError(`Available: ${Object.keys(scenarios).join(', ')}`);
      output.flush();
    }
    process.exit(1);
  }

  const scenario = scenarios[scenarioName];
  const runbookFilename = basename(file);

  // 2. Create isolated temp workspace
  const tmpDir = mkdtempSync(join(tmpdir(), 'rd-scenario-'));
  const runbooksDir = join(tmpDir, '.claude', 'rundown', 'runbooks');
  mkdirSync(runbooksDir, { recursive: true });

  try {
    // 3. Copy runbook and any referenced child runbooks
    copyFileSync(filePath, join(runbooksDir, runbookFilename));

    const referenced = extractReferencedRunbooks(scenario);
    const sourceDir = dirname(filePath);
    for (const ref of referenced) {
      if (ref !== runbookFilename) {
        try {
          copyFileSync(join(sourceDir, ref), join(runbooksDir, ref));
        } catch {
          // Referenced file may not exist, which is fine
        }
      }
    }

    // 4. Print scenario header (text mode only)
    if (!json) {
      const writer = output.getWriter();
      writer.writeLine('');
      writer.writeLine(`${dim('Scenario:')}  ${info(scenarioName)}`);
      writer.writeLine(dim('─'.repeat(50)));
      writer.writeLine('');
    }

    // 5. Execute commands in sequence
    // In JSON mode, always run quietly (suppress output)
    const runQuiet = quiet || !!json;
    for (const cmd of scenario.commands) {
      if (!runQuiet) {
        const writer = output.getWriter();
        writer.writeLine('');
        writer.writeLine(dim('━'.repeat(50)));
        writer.writeLine(`${info('$')} ${cmd}`);
        writer.writeLine('');
      }

      // Replace 'rd ' with actual CLI path to avoid shell alias issues
      const actualCmd = cmd.replace(/^rd\s+/, `node ${CLI_PATH} `);
      try {
        execSync(actualCmd, {
          cwd: tmpDir,
          encoding: 'utf-8',
          stdio: runQuiet ? 'pipe' : 'inherit',
          env: { ...process.env, RUNDOWN_LOG: '0' }
        });
      } catch {
        // Command may exit non-zero for STOP scenarios, which is expected
      }
    }

    if (!runQuiet) {
      const writer = output.getWriter();
      writer.writeLine('');
    }

    // 6. Check final state
    const runsDir = join(tmpDir, '.claude', 'rundown', 'runs');
    let actualResult = 'UNKNOWN';

    try {
      const stateFiles = readdirSync(runsDir).filter(f => f.endsWith('.json'));
      if (stateFiles.length > 0) {
        // Get most recently modified state file
        const latestFile = stateFiles
          .map(f => ({ name: f, path: join(runsDir, f) }))
          .sort((a, b) => {
            const statA = readFileSync(a.path, 'utf-8');
            const statB = readFileSync(b.path, 'utf-8');
            return statB.length - statA.length; // Simple heuristic: longer = more recent
          })[0];

        const stateContent = readFileSync(latestFile.path, 'utf-8');
        const state = JSON.parse(stateContent) as { variables?: { completed?: boolean; stopped?: boolean } };

        if (state.variables?.completed) {
          actualResult = 'COMPLETE';
        } else if (state.variables?.stopped) {
          actualResult = 'STOP';
        }
      }
    } catch {
      // State file may not exist
    }

    // 7. Report result
    const passed = actualResult === scenario.result;

    if (json) {
      output.detail({
        result: passed,
        scenario: scenarioName,
        expected: scenario.result,
        actual: actualResult,
      });
      output.flush();
    } else {
      const writer = output.getWriter();
      writer.writeLine(`Scenario: ${colorizeStatus(actualResult)}`);
    }

    if (!passed) {
      process.exit(1);
    }
  } finally {
    // 8. Cleanup temp directory
    await rm(tmpDir, { recursive: true, force: true });
  }
}
