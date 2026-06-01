/**
 * Business logic for the scenario command.
 *
 * Extracts loading, formatting, and execution logic from commands/scenarios.ts
 * into testable functions. The command file becomes a thin shell.
 *
 * @module helpers/scenario-workflow
 */

import { readFile, rm, cp } from 'node:fs/promises';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractFileArtifactReferences,
  isExistingRegularArtifactFile,
  isNodeError,
  runbooksDir,
} from '@rundown-org/core';
import {
  parseScenarios,
  getEffectiveResult,
  type Scenario,
  type Scenarios,
  type ScenarioExpect,
} from '../schemas/scenarios.js';
import { resolveRunbookFile } from './resolve-runbook.js';
import {
  extractFrontmatter,
  parseRunbookDocument,
  resolvedStepHasSubsteps,
} from '@rundown-org/parser';
import type { ResolvedStep } from '@rundown-org/parser';
import type { OutputEmitter } from '../services/output-emitter.js';
import {
  createInProcessCommandExecutor,
  executeCommandSequence,
  emitScenarioTiming,
  extractRunbookReferences,
  extractInputFileReferences,
  matchErrorAssertions,
  matchArtifactAssertions,
  matchStepAssertions,
  type ArtifactAssertionResult,
  type ErrorAssertionResult,
  type StepAssertionResult,
} from './command-sequence.js';
import { runCliInProcess } from '../services/in-process-cli-runner.js';
import { assertContainedPath } from './path-containment.js';
import { assertSafeRelativeArtifactPath } from './artifact-path.js';

/**
 * A loaded runbook with its scenarios.
 */
export interface LoadedRunbook {
  /** Absolute path to the runbook source file. */
  filePath: string;
  /** Display name from frontmatter or derived from filename. */
  name: string;
  /** Optional description from frontmatter. */
  description?: string;
  /** Parsed scenario definitions from the runbook. */
  scenarios: Scenarios;
}

function collectAuthoredRunbookRefs(filePath: string): string[] {
  const source = readFileSync(filePath, 'utf-8');
  const parsed = parseRunbookDocument(source, basename(filePath));
  const refs: string[] = [];

  for (const step of parsed.runbook.steps as readonly ResolvedStep[]) {
    if (!resolvedStepHasSubsteps(step)) continue;
    for (const substep of step.substeps) {
      for (const ref of substep.runbooks ?? []) {
        refs.push(ref);
      }
    }
  }

  return refs;
}

function shouldStageAuthoredRunbookRef(ref: string): boolean {
  return (
    ref.endsWith('.runbook.md') &&
    !ref.includes('{{') &&
    !isAbsolute(ref) &&
    !normalize(ref).startsWith('..') &&
    !ref.includes(':')
  );
}

function resolveScenarioRunbookRef(ref: string, fromDir: string, sourceRoot: string): string {
  const localPath = join(fromDir, ref);
  if (existsSync(localPath)) {
    return localPath;
  }
  return join(sourceRoot, ref);
}

/**
 * Result of loading scenarios.
 */
export type ScenarioLoadResult =
  | { ok: true; loaded: LoadedRunbook }
  | { ok: false; error: string; code: string; details?: string[] };

/**
 * Result of running a scenario.
 */
export interface ScenarioRunResult {
  /** Whether the scenario produced the expected outcome. */
  passed: boolean;
  /** Name of the scenario that was executed. */
  scenario: string;
  /** Expected final state (e.g. "COMPLETE", "STOP"). */
  expected: string;
  /** Actual final state observed after execution. */
  actual: string;
  /** Per-step assertion results (present when expect.steps block is used). */
  stepAssertions?: StepAssertionResult[];
  /** Per-error assertion results (present when expect.errors block is used). */
  errorAssertions?: ErrorAssertionResult[];
  /** Per-artifact assertion results (present when expect.artifacts block is used). */
  artifactAssertions?: ArtifactAssertionResult[];
}

/**
 * Load and validate scenarios from a runbook file.
 *
 * Returns a result type instead of calling process.exit().
 *
 * @param file - Runbook file path or name
 * @param cwd - Current working directory
 * @returns ScenarioLoadResult with loaded data or error details
 */
export async function loadScenarios(file: string, cwd: string): Promise<ScenarioLoadResult> {
  const resolved = await resolveRunbookFile(cwd, file);

  if (!resolved) {
    return { ok: false, error: `Runbook file not found: ${file}`, code: 'RUNBOOK_NOT_FOUND' };
  }

  const filePath = resolved.path;
  const content = await readFile(filePath, 'utf-8');
  const { frontmatter } = extractFrontmatter(content);

  if (!frontmatter) {
    return { ok: false, error: 'No frontmatter found in this runbook', code: 'VALIDATION_ERROR' };
  }

  const { scenarios, errors } = parseScenarios(frontmatter);

  if (errors.length > 0) {
    return {
      ok: false,
      error: 'Invalid scenarios in frontmatter:',
      code: 'VALIDATION_ERROR',
      details: errors,
    };
  }

  if (!scenarios || Object.keys(scenarios).length === 0) {
    return { ok: false, error: 'No scenarios defined in this runbook', code: 'VALIDATION_ERROR' };
  }

  const name = frontmatter.name ?? file;
  const description = frontmatter.description;

  return { ok: true, loaded: { filePath, name, description, scenarios } };
}

/**
 * Build list rows from scenarios for output.list().
 *
 * @param scenarios - Map of scenario names to definitions
 * @returns Array of row objects for tabular display
 */
export function buildScenarioListRows(
  scenarios: Scenarios,
): { name: string; expected: string; description: string; tags: string }[] {
  return Object.entries(scenarios).map(([name, scenario]) => {
    return {
      name,
      expected: getEffectiveResult(scenario),
      description: scenario.description ?? '',
      tags: scenario.tags?.join(', ') ?? '',
    };
  });
}

/**
 * Build detail data for a specific scenario.
 *
 * @param name - Scenario name to look up
 * @param scenarios - Map of scenario names to definitions
 * @returns Detail object or null if not found
 */
export function buildScenarioDetail(
  name: string,
  scenarios: Scenarios,
): {
  name: string;
  description?: string;
  expected: string;
  commands: string[];
  tags?: string[];
  expect?: ScenarioExpect;
} | null {
  if (!(name in scenarios)) {
    return null;
  }

  const scenario = scenarios[name];
  return {
    name,
    description: scenario.description,
    expected: getEffectiveResult(scenario),
    commands: scenario.commands,
    tags: scenario.tags,
    expect: scenario.expect,
  };
}

/**
 * Extract referenced runbook files from scenario commands.
 *
 * @param scenario - The scenario to extract references from
 * @returns Array of runbook filenames referenced in commands
 */
export function extractReferencedRunbooks(scenario: Scenario): string[] {
  return extractRunbookReferences(scenario.commands);
}

function validateRelativeArtifactPath(ref: string): void {
  assertSafeRelativeArtifactPath(ref, `Unsafe artifact path in scenario: ${ref}`);
}

function stageStaticArtifactFile(ref: string, sourceDir: string, tmpDir: string): void {
  validateRelativeArtifactPath(ref);
  const source = resolve(sourceDir, ref);
  if (!existsSync(source)) {
    throw new Error(`Artifact file not found: ${ref} (searched in: ${sourceDir})`);
  }

  const realSource = realpathSync(source);
  const realSourceRoot = realpathSync(sourceDir);
  assertContainedPath(realSourceRoot, realSource, `Artifact source escapes source root: ${ref}`);

  const dest = resolve(tmpDir, ref);
  const tmpRoot = resolve(tmpDir);
  assertContainedPath(tmpRoot, dest, `Artifact destination escapes temp root: ${ref}`);

  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(realSource, dest);
}

function stageStaticArtifactFiles(runbookSourcePath: string, tmpDir: string): void {
  const runbookSource = readFileSync(runbookSourcePath, 'utf8');
  const parsed = parseRunbookDocument(runbookSource, basename(runbookSourcePath));
  const sourceDir = dirname(runbookSourcePath);
  for (const ref of extractFileArtifactReferences(parsed.runbook)) {
    stageStaticArtifactFile(ref, sourceDir, tmpDir);
  }
}

/**
 * Execute a scenario in an isolated temp workspace and evaluate the result.
 *
 * Creates a temp directory, copies runbook files, executes commands via
 * executeCommandSequence, and compares against expected result. When an
 * `expect.steps` block is present, evaluates step assertions against the
 * captured transition stream.
 *
 * @param loadedRunbook - The loaded runbook with scenario definitions
 * @param scenarioName - Name of the scenario to execute
 * @param quiet - Whether to suppress command output
 * @param output - OutputEmitter for progress output
 * @param cliPath - Path to the CLI entry point
 * @returns ScenarioRunResult with pass/fail evaluation
 * @throws {Error} When a command fails with a non-zero exit code and no terminal result is parsed
 * @throws {Error} When the temp workspace cannot be created or cleaned up
 */
export async function executeScenario(
  loadedRunbook: LoadedRunbook,
  scenarioName: string,
  quiet: boolean,
  output: OutputEmitter,
  cliPath: string,
): Promise<ScenarioRunResult> {
  const { filePath, scenarios } = loadedRunbook;
  const scenario = scenarios[scenarioName];
  const effectiveResult = getEffectiveResult(scenario);
  const runbookFilename = basename(loadedRunbook.filePath);

  // Create isolated temp workspace
  const tmpDir = mkdtempSync(join(tmpdir(), 'rd-scenario-'));

  try {
    const runbooksDirPath = runbooksDir(tmpDir);
    mkdirSync(runbooksDirPath, { recursive: true });
    // Copy runbook and any referenced child runbooks
    copyFileSync(filePath, join(runbooksDirPath, runbookFilename));
    stageStaticArtifactFiles(filePath, tmpDir);

    // Symlink the CLI as `rd` / `rundown` inside the workspace so substep
    // shell commands like `rd run X.md` resolve against the same CLI binary
    // the scenario runner is using. Without this, composition (a substep
    // body containing `rd run`) would fail at the shell with "command not
    // found" because the process PATH doesn't include the workspace bin.
    const binDir = join(tmpDir, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    symlinkSync(cliPath, join(binDir, 'rd'));
    symlinkSync(cliPath, join(binDir, 'rundown'));
    // The `rd`/`rundown` entries are symlinks to cli.js, so a shell command
    // that resolves `rd` on PATH (e.g. `node -e '...execFileSync("rd")...'`)
    // execs cli.js directly — which requires its executable bit. CI obtains
    // dist/ via actions/upload-artifact + download-artifact, and that round
    // trip strips file permissions, leaving cli.js at 0644. Restore the bit on
    // the symlink target so the spawn does not fail with EACCES. Only chmod
    // when the executable bit is actually missing, and tolerate EACCES/EPERM:
    // in read-only or globally-installed layouts cliPath may be non-writable
    // even when already executable, and chmodSync itself would otherwise abort
    // the run.
    try {
      if ((statSync(cliPath).mode & 0o111) === 0) {
        chmodSync(cliPath, 0o755);
      }
    } catch (err: unknown) {
      if (!isNodeError(err) || (err.code !== 'EACCES' && err.code !== 'EPERM')) {
        throw err;
      }
    }

    const referenced = extractReferencedRunbooks(scenario);
    const sourceDir = dirname(filePath);
    const realSourceDir = realpathSync(sourceDir);
    const stagedRunbooks = new Set<string>([runbookFilename]);
    const stageReferencedRunbook = (ref: string, fromDir: string): void => {
      if (!shouldStageAuthoredRunbookRef(ref) || stagedRunbooks.has(ref)) return;

      try {
        const sourcePath = resolveScenarioRunbookRef(ref, fromDir, realSourceDir);
        const realSourcePath = realpathSync(sourcePath);
        assertContainedPath(
          realSourceDir,
          realSourcePath,
          `Referenced runbook source escapes source root: ${ref}`,
        );
        const destPath = join(runbooksDirPath, ref);
        mkdirSync(dirname(destPath), { recursive: true });
        copyFileSync(realSourcePath, destPath);
        stagedRunbooks.add(ref);
        stageStaticArtifactFiles(realSourcePath, tmpDir);

        for (const childRef of collectAuthoredRunbookRefs(realSourcePath)) {
          stageReferencedRunbook(childRef, dirname(realSourcePath));
        }
      } catch (err: unknown) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          throw new Error(`Referenced runbook not found: ${ref} (searched in: ${fromDir})`);
        }
        throw err;
      }
    };

    for (const ref of referenced) {
      if (ref !== runbookFilename) {
        stageReferencedRunbook(ref, sourceDir);
      }
    }
    for (const ref of collectAuthoredRunbookRefs(filePath)) {
      stageReferencedRunbook(ref, sourceDir);
    }

    // Copy --input-file data files and their sibling directory contents.
    // Input files may contain file: references to sibling data files (e.g. JSONL),
    // so copy the entire containing directory to preserve those references.
    const inputFiles = extractInputFileReferences(scenario.commands);
    const copiedDirs = new Set<string>();
    for (const inputFile of inputFiles) {
      const inputDir = dirname(inputFile);
      if (copiedDirs.has(inputDir)) continue;
      copiedDirs.add(inputDir);

      if (isAbsolute(inputDir) || normalize(inputDir).startsWith('..')) {
        throw new Error(`Unsafe input-file path in scenario: ${inputDir}`);
      }
      const srcDir = join(sourceDir, inputDir);
      const destDir = join(tmpDir, inputDir);
      const resolvedSrc = resolve(srcDir);
      const resolvedDest = resolve(destDir);
      const srcRoot = resolve(sourceDir);
      const tmpRoot = resolve(tmpDir);
      if (!resolvedSrc.startsWith(srcRoot + sep) && resolvedSrc !== srcRoot) {
        throw new Error(`Input-file source escapes source root: ${inputDir}`);
      }
      if (!resolvedDest.startsWith(tmpRoot + sep) && resolvedDest !== tmpRoot) {
        throw new Error(`Input-file destination escapes temp root: ${inputDir}`);
      }
      if (existsSync(srcDir)) {
        await cp(srcDir, destDir, { recursive: true });
      } else {
        throw new Error(`Input file directory not found: ${inputDir} (searched in: ${sourceDir})`);
      }
    }

    // Verbose display — print scenario header only
    if (!quiet) {
      output.message('', 'info');
      output.message(`Scenario:  ${scenarioName}`, 'dim');
      output.message('\u2500'.repeat(50), 'dim');
      output.message('', 'info');
    }

    // Execute all commands, tee child output, and capture JSON stdout.
    // Prepend the workspace bin to PATH so shell commands inside substep
    // bodies (e.g. `rd run X.md` for runbook composition) resolve `rd` to
    // the same CLI binary the scenario runner is using.
    const seqResult = await executeCommandSequence({
      commands: scenario.commands,
      cwd: tmpDir,
      cliPath,
      quiet,
      env: {
        PATH: [binDir, process.env.PATH]
          .filter((value): value is string => Boolean(value))
          .join(delimiter),
      },
      onCommandStart: quiet
        ? undefined
        : (cmd) => {
            output.message('', 'info');
            output.message('\u2501'.repeat(50), 'dim');
            output.message(`$ ${cmd}`, 'info');
            output.message('', 'info');
          },
      onCommandComplete: (timing) => {
        emitScenarioTiming({ scope: 'command', ...timing });
      },
      commandExecutor: createInProcessCommandExecutor(runCliInProcess),
    });

    const actualResult = seqResult.terminalResult;

    // Evaluate assertions if present
    let stepAssertions: StepAssertionResult[] | undefined;
    if (scenario.expect?.steps) {
      stepAssertions = matchStepAssertions(scenario.expect.steps, seqResult.transitions);
    }
    let errorAssertions: ErrorAssertionResult[] | undefined;
    if (scenario.expect?.errors) {
      errorAssertions = matchErrorAssertions(scenario.expect.errors, seqResult.errors);
    }
    let artifactAssertions: ArtifactAssertionResult[] | undefined;
    if (scenario.expect?.artifacts) {
      artifactAssertions = matchArtifactAssertions(
        scenario.expect.artifacts,
        seqResult.artifactEntries,
        (uri) => isExistingRegularArtifactFile(uri, { cwd: tmpDir, workPath: '.rundown/work' }),
      );
    }

    const resultPassed = actualResult === effectiveResult;
    const assertionsPassed = stepAssertions ? stepAssertions.every((a) => a.matched) : true;
    const errorAssertionsPassed = errorAssertions ? errorAssertions.every((a) => a.matched) : true;
    const artifactAssertionsPassed = artifactAssertions
      ? artifactAssertions.every((a) => a.matched)
      : true;

    if (!quiet) {
      output.message('', 'info');
    }

    return {
      passed: resultPassed && assertionsPassed && errorAssertionsPassed && artifactAssertionsPassed,
      scenario: scenarioName,
      expected: effectiveResult,
      actual: actualResult,
      stepAssertions,
      errorAssertions,
      artifactAssertions,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
