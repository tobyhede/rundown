import { createTestWorkspace, runCli, getAllStates, type TestWorkspace } from '../helpers/test-utils.js';
import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractRawFrontmatter } from '../../src/helpers/extract-raw-frontmatter.js';
import { parseScenarios, type Scenario, type Scenarios } from '../../src/schemas/scenarios.js';
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'fs';

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
   * Recursively get all files in a directory.
   */
  async function getFiles(dir: string): Promise<string[]> {
    const dirents = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(dirents.map((dirent) => {
      const res = join(dir, dirent.name);
      return dirent.isDirectory() ? getFiles(res) : Promise.resolve([res]);
    }));
    return Array.prototype.concat(...files);
  }

  /**
   * Load pattern files that have scenarios defined.
   */
  async function loadPatternsWithScenarios(): Promise<{ file: string; scenarios: Scenarios }[]> {
    const patternsDir = join(__dirname, '..', '..', '..', '..', 'runbooks', 'patterns');
    const allFiles = await getFiles(patternsDir);
    const results: { file: string; scenarios: Scenarios }[] = [];

    for (const filePath of allFiles) {
      if (!filePath.endsWith('.runbook.md')) continue;

      const content = await readFile(filePath, 'utf-8');
      const { frontmatter } = extractRawFrontmatter(content);
      if (!frontmatter) continue;

      const { scenarios } = parseScenarios(frontmatter);

      if (scenarios && Object.keys(scenarios).length > 0) {
        // Store relative path from patterns dir to maintain identity, 
        // but for now we might handle filenames.
        // let's store the filename for compatibility with existing logic
        // or store the full path?
        // The existing logic uses 'file' variable which was filename.
        // Let's pass the absolute path or relative path.
        // The copyPatternToWorkspace uses it to find the file.
        // Let's use relative path from patternsDir.
        const relativePath = filePath.substring(patternsDir.length + 1);
        results.push({ file: relativePath, scenarios });
      }
    }

    return results;
  }

  /**
   * Copy a pattern file to the test workspace.
   * Handles files in subdirectories by flattening them to the target directory.
   */
  function copyPatternToWorkspace(relativePath: string): void {
    const patternsDir = join(__dirname, '..', '..', '..', '..', 'runbooks', 'patterns');
    const sourcePath = join(patternsDir, relativePath);
    const targetDir = join(workspace.cwd, '.claude', 'rundown', 'runbooks');
    const filename = relativePath.split('/').pop()!; // Flatten: use basename
    
    mkdirSync(targetDir, { recursive: true });
    
    // If we are given just a filename (from a reference), we need to find it
    // because references in runbooks (e.g. "child.runbook.md") don't have paths.
    // If the file is not found at sourcePath, search for it.
    try {
      copyFileSync(sourcePath, join(targetDir, filename));
    } catch (err) {
      // Fallback: If strict path failed, try to find the file by name in the patterns dir
      // This handles the case where a runbook references another runbook by name
      // but we don't know its subdirectory.
      // NOTE: This assumes unique filenames across all subdirectories.
      const foundPath = findFileByName(patternsDir, filename);
      if (foundPath) {
        copyFileSync(foundPath, join(targetDir, filename));
      } else {
        throw err;
      }
    }
  }

  function findFileByName(dir: string, filename: string): string | null {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        const found = findFileByName(fullPath, filename);
        if (found) return found;
      } else if (entry === filename) {
        return fullPath;
      }
    }
    return null;
  }

  /**
   * Extract referenced runbook files from scenario commands.


  /**
   * Extract referenced runbook files from scenario commands.
   * Finds patterns like: rd run --step 1 child-task.runbook.md
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
   * Copy a pattern file and all its referenced child workflows to the test workspace.
   */
  function copyPatternWithDependencies(filename: string, scenario: Scenario): void {
    // Copy main pattern file
    copyPatternToWorkspace(filename);

    // Copy any referenced child workflows
    const referenced = extractReferencedRunbooks(scenario);
    for (const ref of referenced) {
      // Skip the main file if it appears in commands
      if (ref !== filename) {
        try {
          copyPatternToWorkspace(ref);
        } catch (err) {
          console.warn(`Failed to copy referenced runbook ${ref}:`, err);
          // File may not exist in patterns dir, which is fine
        }
      }
    }
  }

  /**
   * Execute a scenario's commands and verify the result.
   */
  async function executeScenario(filename: string, scenario: Scenario): Promise<void> {
    copyPatternWithDependencies(filename, scenario);

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

              // - Agent fail commands may exit with 1 if child workflow stops (expected behavior)

              const isAgentFail = cmd.includes('fail') && cmd.includes('--agent');

              const allowNonZero = (isLastCommand && scenario.result === 'STOP') || isAgentFail;

              if (!allowNonZero && result.exitCode !== 0) {

                throw new Error(`Command "${cmd}" failed with exit code ${String(result.exitCode)}: ${result.stderr}`);

              }

            }

        

            // Verify result - use getAllStates since completed workflows have no active state

            const states = await getAllStates(workspace);

            const expectedName = filename.split('/').pop()!;


            // Find state that matches both the workflow filename AND the expected result
            // This handles agent binding scenarios where multiple states exist for the same workflow
            const matchingStates = states.filter(s => {

              const workflowPath = s.workflow as string;

              return workflowPath.endsWith(expectedName);

            });



            if (matchingStates.length === 0) {
              const allWorkflowPaths = states.map(s => s.workflow).join(', ');
              throw new Error(`No state found for runbook ${filename}. Found paths: [${allWorkflowPaths}]`);
            }


            // Find the state with the expected result
            const state = matchingStates.find(s => {
              const variables = s.variables as Record<string, unknown> | undefined;
              if (scenario.result === 'COMPLETE') {
                return variables?.completed === true;
              } else {
                return variables?.stopped === true;
              }
            });

            if (!state) {
              // Provide helpful error message
              const statesSummary = matchingStates.map(s => {
                const vars = s.variables as Record<string, unknown> | undefined;
                const varsStr = vars ? JSON.stringify(vars) : 'undefined';
                return `ID=${String(s.id).slice(0, 8)}, vars=${varsStr}`;
              }).join('; ');
              throw new Error(`No state with expected result ${scenario.result} found for runbook ${filename}. Found states: [${statesSummary}]`);
            }

            const variables = state.variables as Record<string, unknown> | undefined;



            if (scenario.result === 'COMPLETE') {

              expect(variables?.completed).toBe(true);

            } else {

              expect(variables?.stopped).toBe(true);

            }

          }

        

  it('runs all pattern scenarios', async () => {
    const patterns = await loadPatternsWithScenarios();

    if (patterns.length === 0) {
      console.warn('No patterns with scenarios found in runbooks/patterns/ - verify pattern files have scenarios in frontmatter');
      return;
    }

    for (const { file, scenarios } of patterns) {
      for (const [name, scenario] of Object.entries(scenarios)) {
        // Reset workspace for each scenario
        await workspace.cleanup();
        workspace = await createTestWorkspace();

        try {
          await executeScenario(file, scenario);
        } catch (error) {
          throw new Error(`Failed: ${file} / ${name}: ${String(error)}`);
        }
      }
    }
  }, 60000); // Extended timeout for running 60+ pattern scenarios
});
