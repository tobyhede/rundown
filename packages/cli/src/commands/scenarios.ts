import { type Command } from 'commander';
import { readFile } from 'fs/promises';
import { parseScenarios, type Scenarios } from '../schemas/scenarios.js';
import { resolveWorkflowFile } from '../helpers/resolve-workflow.js';
import { extractRawFrontmatter } from '../helpers/extract-raw-frontmatter.js';

/**
 * Register the scenarios command for listing and running scenarios.
 */
export function registerScenariosCommand(program: Command): void {
  program
    .command('scenarios <file> [scenario]')
    .description('List or run scenarios from a runbook')
    .action(async (file: string, scenarioName?: string) => {
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
    });
}

function listScenarios(scenarios: Scenarios): void {
  console.log('Scenarios:\n');

  for (const [name, scenario] of Object.entries(scenarios)) {
    const desc = scenario.description ? ` - ${scenario.description}` : '';
    console.log(`  ${name}${desc}`);
    console.log(`    Commands: ${scenario.commands.length}`);
    console.log(`    Result: ${scenario.result}`);
    console.log();
  }
}

function showScenarioDetails(name: string, scenarios: Scenarios): void {
  const scenario = scenarios[name];

  if (!scenario) {
    console.error(`Scenario "${name}" not found`);
    console.error(`Available: ${Object.keys(scenarios).join(', ')}`);
    process.exit(1);
  }

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
