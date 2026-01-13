import { createTestWorkspace, runCli, getActiveState, readSession, type TestWorkspace } from '../helpers/test-utils.js';
import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractRawFrontmatter } from '../../src/helpers/extract-raw-frontmatter.js';
import { parseScenarios, type Scenario, type Scenarios } from '../../src/schemas/scenarios.js';
import { copyFileSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Data-driven test runner that executes scenarios from pattern files.
 */
describe('scenario runner', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /**
   * Load pattern files that have scenarios defined.
   */
  async function loadPatternsWithScenarios(): Promise<Array<{ file: string; scenarios: Scenarios }>> {
    const patternsDir = join(__dirname, '..', '..', '..', '..', 'runbooks', 'patterns');
    const files = await readdir(patternsDir);
    const results: Array<{ file: string; scenarios: Scenarios }> = [];

    for (const file of files) {
      if (!file.endsWith('.runbook.md')) continue;

      const content = await readFile(join(patternsDir, file), 'utf-8');
      const { frontmatter } = extractRawFrontmatter(content);
      if (!frontmatter) continue;

      const { scenarios } = parseScenarios(frontmatter);

      if (scenarios && Object.keys(scenarios).length > 0) {
        results.push({ file, scenarios });
      }
    }

    return results;
  }

  /**
   * Copy a pattern file to the test workspace.
   */
  function copyPatternToWorkspace(filename: string): void {
    const patternsDir = join(__dirname, '..', '..', '..', '..', 'runbooks', 'patterns');
    const targetDir = join(workspace.cwd, '.claude', 'rundown', 'runbooks');
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(join(patternsDir, filename), join(targetDir, filename));
  }

  /**
   * Execute a scenario's commands and verify the result.
   */
  async function executeScenario(filename: string, name: string, scenario: Scenario): Promise<void> {
    copyPatternToWorkspace(filename);

    // Execute each command in sequence, checking exit codes
    for (let i = 0; i < scenario.commands.length; i++) {
      const cmd = scenario.commands[i];
      const isLastCommand = i === scenario.commands.length - 1;

      // Strip 'rd ' prefix and run
      const args = cmd.replace(/^rd\s+/, '');
      const result = runCli(args, workspace);

      // Check exit codes:
      // - Non-last commands must succeed
      // - Last command may fail only for STOP scenarios (e.g., rd fail causes stop)
      const allowNonZero = isLastCommand && scenario.result === 'STOP';
      if (!allowNonZero && result.exitCode !== 0) {
        throw new Error(`Command "${cmd}" failed with exit code ${result.exitCode}: ${result.stderr}`);
      }
    }

    // Verify result
    const state = await getActiveState(workspace);

    if (scenario.result === 'COMPLETE') {
      expect(state?.variables?.completed).toBe(true);
    } else if (scenario.result === 'STOP') {
      expect(state?.variables?.stopped).toBe(true);
    }
  }

  it('runs all pattern scenarios', async () => {
    const patterns = await loadPatternsWithScenarios();

    if (patterns.length === 0) {
      console.log('No patterns with scenarios found - skipping');
      return;
    }

    for (const { file, scenarios } of patterns) {
      for (const [name, scenario] of Object.entries(scenarios)) {
        // Reset workspace for each scenario
        await workspace.cleanup();
        workspace = await createTestWorkspace();

        try {
          await executeScenario(file, name, scenario);
        } catch (error) {
          throw new Error(`Failed: ${file} / ${name}: ${error}`);
        }
      }
    }
  });
});
