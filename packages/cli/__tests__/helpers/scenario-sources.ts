/**
 * Shared discovery of the repository's scenario sources.
 *
 * Both the executing harness (`__tests__/integration/scenario-runner.test.ts`)
 * and the static authoring lint (`__tests__/schemas/scenario-authoring.test.ts`)
 * enumerate the same runbooks. They load them through this module so the two
 * cannot disagree about what exists — a runbook that is invisible to the loader
 * is untested by both, and that silence is the failure mode the lint exists to
 * prevent.
 *
 * Test-only: this lives under `__tests__/` rather than `src/` because `src/`
 * ships to users. Jest's `testMatch: ['**\/*.test.ts']` collects only `*.test.ts`,
 * so this file is imported, never run as a suite.
 *
 * @module __tests__/helpers/scenario-sources
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFrontmatter } from '@rundown-org/parser';
import { parseScenarios, type Scenarios } from '../../src/schemas/scenarios.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Repository root, derived from this file's location (packages/cli/__tests__/helpers). */
export const REPO_ROOT: string = join(__dirname, '..', '..', '..', '..');

/** The repository's runbook tree — the sole source of frontmatter scenarios. */
export const RUNBOOKS_DIR: string = join(REPO_ROOT, 'runbooks');

/**
 * Directories that never contain scenario sources subject to the authoring rules.
 *
 * `fixtures` covers `packages/parser/fixtures/conformance/invalid/`, which holds
 * deliberately malformed runbooks, and the packages' test fixtures. `dist` and
 * `.stryker-tmp` hold copies of real runbooks that would otherwise be linted
 * twice and reported under a build path.
 */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  '.stryker-tmp',
  '.git',
  '.worktrees',
  'coverage',
  'fixtures',
]);

/**
 * A runbook's scenario-parse outcome.
 *
 * `errors` is carried deliberately: callers must not silently drop a runbook
 * whose scenarios fail schema validation. Under the strict `ScenarioSchema`
 * (#498) a retired `seed:` key makes parsing fail, and a caller that discards
 * `errors` would stop testing that runbook rather than reject it.
 */
export interface RunbookScenarioSource {
  /** Path relative to `runbooks/`, e.g. `artifacts/execute-plan.runbook.md`. */
  readonly file: string;
  /** Absolute path on disk. */
  readonly absolutePath: string;
  /** Parsed scenarios, or null when absent or invalid. */
  readonly scenarios: Scenarios | null;
  /** Schema validation errors; empty when the scenarios block is valid. */
  readonly errors: readonly string[];
}

/**
 * Recursively list files under a directory, skipping build and vendor output.
 *
 * @param dir - Directory to walk
 * @returns Absolute paths of every file found
 */
function getFilesSync(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
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
 * Load every runbook under `runbooks/` with its scenario-parse outcome.
 *
 * Deliberately has no ENOENT fallback: if the runbook tree is missing, callers
 * must fail loudly rather than pass vacuously over zero runbooks.
 *
 * @returns One entry per `*.runbook.md`, in directory-walk order
 * @throws {Error} When the runbook tree cannot be read
 */
export function loadRunbookScenarioSources(): RunbookScenarioSource[] {
  const sources: RunbookScenarioSource[] = [];
  for (const absolutePath of getFilesSync(RUNBOOKS_DIR)) {
    if (!absolutePath.endsWith('.runbook.md')) continue;
    const file = absolutePath.substring(RUNBOOKS_DIR.length + 1);
    const content = readFileSync(absolutePath, 'utf-8');
    const { frontmatter } = extractFrontmatter(content);
    if (!frontmatter) {
      sources.push({ file, absolutePath, scenarios: null, errors: [] });
      continue;
    }
    const { scenarios, errors } = parseScenarios(frontmatter);
    sources.push({ file, absolutePath, scenarios, errors });
  }
  return sources;
}

/**
 * Find every standalone scenario-suite file in the repository.
 *
 * Discovered by scan rather than hardcoded, so a second suite is linted from
 * the day it is added instead of being born unenforced.
 *
 * @returns Absolute paths of every `*.scenario-suite.yaml`
 */
export function findScenarioSuiteFiles(): string[] {
  return getFilesSync(REPO_ROOT).filter((f) => f.endsWith('.scenario-suite.yaml'));
}
