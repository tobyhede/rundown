import {
  createTestWorkspace,
  getCliPath,
  getAllStates,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { join, dirname, basename, delimiter, isAbsolute, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNodeError, getErrorMessage } from '@rundown-org/core';
import { extractFrontmatter } from '@rundown-org/parser';
import {
  parseScenarios,
  getEffectiveResult,
  type Scenario,
  type Scenarios,
} from '../../src/schemas/scenarios.js';
import {
  executeCommandSequence,
  extractRunbookReferences,
  matchStepAssertions,
  formatStepAssertionDescription,
} from '../../src/helpers/command-sequence.js';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Centralized path to runbooks directory for all test operations
const RUNBOOKS_DIR = join(__dirname, '..', '..', '..', '..', 'runbooks');

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
function loadPatternsWithScenariosSync(): {
  withScenarios: { file: string; scenarios: Scenarios }[];
  allRunbookFiles: string[];
} {
  let allFiles: string[];
  try {
    allFiles = getFilesSync(RUNBOOKS_DIR);
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return { withScenarios: [], allRunbookFiles: [] };
    }
    console.warn(`Warning: failed to load patterns: ${getErrorMessage(err)}`);
    return { withScenarios: [], allRunbookFiles: [] };
  }
  const withScenarios: { file: string; scenarios: Scenarios }[] = [];
  const allRunbookFiles: string[] = [];

  for (const filePath of allFiles) {
    if (!filePath.endsWith('.runbook.md')) continue;
    const relativePath = filePath.substring(RUNBOOKS_DIR.length + 1);
    allRunbookFiles.push(relativePath);
    const content = readFileSync(filePath, 'utf-8');
    const { frontmatter } = extractFrontmatter(content);
    if (!frontmatter) continue;
    const { scenarios } = parseScenarios(frontmatter);
    if (scenarios && Object.keys(scenarios).length > 0) {
      withScenarios.push({ file: relativePath, scenarios });
    }
  }

  return { withScenarios, allRunbookFiles };
}

const { withScenarios: patternsWithScenarios, allRunbookFiles } = loadPatternsWithScenariosSync();

const allScenarios = patternsWithScenarios.flatMap(({ file, scenarios }) =>
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
  const sourcePath = join(RUNBOOKS_DIR, relativePath);
  const targetDir = workspace.runbooksDir();
  const filename = relativePath.split('/').pop()!;

  mkdirSync(targetDir, { recursive: true });

  try {
    copyFileSync(sourcePath, join(targetDir, filename));
  } catch (err) {
    console.warn(`Pattern file not at expected path ${sourcePath}, using fallback search`);
    const foundPath = findFileByName(RUNBOOKS_DIR, filename);
    if (foundPath) {
      copyFileSync(foundPath, join(targetDir, filename));
    } else {
      throw err;
    }
  }
}

/**
 * Recursively copy a directory synchronously.
 */
function copyDirSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src);
  for (const entry of entries) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Extract directory paths from --var-file arguments in scenario commands.
 * E.g. "--var-file data/sources.yaml" returns ["data"]
 */
function extractVarFileDirs(scenario: Scenario): string[] {
  const dirs: string[] = [];
  const varFilePattern = /--var-file\s+(\S+)/g;

  for (const cmd of scenario.commands) {
    for (const match of cmd.matchAll(varFilePattern)) {
      const varFilePath = match[1];
      const dir = dirname(varFilePath);
      if (dir && dir !== '.' && !dirs.includes(dir)) {
        dirs.push(dir);
      }
    }
  }

  return dirs;
}

/**
 * Extract referenced runbook files from scenario commands.
 * Delegates to the shared extractRunbookReferences utility.
 */
function extractReferencedRunbooks(scenario: Scenario): string[] {
  return extractRunbookReferences(scenario.commands);
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
  const patternSubdir = dirname(filename);
  for (const ref of referenced) {
    // Resolves SOURCE file location within fixtures tree (not runtime resolution).
    // copyPatternToWorkspace flattens to .rundown/runbooks/ via basename,
    // so this only affects which fixture to copy. Works for name-based references
    // but would diverge for relative-path references since production
    // resolveRunbookFile() resolves from cwd, not the referencing runbook's dir.
    const resolvedRef = patternSubdir && patternSubdir !== '.' ? join(patternSubdir, ref) : ref;
    if (ref !== basename(filename)) {
      copyPatternToWorkspace(resolvedRef, workspace);
    }
  }

  const varFileDirs = extractVarFileDirs(scenario);
  for (const dir of varFileDirs) {
    // Reject absolute paths and path traversal
    if (isAbsolute(dir) || normalize(dir).startsWith('..')) {
      throw new Error(`Unsafe var-file directory in scenario: ${dir}`);
    }
    const srcDir = join(RUNBOOKS_DIR, patternSubdir, dir);
    const destDir = join(workspace.cwd, dir);
    const resolvedSrc = resolve(srcDir);
    const resolvedDest = resolve(destDir);
    const srcRoot = resolve(RUNBOOKS_DIR, patternSubdir);
    if (!resolvedSrc.startsWith(srcRoot + sep) && resolvedSrc !== srcRoot) {
      throw new Error(`Var-file source escapes pattern root: ${dir}`);
    }
    if (!resolvedDest.startsWith(workspace.cwd + sep) && resolvedDest !== workspace.cwd) {
      throw new Error(`Var-file destination escapes workspace root: ${dir}`);
    }
    copyDirSync(srcDir, destDir);
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

  const seqResult = await executeCommandSequence({
    commands: scenario.commands,
    cwd: workspace.cwd,
    cliPath,
    quiet: true,
    env: {
      PATH: `${binPath}${delimiter}${process.env.PATH ?? ''}`,
      CLAUDE_PLUGIN_ROOT: pluginDir,
      NO_COLOR: '1',
      FORCE_COLOR: undefined,
    },
  });

  // Validate step assertions when present
  if (scenario.expect?.steps) {
    const assertionResults = matchStepAssertions(scenario.expect.steps, seqResult.transitions);
    const failed = assertionResults.filter((r) => !r.matched);
    if (failed.length > 0) {
      const descriptions = failed.map(formatStepAssertionDescription).join('\n  ');
      const eventSummary = seqResult.transitions
        .map(
          (t) =>
            `{action=${t.action ?? '?'}, from=${t.from ?? '?'}, at=${t.at ?? '?'}, result=${t.result ?? '?'}}`,
        )
        .join('\n  ');
      throw new Error(
        `Step assertion failures for ${filename}:\n  ${descriptions}\n\nCaptured transitions:\n  ${eventSummary}`,
      );
    }
  }

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
    const lc = s.lifecycle;
    if (expectedResult === 'COMPLETE') {
      return lc === 'completed';
    } else {
      return lc === 'stopped';
    }
  });

  if (!state) {
    const statesSummary = matchingStates
      .map((s) => {
        const lc = s.lifecycle;
        return `ID=${String(s.id).slice(0, 8)}, lifecycle=${String(lc)}`;
      })
      .join('; ');
    throw new Error(
      `No state with expected result ${expectedResult} found for runbook ${filename}. Found states: [${statesSummary}]`,
    );
  }

  const lc = state.lifecycle;

  if (expectedResult === 'COMPLETE') {
    expect(lc).toBe('completed');
  } else {
    expect(lc).toBe('stopped');
  }
}

/**
 * Data-driven test runner that executes scenarios from pattern files.
 * Each scenario runs as its own test for better diagnostics and independent timeouts.
 */
describe('scenario runner', () => {
  it('every pattern runbook defines scenarios', () => {
    const withScenarioFiles = new Set(patternsWithScenarios.map((p) => p.file));
    const missing = allRunbookFiles.filter((f) => !withScenarioFiles.has(f));
    expect(missing).toEqual([]);
  });

  if (allScenarios.length === 0) {
    it('has pattern scenarios to run', () => {
      console.warn(
        'No patterns with scenarios found in runbooks/ — verify pattern files have scenarios in frontmatter',
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
