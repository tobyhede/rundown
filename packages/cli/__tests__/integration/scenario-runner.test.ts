import {
  createTestWorkspace,
  getCliPath,
  getAllStates,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRawFrontmatter } from '../../src/helpers/extract-raw-frontmatter.js';
import {
  parseScenarios,
  getEffectiveResult,
  type Scenario,
  type Scenarios,
} from '../../src/schemas/scenarios.js';
import { executeCommandSequence } from '../../src/helpers/command-sequence.js';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Recursively get all files in a directory synchronously.
 */
function getFilesSync(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...getFilesSync(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

/**
 * Load pattern files that have scenarios defined (synchronous for test registration).
 */
function loadPatternsWithScenariosSync(): { file: string; scenarios: Scenarios }[] {
  const patternsDir = join(__dirname, '..', '..', '..', '..', 'runbooks', 'patterns');
  let allFiles: string[];
  try {
    allFiles = getFilesSync(patternsDir);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    console.warn(
      `Warning: failed to load patterns: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  const results: { file: string; scenarios: Scenarios }[] = [];

  for (const filePath of allFiles) {
    if (!filePath.endsWith('.runbook.md')) continue;
    const content = readFileSync(filePath, 'utf-8');
    const { frontmatter } = extractRawFrontmatter(content);
    if (!frontmatter) continue;
    const { scenarios } = parseScenarios(frontmatter);
    if (scenarios && Object.keys(scenarios).length > 0) {
      const relativePath = filePath.substring(patternsDir.length + 1);
      results.push({ file: relativePath, scenarios });
    }
  }

  return results;
}

/**
 * Flatten all scenarios into individual test cases for it.each.
 */
const allScenarios = loadPatternsWithScenariosSync().flatMap(({ file, scenarios }) =>
  Object.entries(scenarios).map(([name, scenario]) => ({ file, name, scenario })),
);

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
 * Copy a pattern file to the test workspace.
 * Handles files in subdirectories by flattening them to the target directory.
 */
function copyPatternToWorkspace(relativePath: string, workspace: TestWorkspace): void {
  const patternsDir = join(__dirname, '..', '..', '..', '..', 'runbooks', 'patterns');
  const sourcePath = join(patternsDir, relativePath);
  const targetDir = join(workspace.cwd, '.claude', 'rundown', 'runbooks');
  const filename = relativePath.split('/').pop()!;

  mkdirSync(targetDir, { recursive: true });

  try {
    copyFileSync(sourcePath, join(targetDir, filename));
  } catch (err) {
    console.warn(`Pattern file not at expected path ${sourcePath}, using fallback search`);
    const foundPath = findFileByName(patternsDir, filename);
    if (foundPath) {
      copyFileSync(foundPath, join(targetDir, filename));
    } else {
      throw err;
    }
  }
}

/**
 * Extract referenced runbook files from scenario commands.
 * Finds patterns like: rd delegate child-task.runbook.md --step 1
 */
function extractReferencedRunbooks(scenario: Scenario): string[] {
  const referenced: string[] = [];
  const runbookPattern = /([\w][\w.\-/]*\.runbook\.md)/g;

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
 * Copy a pattern file and all its referenced child runbooks to the test workspace.
 */
function copyPatternWithDependencies(
  filename: string,
  scenario: Scenario,
  workspace: TestWorkspace,
): void {
  copyPatternToWorkspace(filename, workspace);

  const referenced = extractReferencedRunbooks(scenario);
  for (const ref of referenced) {
    if (ref !== basename(filename)) {
      try {
        copyPatternToWorkspace(ref, workspace);
      } catch (err) {
        console.warn(`Failed to copy referenced runbook ${ref}:`, err);
      }
    }
  }
}

/**
 * Execute a scenario's commands and verify the result.
 */
async function executeScenario(
  filename: string,
  scenario: Scenario,
  workspace: TestWorkspace,
): Promise<void> {
  copyPatternWithDependencies(filename, scenario, workspace);

  const expectedResult = getEffectiveResult(scenario);

  const cliPath = getCliPath();
  const binPath = workspace.binPath();
  const pluginDir = join(workspace.cwd, 'plugin');

  await executeCommandSequence({
    commands: scenario.commands,
    cwd: workspace.cwd,
    cliPath,
    quiet: true,
    env: {
      PATH: `${binPath}:${process.env.PATH ?? ''}`,
      CLAUDE_PLUGIN_ROOT: pluginDir,
      NO_COLOR: '1',
      FORCE_COLOR: undefined,
    },
  });

  const states = await getAllStates(workspace);
  const expectedName = filename.split('/').pop()!;

  const matchingStates = states.filter((s) => {
    const runbookPath = s.runbook as string;
    return runbookPath.endsWith(expectedName);
  });

  if (matchingStates.length === 0) {
    const allRunbookPaths = states.map((s) => s.runbook).join(', ');
    throw new Error(`No state found for runbook ${filename}. Found paths: [${allRunbookPaths}]`);
  }

  const state = matchingStates.find((s) => {
    const variables = s.variables as Record<string, unknown> | undefined;
    if (expectedResult === 'COMPLETE') {
      return variables?.completed === true;
    } else {
      return variables?.stopped === true;
    }
  });

  if (!state) {
    const statesSummary = matchingStates
      .map((s) => {
        const vars = s.variables as Record<string, unknown> | undefined;
        const varsStr = vars ? JSON.stringify(vars) : 'undefined';
        return `ID=${String(s.id).slice(0, 8)}, vars=${varsStr}`;
      })
      .join('; ');
    throw new Error(
      `No state with expected result ${expectedResult} found for runbook ${filename}. Found states: [${statesSummary}]`,
    );
  }

  const variables = state.variables as Record<string, unknown> | undefined;

  if (expectedResult === 'COMPLETE') {
    expect(variables?.completed).toBe(true);
  } else {
    expect(variables?.stopped).toBe(true);
  }
}

/**
 * Data-driven test runner that executes scenarios from pattern files.
 * Each scenario runs as its own test for better diagnostics and independent timeouts.
 */
describe('scenario runner', () => {
  if (allScenarios.length === 0) {
    it('has pattern scenarios to run', () => {
      console.warn(
        'No patterns with scenarios found in runbooks/patterns/ — verify pattern files have scenarios in frontmatter',
      );
    });
  } else {
    it.each(allScenarios)('$file / $name', async ({ file, scenario }) => {
      const workspace = await createTestWorkspace();
      try {
        await executeScenario(file, scenario, workspace);
      } finally {
        await workspace.cleanup();
      }
    }, 15000);
  }
});
