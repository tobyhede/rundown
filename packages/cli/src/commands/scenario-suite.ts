/**
 * CLI commands for external scenario suite files.
 *
 * Provides `rd scenario-suite ls|show|run` commands for working with
 * standalone `*.scenario-suite.yaml` files.
 *
 * @module commands/scenario-suite
 */

import type { Command } from 'commander';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, rm } from 'node:fs/promises';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  extractFileArtifactReferences,
  getErrorMessage,
  isExistingRegularArtifactFile,
  isNodeError,
  runbooksDir,
} from '@rundown-org/core';
import { parseRunbookDocument } from '@rundown-org/parser';
import { OutputEmitter } from '../services/output-emitter.js';
import { loadScenarioSuite, type ScenarioSuiteCase } from '../schemas/scenario-suite.js';
import {
  createInProcessCommandExecutor,
  executeCommandSequence,
  emitScenarioTiming,
  extractInputFileReferences,
  extractRunbookReferences,
  findUnassertedWarnings,
  formatErrorAssertionDescription,
  formatArtifactAssertionDescription,
  formatEnteredAssertionDescription,
  formatWarningAssertionDescription,
  matchErrorAssertions,
  matchStepAssertions,
  matchWarningAssertions,
  matchArtifactAssertions,
  matchEnteredAssertions,
  formatStepAssertionDescription,
  type ArtifactAssertionResult,
  type CapturedWarning,
  type EnteredAssertionResult,
  type ErrorAssertionResult,
  type StepAssertionResult,
  type WarningAssertionResult,
} from '../helpers/command-sequence.js';
import { assertSafeRelativeArtifactPath } from '../helpers/artifact-path.js';
import { assertContainedPath } from '../helpers/path-containment.js';
import { getEffectiveResult } from '../schemas/scenarios.js';
import { runCliInProcess } from '../services/in-process-cli-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the CLI executable — resolves from compiled output or source (ts-jest). */
const CLI_PATH = (() => {
  const adjacent = join(__dirname, '..', 'cli.js');
  if (existsSync(adjacent)) return adjacent;
  return join(__dirname, '..', '..', 'dist', 'cli.js');
})();

/**
 * Validate that a relative path does not escape its parent directory.
 *
 * @param relPath - The relative path to validate
 * @throws {Error} When the path is absolute or contains traversal segments
 */
function validateRelativePath(relPath: string): void {
  if (isAbsolute(relPath)) {
    throw new Error(`Absolute paths are not allowed in suite case files: ${relPath}`);
  }
  const normalized = normalize(relPath);
  if (normalized.startsWith('..')) {
    throw new Error(`Path traversal is not allowed in suite case files: ${relPath}`);
  }
}

function stageStaticArtifactFile(
  ref: string,
  sourceRoots: readonly string[],
  tmpDir: string,
): void {
  assertSafeRelativeArtifactPath(ref, `Unsafe artifact path in scenario suite: ${ref}`);
  const dest = resolve(tmpDir, ref);
  const tmpRoot = resolve(tmpDir);
  assertContainedPath(tmpRoot, dest, `Artifact destination escapes temp root: ${ref}`);

  for (const root of sourceRoots) {
    const candidate = resolve(root, ref);
    if (!existsSync(candidate)) continue;

    const realSource = realpathSync(candidate);
    const realRoot = realpathSync(root);
    assertContainedPath(realRoot, realSource, `Artifact source escapes source root: ${ref}`);

    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(realSource, dest);
    return;
  }

  throw new Error(`CHILD_ARTIFACT_NOT_FOUND: ${ref} (searched in: ${sourceRoots.join(', ')})`);
}

function stageStaticArtifactFiles(
  runbookSourcePath: string,
  sourceRoots: readonly string[],
  tmpDir: string,
): void {
  const runbookSource = readFileSync(runbookSourcePath, 'utf8');
  const parsed = parseRunbookDocument(runbookSource, basename(runbookSourcePath));
  for (const ref of extractFileArtifactReferences(parsed.runbook)) {
    stageStaticArtifactFile(ref, sourceRoots, tmpDir);
  }
}

function assertDestinationPathContained(destPath: string, root: string, ref: string): void {
  assertContainedPath(
    resolve(root),
    resolve(destPath),
    `Runbook destination escapes temp root: ${ref}`,
  );
}

function copyContainedRunbook(
  sourcePath: string,
  destPath: string,
  sourceRoot: string,
  ref: string,
): string {
  const realSource = realpathSync(sourcePath);
  const realRoot = realpathSync(sourceRoot);
  assertContainedPath(realRoot, realSource, `Runbook source escapes source root: ${ref}`);
  copyFileSync(realSource, destPath);
  return realSource;
}

/**
 * Execute a single suite case in an isolated temp workspace.
 * @param caseName - Name of the suite case being executed
 * @param suiteCase - Suite case definition with file, commands, and expectations
 * @param suiteDir - Directory containing the suite file (for resolving relative paths)
 * @param quiet - Whether to suppress child process output
 * @param output - Output emitter for rendering progress messages
 * @returns Result with pass/fail status, expected vs actual outcome, and optional step assertions
 */
async function executeSuiteCase(
  caseName: string,
  suiteCase: ScenarioSuiteCase,
  suiteDir: string,
  quiet: boolean,
  output: OutputEmitter,
): Promise<{
  kind: 'scenario_run';
  passed: boolean;
  scenario: string;
  expected: string;
  actual: string;
  stepAssertions?: StepAssertionResult[];
  errorAssertions?: ErrorAssertionResult[];
  warningAssertions?: WarningAssertionResult[];
  unassertedWarnings?: CapturedWarning[];
  artifactAssertions?: ArtifactAssertionResult[];
  enteredAssertions?: EnteredAssertionResult[];
}> {
  const effectiveResult = getEffectiveResult(suiteCase);
  const runbookPath = resolve(suiteDir, suiteCase.file);
  const tmpDir = mkdtempSync(join(tmpdir(), 'rd-suite-'));
  const stagedRunbooks: { readonly sourcePath: string; readonly sourceRoots: readonly string[] }[] =
    [];

  try {
    const runbooksDirPath = runbooksDir(tmpDir);
    mkdirSync(runbooksDirPath, { recursive: true });

    // Path-preserving copy: preserve subdirectory structure for suite cases
    const relPath = suiteCase.file; // e.g., "transitions/default-implicit.runbook.md"
    validateRelativePath(relPath);
    const destPath = join(runbooksDirPath, relPath);
    mkdirSync(dirname(destPath), { recursive: true });

    try {
      assertDestinationPathContained(destPath, runbooksDirPath, relPath);
      const realRunbookPath = copyContainedRunbook(runbookPath, destPath, suiteDir, relPath);
      stagedRunbooks.push({
        sourcePath: realRunbookPath,
        sourceRoots: [dirname(realRunbookPath), suiteDir],
      });
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return {
          kind: 'scenario_run',
          passed: false,
          scenario: caseName,
          expected: effectiveResult,
          actual: `RUNBOOK_NOT_FOUND: ${suiteCase.file}`,
        };
      }
      throw err;
    }

    // Also copy flat to runbooks root so bare-filename commands resolve
    const flatDest = join(runbooksDirPath, basename(suiteCase.file));
    if (flatDest !== destPath) {
      try {
        assertDestinationPathContained(flatDest, runbooksDirPath, basename(suiteCase.file));
        copyContainedRunbook(runbookPath, flatDest, suiteDir, relPath);
      } catch (err: unknown) {
        if (!(isNodeError(err) && err.code === 'ENOENT')) {
          throw err;
        }
        // ENOENT non-fatal: structured copy at destPath already succeeded
      }
    }

    // Copy any referenced child runbooks into the isolated workspace
    const mainBasename = basename(suiteCase.file);
    const allRefs = extractRunbookReferences(suiteCase.commands);
    const referenced = allRefs.filter((r) => r !== suiteCase.file && r !== mainBasename);
    const mainRunbookSourceDir = dirname(resolve(suiteDir, suiteCase.file));
    for (const ref of referenced) {
      validateRelativePath(ref);
      const dest = join(runbooksDirPath, ref);
      mkdirSync(dirname(dest), { recursive: true });
      // Try main runbook's directory first (bare filenames), then suite directory (nested paths)
      let copied = false;
      for (const base of [mainRunbookSourceDir, suiteDir]) {
        const sourcePath = resolve(base, ref);
        try {
          assertDestinationPathContained(dest, runbooksDirPath, ref);
          const realSourcePath = copyContainedRunbook(sourcePath, dest, base, ref);
          stagedRunbooks.push({
            sourcePath: realSourcePath,
            sourceRoots: [dirname(realSourcePath), suiteDir],
          });
          copied = true;
          break;
        } catch (e: unknown) {
          if (isNodeError(e) && e.code === 'ENOENT') {
            continue; // try next base
          }
          throw e; // permission/IO errors propagate immediately
        }
      }
      if (!copied) {
        throw new Error(
          `CHILD_RUNBOOK_NOT_FOUND: ${ref} (required by case "${caseName}", ` +
            `searched in: ${[mainRunbookSourceDir, suiteDir].join(', ')})`,
        );
      }
    }

    for (const stagedRunbook of stagedRunbooks) {
      stageStaticArtifactFiles(stagedRunbook.sourcePath, stagedRunbook.sourceRoots, tmpDir);
    }

    // Copy --input-file data files and their sibling directory contents.
    // Input files may contain file: references to sibling data files (e.g. JSONL),
    // so copy the entire containing directory to preserve those references.
    const inputFiles = extractInputFileReferences(suiteCase.commands);
    const copiedDirs = new Set<string>();
    for (const inputFile of inputFiles) {
      const normalizedInputDir = normalize(dirname(inputFile));
      if (copiedDirs.has(normalizedInputDir)) continue;
      copiedDirs.add(normalizedInputDir);

      if (normalizedInputDir === '.') {
        throw new Error(
          `Root-level input-file paths are not allowed in scenario suite: ${inputFile}`,
        );
      }
      if (isAbsolute(normalizedInputDir) || normalizedInputDir.startsWith('..')) {
        throw new Error(`Unsafe input-file path in scenario suite: ${normalizedInputDir}`);
      }
      const destDir = join(tmpDir, normalizedInputDir);
      const resolvedDest = resolve(destDir);
      const tmpRoot = resolve(tmpDir);
      if (!resolvedDest.startsWith(tmpRoot + sep) && resolvedDest !== tmpRoot) {
        throw new Error(`Input-file destination escapes temp root: ${normalizedInputDir}`);
      }

      let copied = false;
      for (const base of [suiteDir, mainRunbookSourceDir]) {
        const srcDir = join(base, normalizedInputDir);
        if (!existsSync(srcDir)) {
          continue;
        }
        const realResolvedSrc = realpathSync(srcDir);
        const realSrcRoot = realpathSync(base);
        if (!realResolvedSrc.startsWith(realSrcRoot + sep) && realResolvedSrc !== realSrcRoot) {
          throw new Error(`Input-file source escapes source root: ${normalizedInputDir}`);
        }
        await cp(srcDir, destDir, { recursive: true, dereference: true });
        copied = true;
        break;
      }
      if (!copied) {
        throw new Error(
          `Input file directory not found: ${normalizedInputDir} ` +
            `(searched in: ${[suiteDir, mainRunbookSourceDir].join(', ')})`,
        );
      }
    }

    if (!quiet) {
      output.message('', 'info');
      output.message(`Case: ${caseName}`, 'dim');
      output.message('\u2500'.repeat(50), 'dim');
      output.message('', 'info');
    }

    const seqResult = await executeCommandSequence({
      commands: suiteCase.commands,
      cwd: tmpDir,
      cliPath: CLI_PATH,
      quiet,
      onCommandStart: quiet
        ? undefined
        : (cmd) => {
            output.message(`$ ${cmd}`, 'info');
          },
      onCommandComplete: (timing) => {
        emitScenarioTiming({ scope: 'command', ...timing });
      },
      commandExecutor: createInProcessCommandExecutor(runCliInProcess),
    });

    const actualResult = seqResult.terminalResult;

    let stepAssertions: StepAssertionResult[] | undefined;
    if (suiteCase.expect?.steps) {
      stepAssertions = matchStepAssertions(suiteCase.expect.steps, seqResult.transitions, {
        defaultRunbook: suiteCase.file,
      });
    }
    let errorAssertions: ErrorAssertionResult[] | undefined;
    if (suiteCase.expect?.errors) {
      errorAssertions = matchErrorAssertions(suiteCase.expect.errors, seqResult.errors);
    }
    let warningAssertions: WarningAssertionResult[] | undefined;
    if (suiteCase.expect?.warnings) {
      warningAssertions = matchWarningAssertions(suiteCase.expect.warnings, seqResult.warnings);
    }
    const unassertedWarnings = findUnassertedWarnings(seqResult.warnings, warningAssertions);
    let artifactAssertions: ArtifactAssertionResult[] | undefined;
    if (suiteCase.expect?.artifacts) {
      artifactAssertions = matchArtifactAssertions(
        suiteCase.expect.artifacts,
        seqResult.artifactEntries,
        (uri) => isExistingRegularArtifactFile(uri, { cwd: tmpDir, workPath: '.rundown/work' }),
      );
    }
    let enteredAssertions: EnteredAssertionResult[] | undefined;
    if (suiteCase.expect?.entered) {
      enteredAssertions = matchEnteredAssertions(suiteCase.expect.entered, seqResult.enteredSteps);
    }

    const resultPassed = actualResult === effectiveResult;
    const assertionsPassed = stepAssertions ? stepAssertions.every((a) => a.matched) : true;
    const errorAssertionsPassed = errorAssertions ? errorAssertions.every((a) => a.matched) : true;
    const warningAssertionsPassed = warningAssertions
      ? warningAssertions.every((a) => a.matched)
      : true;
    const warningsPassed = unassertedWarnings.length === 0;
    const artifactAssertionsPassed = artifactAssertions
      ? artifactAssertions.every((a) => a.matched)
      : true;
    const enteredAssertionsPassed = enteredAssertions
      ? enteredAssertions.every((a) => a.matched)
      : true;

    return {
      kind: 'scenario_run',
      passed:
        resultPassed &&
        assertionsPassed &&
        errorAssertionsPassed &&
        warningAssertionsPassed &&
        warningsPassed &&
        artifactAssertionsPassed &&
        enteredAssertionsPassed,
      scenario: caseName,
      expected: effectiveResult,
      actual: actualResult,
      stepAssertions,
      errorAssertions,
      warningAssertions,
      unassertedWarnings: unassertedWarnings.length > 0 ? unassertedWarnings : undefined,
      artifactAssertions,
      enteredAssertions,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Register the scenario-suite command with subcommands.
 *
 * @param program - The Commander program instance to register the command on
 */
export function registerScenarioSuiteCommand(program: Command): void {
  const suite = program
    .command('scenario-suite')
    .description('List, show, or run cases from a scenario suite file');

  // rd scenario-suite ls <suite-file>
  suite
    .command('ls <suite-file>')
    .description('List all cases in a scenario suite')
    .option('--text', 'Output as human-readable text')
    .action(async (suiteFile: string, options: { text?: boolean }) => {
      const output = new OutputEmitter({ text: options.text, command: 'scenario-suite ls' });
      try {
        const result = await loadScenarioSuite(suiteFile);
        if (!result.ok) {
          output.error(result.error, 'VALIDATION_ERROR');
          if (result.details) {
            for (const detail of result.details) {
              output.message(`  - ${detail}`, 'error');
            }
          }
          output.flush();
          process.exit(1);
        }

        const rows = Object.entries(result.suite.cases).map(([name, c]) => ({
          name,
          file: c.file,
          expected: getEffectiveResult(c),
          description: c.description ?? '',
          tags: c.tags?.join(', ') ?? '',
        }));

        output.list(rows, [
          { header: 'NAME', key: 'name' },
          { header: 'FILE', key: 'file' },
          { header: 'EXPECTED', key: 'expected' },
          { header: 'DESCRIPTION', key: 'description' },
          { header: 'TAGS', key: 'tags' },
        ]);
        output.flush();
      } catch (error) {
        output.error(getErrorMessage(error), 'UNKNOWN_ERROR');
        output.flush();
        process.exit(1);
      }
    });

  // rd scenario-suite show <suite-file> <case>
  suite
    .command('show <suite-file> <case>')
    .description('Show details for a specific case in a suite')
    .option('--text', 'Output as human-readable text')
    .action(async (suiteFile: string, caseName: string, options: { text?: boolean }) => {
      const output = new OutputEmitter({ text: options.text, command: 'scenario-suite show' });
      try {
        const result = await loadScenarioSuite(suiteFile);
        if (!result.ok) {
          output.error(result.error, 'VALIDATION_ERROR');
          output.flush();
          process.exit(1);
        }

        if (!(caseName in result.suite.cases)) {
          output.error(`Case "${caseName}" not found`, 'SCENARIO_NOT_FOUND', {
            available: Object.keys(result.suite.cases),
          });
          output.flush();
          process.exit(1);
        }

        const c = result.suite.cases[caseName];
        const detailData: Record<string, unknown> = {
          name: caseName,
          file: c.file,
          description: c.description,
          expected: getEffectiveResult(c),
          commands: c.commands,
          tags: c.tags,
        };

        if (c.expect) {
          detailData.expect = c.expect;
        }

        output.detail(detailData, 'custom');
        output.flush();
      } catch (error) {
        output.error(getErrorMessage(error), 'UNKNOWN_ERROR');
        output.flush();
        process.exit(1);
      }
    });

  // rd scenario-suite run <suite-file> <case> OR --all
  suite
    .command('run <suite-file> [case]')
    .description('Execute a case (or all cases with --all) from a suite')
    .option('--all', 'Run all cases in the suite')
    .option('-q, --quiet', 'Suppress command output')
    .option('--text', 'Output as human-readable text')
    .action(
      async (
        suiteFile: string,
        caseName: string | undefined,
        options: { all?: boolean; quiet?: boolean; text?: boolean },
      ) => {
        const output = new OutputEmitter({ text: options.text, command: 'scenario-suite run' });
        try {
          const result = await loadScenarioSuite(suiteFile);
          if (!result.ok) {
            output.error(result.error, 'VALIDATION_ERROR');
            if (result.details) {
              for (const detail of result.details) {
                output.message(`  - ${detail}`, 'error');
              }
            }
            output.flush();
            process.exit(1);
          }

          const suiteDir = dirname(resolve(suiteFile));
          const runQuiet = (options.quiet ?? false) || !options.text;

          if (options.all) {
            // Run all cases
            const caseResults = [];
            let passedCount = 0;
            let failedCount = 0;

            for (const [name, c] of Object.entries(result.suite.cases)) {
              const caseStart = performance.now();
              try {
                const caseResult = await executeSuiteCase(name, c, suiteDir, runQuiet, output);
                caseResults.push(caseResult);
                if (caseResult.passed) {
                  passedCount++;
                } else {
                  failedCount++;
                }
              } catch (err: unknown) {
                caseResults.push({
                  kind: 'scenario_run',
                  passed: false,
                  scenario: name,
                  expected: getEffectiveResult(c),
                  actual: `ERROR: ${getErrorMessage(err)}`,
                });
                failedCount++;
              } finally {
                emitScenarioTiming({
                  scope: 'case',
                  case: name,
                  durationMs: Math.round(performance.now() - caseStart),
                });
              }
            }

            const allPassed = failedCount === 0;

            output.detail(
              {
                kind: 'scenario_suite_run',
                result: allPassed,
                suite: result.suite.name,
                total: caseResults.length,
                passed: passedCount,
                failed: failedCount,
                // Map internal `passed` boolean to schema-facing `result` field
                cases: caseResults.map((cr) => ({
                  kind: cr.kind,
                  result: cr.passed,
                  scenario: cr.scenario,
                  expected: cr.expected,
                  actual: cr.actual,
                  ...('stepAssertions' in cr && cr.stepAssertions
                    ? { stepAssertions: cr.stepAssertions }
                    : {}),
                  ...('errorAssertions' in cr && cr.errorAssertions
                    ? { errorAssertions: cr.errorAssertions }
                    : {}),
                  ...('warningAssertions' in cr && cr.warningAssertions
                    ? { warningAssertions: cr.warningAssertions }
                    : {}),
                  ...('unassertedWarnings' in cr && cr.unassertedWarnings
                    ? { unassertedWarnings: cr.unassertedWarnings }
                    : {}),
                  ...('artifactAssertions' in cr && cr.artifactAssertions
                    ? { artifactAssertions: cr.artifactAssertions }
                    : {}),
                  ...('enteredAssertions' in cr && cr.enteredAssertions
                    ? { enteredAssertions: cr.enteredAssertions }
                    : {}),
                })),
              },
              'custom',
            );

            // Display per-case summary in text mode
            if (options.text) {
              output.message('', 'info');
              for (const cr of caseResults) {
                const icon = cr.passed ? '\u2713' : '\u2717';
                const status = cr.passed ? 'dim' : 'error';
                output.message(
                  `  ${icon} ${cr.scenario}: expected ${cr.expected}, got ${cr.actual}`,
                  status,
                );
              }
            }

            output.flush();

            if (!allPassed) {
              process.exit(1);
            }
          } else if (caseName) {
            // Run single case
            if (!(caseName in result.suite.cases)) {
              output.error(`Case "${caseName}" not found`, 'SCENARIO_NOT_FOUND', {
                available: Object.keys(result.suite.cases),
              });
              output.flush();
              process.exit(1);
            }

            const c = result.suite.cases[caseName];
            let caseResult: Awaited<ReturnType<typeof executeSuiteCase>>;
            try {
              caseResult = await executeSuiteCase(caseName, c, suiteDir, runQuiet, output);
            } catch (err: unknown) {
              caseResult = {
                kind: 'scenario_run',
                passed: false,
                scenario: caseName,
                expected: getEffectiveResult(c),
                actual: `ERROR: ${getErrorMessage(err)}`,
              };
            }

            const detailData: Record<string, unknown> = {
              kind: 'scenario_run',
              result: caseResult.passed,
              scenario: caseResult.scenario,
              expected: caseResult.expected,
              actual: caseResult.actual,
            };

            if (caseResult.stepAssertions) {
              detailData.stepAssertions = caseResult.stepAssertions;
            }
            if (caseResult.errorAssertions) {
              detailData.errorAssertions = caseResult.errorAssertions;
            }
            if (caseResult.warningAssertions) {
              detailData.warningAssertions = caseResult.warningAssertions;
            }
            if (caseResult.unassertedWarnings) {
              detailData.unassertedWarnings = caseResult.unassertedWarnings;
            }
            if (caseResult.artifactAssertions) {
              detailData.artifactAssertions = caseResult.artifactAssertions;
            }
            if (caseResult.enteredAssertions) {
              detailData.enteredAssertions = caseResult.enteredAssertions;
            }

            output.detail(detailData, 'custom');

            if (options.text && caseResult.stepAssertions && caseResult.stepAssertions.length > 0) {
              output.message('', 'info');
              output.message('Step Assertions:', 'info');
              for (const sa of caseResult.stepAssertions) {
                const icon = sa.matched ? '\u2713' : '\u2717';
                const status = sa.matched ? 'dim' : 'error';
                output.message(`  ${icon} ${formatStepAssertionDescription(sa)}`, status);
              }
            }
            if (
              options.text &&
              caseResult.errorAssertions &&
              caseResult.errorAssertions.length > 0
            ) {
              output.message('', 'info');
              output.message('Error Assertions:', 'info');
              for (const ea of caseResult.errorAssertions) {
                const icon = ea.matched ? '\u2713' : '\u2717';
                const status = ea.matched ? 'dim' : 'error';
                output.message(`  ${icon} ${formatErrorAssertionDescription(ea)}`, status);
              }
            }
            if (
              options.text &&
              caseResult.warningAssertions &&
              caseResult.warningAssertions.length > 0
            ) {
              output.message('', 'info');
              output.message('Warning Assertions:', 'info');
              for (const wa of caseResult.warningAssertions) {
                const icon = wa.matched ? '\u2713' : '\u2717';
                const status = wa.matched ? 'dim' : 'error';
                output.message(`  ${icon} ${formatWarningAssertionDescription(wa)}`, status);
              }
            }
            if (
              options.text &&
              caseResult.unassertedWarnings &&
              caseResult.unassertedWarnings.length > 0
            ) {
              output.message('', 'info');
              output.message('Unasserted Warnings:', 'info');
              for (const warning of caseResult.unassertedWarnings) {
                output.message(
                  `  \u2717 unasserted warning code=${warning.code ?? '?'} command=${warning.command ?? '?'} message=${warning.message ?? '?'}`,
                  'error',
                );
              }
            }
            if (
              options.text &&
              caseResult.artifactAssertions &&
              caseResult.artifactAssertions.length > 0
            ) {
              output.message('', 'info');
              output.message('Artifact Assertions:', 'info');
              for (const aa of caseResult.artifactAssertions) {
                const icon = aa.matched ? '\u2713' : '\u2717';
                const status = aa.matched ? 'dim' : 'error';
                output.message(`  ${icon} ${formatArtifactAssertionDescription(aa)}`, status);
              }
            }
            if (
              options.text &&
              caseResult.enteredAssertions &&
              caseResult.enteredAssertions.length > 0
            ) {
              output.message('', 'info');
              output.message('Entered Assertions:', 'info');
              for (const ea of caseResult.enteredAssertions) {
                const icon = ea.matched ? '\u2713' : '\u2717';
                const status = ea.matched ? 'dim' : 'error';
                output.message(`  ${icon} ${formatEnteredAssertionDescription(ea)}`, status);
              }
            }

            output.flush();

            if (!caseResult.passed) {
              process.exit(1);
            }
          } else {
            output.error('Specify a case name or use --all to run all cases', 'VALIDATION_ERROR');
            output.flush();
            process.exit(1);
          }
        } catch (error) {
          output.error(getErrorMessage(error), 'UNKNOWN_ERROR');
          output.flush();
          process.exit(1);
        }
      },
    );
}
