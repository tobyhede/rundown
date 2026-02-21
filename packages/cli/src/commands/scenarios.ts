import type { Command } from 'commander';
import { readFile, rm } from 'node:fs/promises';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as shellParse } from 'shell-quote';
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
    .action(
      async (file: string, scenarioName: string, options: { quiet?: boolean; json?: boolean }) => {
        await runScenario(file, scenarioName, options.quiet ?? false, options.json);
      },
    );
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
    showScenarioDetails(scenarioName, scenarios, output);
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
 * Uses unified output - TextRenderer formats 'scenario' detail events
 * with aligned key-value pairs, JSONRenderer outputs the raw data.
 *
 * @param name - The name of the scenario to display
 * @param scenarios - Map of scenario names to their definitions
 * @param output - OutputEmitter instance
 */
function showScenarioDetails(name: string, scenarios: Scenarios, output: OutputEmitter): void {
  if (!(name in scenarios)) {
    output.error(`Scenario "${name}" not found`, 'SCENARIO_NOT_FOUND', {
      available: Object.keys(scenarios),
    });
    output.flush();
    process.exit(1);
  }

  const scenario = scenarios[name];

  // Emit unified scenario detail - renderer handles formatting
  output.detail(
    {
      name,
      description: scenario.description,
      expected: scenario.result,
      commands: scenario.commands,
      tags: (scenario as { tags?: string[] }).tags,
    },
    'scenario',
  );
  output.flush();
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
 * Progress output (scenario header, command headers) is suppressed in quiet
 * mode or JSON mode, as these modes indicate the user wants clean output.
 * The final result is emitted via unified output.detail() with 'scenario_result'
 * format, which the renderer handles appropriately.
 *
 * @param file - Runbook file path
 * @param scenarioName - Name of the scenario to run
 * @param quiet - Whether to suppress command output
 * @param json - Whether to output as JSON
 */
async function runScenario(
  file: string,
  scenarioName: string,
  quiet: boolean,
  json?: boolean,
): Promise<void> {
  const output = new OutputEmitter({ json });

  // 1. Load and validate scenarios
  const { filePath, scenarios } = await loadScenarios(file, output);

  if (!(scenarioName in scenarios)) {
    output.error(`Scenario "${scenarioName}" not found`, 'SCENARIO_NOT_FOUND', {
      available: Object.keys(scenarios),
    });
    output.flush();
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

    // 4. Execute commands in sequence
    // Suppress progress output in quiet mode or JSON mode
    const runQuiet = quiet || !!json;

    // Print scenario header (verbose mode only)
    if (!runQuiet) {
      output.message('', 'info');
      output.message(`Scenario:  ${scenarioName}`, 'dim');
      output.message('─'.repeat(50), 'dim');
      output.message('', 'info');
    }

    for (const cmd of scenario.commands) {
      if (!runQuiet) {
        output.message('', 'info');
        output.message('━'.repeat(50), 'dim');
        output.message(`$ ${cmd}`, 'info');
        output.message('', 'info');
      }

      // Route 'rd' commands through execFileSync to avoid shell injection
      const rdMatch = /^rd\s+(.*)$/.exec(cmd);
      try {
        if (rdMatch) {
          const args = shellParse(rdMatch[1]).filter(
            (entry): entry is string => typeof entry === 'string',
          );
          execFileSync('node', [CLI_PATH, ...args], {
            cwd: tmpDir,
            encoding: 'utf-8',
            stdio: runQuiet ? 'pipe' : 'inherit',
            env: { ...process.env, RUNDOWN_LOG: '0' },
          });
        } else {
          // Non-rd commands are author-defined scenario commands — inherently trusted
          execSync(cmd, {
            cwd: tmpDir,
            encoding: 'utf-8',
            stdio: runQuiet ? 'pipe' : 'inherit',
            env: { ...process.env, RUNDOWN_LOG: '0' },
          });
        }
      } catch {
        // Command may exit non-zero for STOP scenarios, which is expected
      }
    }

    if (!runQuiet) {
      output.message('', 'info');
    }

    // 5. Check final state
    const runsDir = join(tmpDir, '.claude', 'rundown', 'runs');
    let actualResult = 'UNKNOWN';

    try {
      const stateFiles = readdirSync(runsDir).filter((f) => f.endsWith('.json'));
      if (stateFiles.length > 0) {
        // Get most recently modified state file
        const latestFile = stateFiles
          .map((f) => ({ name: f, path: join(runsDir, f) }))
          .sort((a, b) => {
            const statA = readFileSync(a.path, 'utf-8');
            const statB = readFileSync(b.path, 'utf-8');
            return statB.length - statA.length; // Simple heuristic: longer = more recent
          })[0];

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

    // 6. Report result using unified output
    const passed = actualResult === scenario.result;

    output.detail(
      {
        result: passed,
        scenario: scenarioName,
        expected: scenario.result,
        actual: actualResult,
      },
      'scenario_result',
    );
    output.flush();

    if (!passed) {
      process.exit(1);
    }
  } finally {
    // 7. Cleanup temp directory
    await rm(tmpDir, { recursive: true, force: true });
  }
}
