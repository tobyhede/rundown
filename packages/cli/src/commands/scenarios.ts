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
} from '@rundown/core';
import { parseScenarios, type Scenario, type Scenarios } from '../schemas/scenarios.js';
import { resolveRunbookFile } from '../helpers/resolve-runbook.js';
import { extractRawFrontmatter } from '../helpers/extract-raw-frontmatter.js';
import { printTable } from '../helpers/table-formatter.js';

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
    .action(async (file: string) => {
      await handleList(file);
    });

  // rd scenario show <file> <name>
  scenario
    .command('show <file> <name>')
    .description('Show details for a specific scenario')
    .action(async (file: string, scenarioName: string) => {
      await handleShow(file, scenarioName);
    });

  // rd scenario run <file> <name>
  scenario
    .command('run <file> <name>')
    .description('Execute a scenario and verify the result')
    .option('-q, --quiet', 'Suppress command output')
    .action(async (file: string, scenarioName: string, options: { quiet?: boolean }) => {
      await runScenario(file, scenarioName, options.quiet ?? false);
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

async function loadScenarios(file: string): Promise<LoadedRunbook> {
  const cwd = process.cwd();
  const filePath = await resolveRunbookFile(cwd, file);

  if (!filePath) {
    console.error(`Workflow file not found: ${file}`);
    process.exit(1);
  }

  const content = await readFile(filePath, 'utf-8');
  const { frontmatter } = extractRawFrontmatter(content);

  if (!frontmatter) {
    console.error('No frontmatter found in this runbook');
    process.exit(1);
  }

  const { scenarios, errors } = parseScenarios(frontmatter);

  if (errors.length > 0) {
    console.error('Invalid scenarios in frontmatter:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  if (!scenarios || Object.keys(scenarios).length === 0) {
    console.error('No scenarios defined in this runbook');
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
 */
async function handleList(file: string): Promise<void> {
  try {
    const { scenarios } = await loadScenarios(file);
    listScenarios(scenarios);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}

/**
 * Show details for a specific scenario.
 *
 * @param file - Runbook file path
 * @param scenarioName - Name of the scenario to show
 */
async function handleShow(file: string, scenarioName: string): Promise<void> {
  try {
    const { scenarios } = await loadScenarios(file);
    showScenarioDetails(scenarioName, scenarios);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}

/**
 * Display a list of all scenarios with their metadata.
 *
 * @param scenarios - Map of scenario names to their definitions
 */
function listScenarios(scenarios: Scenarios): void {
  const rows = Object.entries(scenarios).map(([name, scenario]) => {
    const scenarioWithTags = scenario as { tags?: string[] };
    return {
      name,
      expected: scenario.result,
      description: scenario.description ?? '',
      tags: scenarioWithTags.tags?.join(', ') ?? '',
    };
  });

  printTable(rows, [
    { header: 'NAME', key: 'name' },
    { header: 'EXPECTED', key: 'expected' },
    { header: 'DESCRIPTION', key: 'description' },
    { header: 'TAGS', key: 'tags' },
  ]);
}

/**
 * Display detailed information for a specific scenario.
 *
 * @param name - The name of the scenario to display
 * @param scenarios - Map of scenario names to their definitions
 */
function showScenarioDetails(name: string, scenarios: Scenarios): void {
  if (!(name in scenarios)) {
    console.error(`Scenario "${name}" not found`);
    console.error(`Available: ${Object.keys(scenarios).join(', ')}`);
    process.exit(1);
  }

  const scenario = scenarios[name];

  // Aligned keys (12 chars = "Description:")
  console.log(`Name:        ${name}`);
  if (scenario.description) {
    console.log(`Description: ${scenario.description}`);
  }
  console.log(`Expected:    ${scenario.result}`);
  console.log('Commands:');
  for (const cmd of scenario.commands) {
    console.log(`  $ ${cmd}`);
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
 */
async function runScenario(file: string, scenarioName: string, quiet: boolean): Promise<void> {
  // 1. Load and validate scenarios
  const { filePath, scenarios } = await loadScenarios(file);

  if (!(scenarioName in scenarios)) {
    console.error(`Scenario "${scenarioName}" not found`);
    console.error(`Available: ${Object.keys(scenarios).join(', ')}`);
    process.exit(1);
  }

  const scenario = scenarios[scenarioName];
  const runbookFilename = basename(file);

  // 2. Create isolated temp workspace
  const tmpDir = mkdtempSync(join(tmpdir(), 'rd-scenario-'));
  const runbooksDir = join(tmpDir, '.claude', 'rundown', 'runbooks');
  mkdirSync(runbooksDir, { recursive: true });

  try {
    // 3. Copy runbook and any referenced child workflows
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

    // 4. Print scenario header
    console.log();
    console.log(`${dim('Scenario:')}  ${info(scenarioName)}`);
    console.log(dim('─'.repeat(50)));
    console.log();

    // 5. Execute commands in sequence
    const totalCommands = scenario.commands.length;
    for (let i = 0; i < scenario.commands.length; i++) {
      const cmd = scenario.commands[i];
      const cmdNum = i + 1;

      if (!quiet) {
        // Clear visual separator between commands
        console.log();
        console.log(dim(`━━━ [${cmdNum}/${totalCommands}] ${'━'.repeat(40)}`));
        console.log(`${info('▶')} ${cmd}`);
        console.log();
      }

      // Replace 'rd ' with actual CLI path to avoid shell alias issues
      const actualCmd = cmd.replace(/^rd\s+/, `node ${CLI_PATH} `);
      try {
        execSync(actualCmd, {
          cwd: tmpDir,
          encoding: 'utf-8',
          stdio: quiet ? 'pipe' : 'inherit',
          env: { ...process.env, RUNDOWN_LOG: '0' }
        });
      } catch {
        // Command may exit non-zero for STOP scenarios, which is expected
      }
    }

    if (!quiet) {
      console.log();
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
    const matches = actualResult === scenario.result;

    if (!quiet) {
      console.log();
      console.log(dim('━'.repeat(50)));
    }
    console.log(`${dim('Result:')}    ${colorizeStatus(actualResult)}`);

    if (!matches) {
      process.exit(1);
    }
  } finally {
    // 8. Cleanup temp directory
    await rm(tmpDir, { recursive: true, force: true });
  }
}
