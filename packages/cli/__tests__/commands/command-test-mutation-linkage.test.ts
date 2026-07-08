import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for the Stryker "static-import linkage" fix.
 *
 * WHY THIS EXISTS
 * ---------------
 * CLI Stryker runs with `jest.enableFindRelatedTests: true`. Per mutant it asks
 * Jest `--findRelatedTests src/commands/<x>.ts`, which resolves covering test
 * files through Jest's STATIC import graph. Every command test drives the CLI
 * through `runCliInProcess`, whose runner loads commands via a DYNAMIC
 * `await import('../cli.js')` — an edge the static graph cannot see. Without a
 * STATIC import of the command module in its own test file, `--findRelatedTests`
 * matches nothing, Stryker runs ZERO tests per mutant, and the file scores ~0%:
 * a measurement gap, not a real test-quality signal.
 *
 * The fix (see collect.test.ts / delegate.test.ts and the `* command wiring`
 * blocks across the per-command test files) is a single static import of the
 * command module in each per-command test file. This guard fails if any
 * per-command test file loses that static edge, or if a NEW command module is
 * added without a per-command test home wired the same way.
 *
 * WHY A GUARD TEST (not an eslint rule)
 * -------------------------------------
 * This mirrors the repo's existing structural content-guard tests (e.g.
 * `packages/claude-code-plugin/__tests__/content/json-default-output.test.ts`).
 * A guard test is lower friction than a bespoke eslint `no-restricted-syntax`
 * rule, needs no rule wiring, and documents its command→module mapping and
 * intentional exclusions inline where reviewers will see them.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commandsTestDir = __dirname;
const commandsSrcDir = path.join(__dirname, '..', '..', 'src', 'commands');

/**
 * Per-command test file → the command source module(s) it must statically
 * import so Stryker's `--findRelatedTests` credits its behavioural tests.
 *
 * A test file may map to multiple modules when it is the shared home for
 * sibling commands (e.g. `stash-pop.test.ts` owns both `stash` and `pop`).
 */
const COMMAND_TEST_MODULE_MAP: Readonly<Record<string, readonly string[]>> = {
  'abort.test.ts': ['abort'],
  'artifact.test.ts': ['artifact'],
  'claim.test.ts': ['claim'],
  'collect.test.ts': ['collect'],
  'complete.test.ts': ['complete'],
  'delegate.test.ts': ['delegate'],
  'echo.test.ts': ['echo'],
  'fail.test.ts': ['fail'],
  'goto.test.ts': ['goto'],
  'ls.test.ts': ['ls'],
  'pass.test.ts': ['pass'],
  'prune.test.ts': ['prune'],
  'resolve.test.ts': ['resolve'],
  'run.test.ts': ['run'],
  'scenario-suite.test.ts': ['scenario-suite'],
  'scenarios.test.ts': ['scenarios'],
  'stash-pop.test.ts': ['stash', 'pop'],
  'status.test.ts': ['status'],
  'stop.test.ts': ['stop'],
};

/**
 * Cross-cutting test files that are NOT per-command homes: they exercise
 * behaviour that spans commands (JSON envelope shape, output formatting, schema
 * validation, terminal boundaries, run flag surfaces) rather than owning a
 * single command's mutation coverage. They are intentionally exempt from the
 * static-import requirement.
 */
const CROSS_CUTTING_TEST_FILES: ReadonlySet<string> = new Set([
  'claim-run-combination.test.ts', // --claim-id/--run ambiguity across commands
  'command-test-mutation-linkage.test.ts', // this guard
  'forced-terminal-boundary.test.ts',
  'json-output.test.ts',
  'output-format.test.ts',
  'run-prompted.test.ts',
  'run-variables.test.ts',
  'schema-validation.test.ts',
]);

/**
 * Command source modules that have NO dedicated per-command test home, so no
 * static-import edge can be added for them. Tracked as a residual mutation-gate
 * gap rather than silently ignored: when one of these gains a per-command test
 * file, add it to COMMAND_TEST_MODULE_MAP and drop it here.
 */
const UNHOMED_COMMAND_MODULES: ReadonlySet<string> = new Set(['check', 'prompt']);

function testFiles(): string[] {
  return readdirSync(commandsTestDir)
    .filter((f) => f.endsWith('.test.ts'))
    .sort();
}

/**
 * Registrable command modules under `src/commands` — i.e. files that export a
 * `register<Name>Command` symbol (the Commander subcommand registrar). Shared
 * helpers or type-only files that might live under `src/commands` are excluded
 * so the orphaned-module check holds *commands* — not arbitrary source files —
 * to the per-command test-home rule.
 */
function commandModules(): string[] {
  return readdirSync(commandsSrcDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .filter((f) => {
      const src = readFileSync(path.join(commandsSrcDir, f), 'utf-8');
      return /export\s+function\s+register[A-Za-z0-9]*Command\b/.test(src);
    })
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();
}

function staticImportsModule(testFile: string, moduleName: string): boolean {
  const source = readFileSync(path.join(commandsTestDir, testFile), 'utf-8');
  // Match a top-level `import ... from '../../src/commands/<module>.js'`. Any
  // static import of the module (register fn, helper, or type) creates the edge
  // Stryker needs; the linkage does not depend on WHICH symbol is imported.
  const pattern = new RegExp(String.raw`from\s+['"]\.\./\.\./src/commands/${moduleName}\.js['"]`);
  return pattern.test(source);
}

describe('command-test mutation linkage guard', () => {
  it('every mapped per-command test file statically imports its command module(s)', () => {
    const failures: string[] = [];
    for (const [testFile, modules] of Object.entries(COMMAND_TEST_MODULE_MAP)) {
      for (const moduleName of modules) {
        if (!staticImportsModule(testFile, moduleName)) {
          failures.push(
            `${testFile} must statically import '../../src/commands/${moduleName}.js' ` +
              `(Stryker --findRelatedTests linkage). See collect.test.ts for the pattern.`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('every per-command test file is either mapped or an intentional cross-cutting exclusion', () => {
    const unclassified = testFiles().filter(
      (f) => !(f in COMMAND_TEST_MODULE_MAP) && !CROSS_CUTTING_TEST_FILES.has(f),
    );
    expect(unclassified).toEqual([]);
  });

  it('every mapped command module exists in src/commands', () => {
    const known = new Set(commandModules());
    const missing: string[] = [];
    for (const modules of Object.values(COMMAND_TEST_MODULE_MAP)) {
      for (const moduleName of modules) {
        if (!known.has(moduleName)) missing.push(moduleName);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every command module either has a test home or is a tracked residual gap', () => {
    const homed = new Set(Object.values(COMMAND_TEST_MODULE_MAP).flat());
    const orphaned = commandModules().filter(
      (m) => !homed.has(m) && !UNHOMED_COMMAND_MODULES.has(m),
    );
    // A new command with a dedicated test file must be wired into
    // COMMAND_TEST_MODULE_MAP; one without a test home must be added to
    // UNHOMED_COMMAND_MODULES (and ideally given a test home) — otherwise it
    // silently regresses to a ~0% mutation score.
    expect(orphaned).toEqual([]);
  });

  it('all cross-cutting exclusions and residual-gap modules still exist', () => {
    const files = new Set(testFiles());
    for (const f of CROSS_CUTTING_TEST_FILES) {
      expect(files.has(f)).toBe(true);
    }
    const modules = new Set(commandModules());
    for (const m of UNHOMED_COMMAND_MODULES) {
      expect(modules.has(m)).toBe(true);
    }
  });
});
