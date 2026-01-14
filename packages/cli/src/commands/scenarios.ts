import { type Command } from 'commander';
import { readFile, rm } from 'fs/promises';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parseScenarios, type Scenario, type Scenarios } from '../schemas/scenarios.js';
import { resolveWorkflowFile } from '../helpers/resolve-workflow.js';
import { extractRawFrontmatter } from '../helpers/extract-raw-frontmatter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the CLI executable */
const CLI_PATH = join(__dirname, '..', 'cli.js');

/**
 * Register the scenarios command for listing, showing, and running scenarios.
 *
 * @param program - The Commander program instance to register the command on
 */
export function registerScenariosCommand(program: Command): void {
  // Main command: rd scenarios <file> [scenario]
  program
    .command('scenarios <file> [scenario]')
    .description('List or show scenarios from a runbook')
    .option('--run', 'Execute the scenario and verify result')
    .option('-v, --verbose', 'Show command output (with --run)')
    .action(async (file: string, scenarioName: string | undefined, options: { run?: boolean; verbose?: boolean }) => {
      if (options.run && scenarioName) {
        await runScenario(file, scenarioName, options.verbose ?? false);
      } else {
        await handleListOrShow(file, scenarioName);
      }
    });
}

/**
 * Handle listing scenarios or showing details for a specific scenario.
 *
 * @param file - Runbook file path
 * @param scenarioName - Optional scenario name to show details
 */
async function handleListOrShow(file: string, scenarioName?: string): Promise<void> {
  try {
    const cwd = process.cwd();
    const filePath = await resolveWorkflowFile(cwd, file);

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

    if (scenarioName) {
      showScenarioDetails(scenarioName, scenarios);
    } else {
      listScenarios(scenarios);
    }
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
  console.log('Scenarios:\n');

  for (const [name, scenario] of Object.entries(scenarios)) {
    const desc = scenario.description ? ` - ${scenario.description}` : '';
    console.log(`  ${name}${desc}`);
    console.log(`    Commands: ${String(scenario.commands.length)}`);
    console.log(`    Result: ${scenario.result}`);
    console.log();
  }
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

  console.log(`Scenario: ${name}\n`);

  if (scenario.description) {
    console.log(`${scenario.description}\n`);
  }

  console.log('Commands:');
  for (const cmd of scenario.commands) {
    console.log(`  $ ${cmd}`);
  }

  console.log(`\nExpected Result: ${scenario.result}`);
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
 * @param verbose - Whether to show command output
 */
async function runScenario(file: string, scenarioName: string, verbose: boolean): Promise<void> {
  const cwd = process.cwd();

  // 1. Resolve runbook file path
  const filePath = await resolveWorkflowFile(cwd, file);
  if (!filePath) {
    console.error(`Workflow file not found: ${file}`);
    process.exit(1);
  }

  // 2. Parse and validate scenario
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

  if (!scenarios || !(scenarioName in scenarios)) {
    console.error(`Scenario "${scenarioName}" not found`);
    if (scenarios) {
      console.error(`Available: ${Object.keys(scenarios).join(', ')}`);
    }
    process.exit(1);
  }

  const scenario = scenarios[scenarioName];
  const runbookFilename = basename(file);

  // 3. Create isolated temp workspace
  const tmpDir = mkdtempSync(join(tmpdir(), 'rd-scenario-'));
  const runbooksDir = join(tmpDir, '.claude', 'rundown', 'runbooks');
  mkdirSync(runbooksDir, { recursive: true });

  try {
    // 4. Copy runbook and any referenced child workflows
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

    // 5. Execute commands in sequence
    console.log(`Running scenario: ${scenarioName}`);
    if (scenario.description) {
      console.log(`  ${scenario.description}\n`);
    }

    for (const cmd of scenario.commands) {
      console.log(`  $ ${cmd}`);
      // Replace 'rd ' with actual CLI path to avoid shell alias issues
      const actualCmd = cmd.replace(/^rd\s+/, `node ${CLI_PATH} `);
      try {
        const result = execSync(actualCmd, {
          cwd: tmpDir,
          encoding: 'utf-8',
          stdio: verbose ? 'inherit' : 'pipe',
          env: { ...process.env, RUNDOWN_LOG: '0' }
        });
        if (verbose && result) {
          console.log(result);
        }
      } catch (error) {
        // Command may exit non-zero for STOP scenarios, which is expected
        if (verbose && error instanceof Error && 'stdout' in error) {
          console.log((error as { stdout: string }).stdout);
        }
      }
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
    console.log(`\nResult: ${actualResult} (expected: ${scenario.result})`);

    if (actualResult === scenario.result) {
      console.log('✓ PASS');
    } else {
      console.log('✗ FAIL');
      process.exit(1);
    }
  } finally {
    // 8. Cleanup temp directory
    await rm(tmpDir, { recursive: true, force: true });
  }
}
