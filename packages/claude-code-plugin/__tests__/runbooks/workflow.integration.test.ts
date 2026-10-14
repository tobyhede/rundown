/**
 * Integration tests for built-in runbook workflows.
 * Pattern: follows packages/cli/__tests__/check.test.ts structure
 *
 * Mutations follow the one-writer protocol (#901): every `pass` / `fail` /
 * `goto` names its authority with `--token <owner_token>` (captured from the
 * `runbook_started` event by `runCli`) and `pass` / `fail` name the current
 * position with `--step`. `status` is bare (every run) or `--run <id>`.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { mkdtempSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCli, withOwnerToken, type CliResult } from '../helpers/test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const runbooksDir = join(__dirname, '..', '..', 'runbooks');
const pluginRoot = join(__dirname, '..', '..');

type JsonEvent = Record<string, unknown>;

/** Parse mixed CLI stdout, ignoring blank lines and non-JSON diagnostic text. */
function parseJsonEvents(stdout: string): JsonEvent[] {
  const events: JsonEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed as JsonEvent);
      }
    } catch {}
  }
  return events;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findEnteredStep(events: JsonEvent[], stepId: string): JsonEvent | undefined {
  return events.find(
    (event) =>
      event.type === 'step_entered' &&
      (event.position as { current?: string } | undefined)?.current === stepId,
  );
}

/**
 * The position the run is currently at, read from the latest `step_entered`
 * event: the substep when one is active, else the top-level step. This is
 * what `--step` must name on the next `pass` / `fail`.
 *
 * @param events - Every event observed so far, in order
 * @returns The current position
 * @throws {Error} When no `step_entered` has been observed
 */
function currentPosition(events: JsonEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== 'step_entered') continue;
    const position = event.position as { current?: unknown; substep?: unknown } | undefined;
    if (typeof position?.substep === 'string') return position.substep;
    if (typeof position?.current === 'string') return position.current;
  }
  throw new Error('No step_entered event observed; cannot name --step');
}

/**
 * The run id announced by `runbook_started`.
 *
 * @param events - Events from the `rundown run` invocation
 * @returns The run id (`rd_` + 32 hex)
 * @throws {Error} When no `runbook_started` event is present
 */
function startedRunId(events: JsonEvent[]): string {
  const started = events.find((event) => event.type === 'runbook_started');
  if (typeof started?.runbookId !== 'string') {
    throw new Error('Expected a runbook_started event carrying runbookId');
  }
  return started.runbookId;
}

/**
 * Read the detail status of one run.
 *
 * @param runId - The run to read
 * @param cwd - Workspace holding the run
 * @returns Parsed status JSON
 */
function statusOf(
  runId: string,
  cwd: string,
): Record<string, unknown> & { position: { current: string } } {
  const result = runCli(['status', '--run', runId], cwd);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown> & { position: { current: string } };
}

/**
 * Pass or fail the current position of the single run started in `cwd`.
 *
 * @param command - `pass` or `fail`
 * @param events - Events observed so far (appended to in place)
 * @param cwd - Workspace of the run
 * @returns The CLI result
 */
function transition(command: 'pass' | 'fail', events: JsonEvent[], cwd: string): CliResult {
  const result = runCli(withOwnerToken([command, '--step', currentPosition(events)], cwd), cwd);
  events.push(...parseJsonEvents(result.stdout));
  return result;
}

describe('Built-in Runbook Workflow Integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'rd-plugin-test-'));
    await mkdir(join(tempDir, '.claude', 'rundown', 'runs'), { recursive: true });
    // Its own .rundown/ makes the workspace its own project root, so the
    // project-root walk never reaches a .rundown/ above the temp directory.
    await mkdir(join(tempDir, '.rundown'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('parseJsonEvents', () => {
    it('keeps JSON object events from mixed stdout', () => {
      expect(
        parseJsonEvents(
          [
            '',
            'not json',
            '{"type":"step_entered","position":{"current":"1"}}',
            '["not","an","event"]',
            '{"type":"step_completed"}',
          ].join('\n'),
        ),
      ).toEqual([{ type: 'step_entered', position: { current: '1' } }, { type: 'step_completed' }]);
    });
  });

  describe('currentPosition', () => {
    it('names the active substep when one is present, else the step', () => {
      expect(currentPosition([{ type: 'step_entered', position: { current: '2' } }])).toBe('2');
      expect(
        currentPosition([
          { type: 'step_entered', position: { current: '1' } },
          { type: 'step_entered', position: { current: '2', substep: '2.1' } },
        ]),
      ).toBe('2.1');
    });
  });

  describe('rd check validates built-in runbooks', () => {
    const runbookFiles = [
      'end-to-end-test/end-to-end-test.runbook.md',
      'end-to-end-test/write-file.runbook.md',
      'end-to-end-test/review-and-collate.runbook.md',
      'end-to-end-test/review-file.runbook.md',
      'end-to-end-test/collate-files.runbook.md',
      'planning/write-plan.runbook.md',
      'planning/review-plan.runbook.md',
      'planning/review/review-plan-technical-accuracy.runbook.md',
      'planning/review/review-plan-structural-integrity.runbook.md',
      'planning/review/review-plan-build-runtime.runbook.md',
      'planning/review/review-plan-risk-safety.runbook.md',
      'planning/review/review-plan-collate.runbook.md',
    ];

    for (const file of runbookFiles) {
      it(`validates ${file}`, () => {
        const sourcePath = join(runbooksDir, file);
        // Bundled runbooks are a shipped contract: a missing file is a failure, not a skip.
        expect(existsSync(sourcePath)).toBe(true);

        const result = runCli(['check', sourcePath], tempDir);

        expect(result.exitCode).toBe(0);
        expect((JSON.parse(result.stdout) as { valid?: boolean }).valid).toBe(true);
      });
    }
  });

  describe('rd check validates shipped example runbooks', () => {
    const exampleFiles = ['create-worktree.runbook.md', 'pr-feedback.runbook.md'];

    for (const file of exampleFiles) {
      it(`validates examples/${file}`, () => {
        const sourcePath = join(pluginRoot, 'examples', file);
        // Shipped examples are a shipped contract: a missing file is a failure, not a skip.
        expect(existsSync(sourcePath)).toBe(true);

        const result = runCli(['check', sourcePath], tempDir);

        expect(result.exitCode).toBe(0);
        expect((JSON.parse(result.stdout) as { valid?: boolean }).valid).toBe(true);
      });
    }
  });

  describe('end-to-end-test inline composition (#903)', () => {
    it('launches write-file inline on the parent token and Collects it; review-and-collate then delegates (#904)', () => {
      const previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
      try {
        const start = runCli(
          ['run', join(runbooksDir, 'end-to-end-test', 'end-to-end-test.runbook.md')],
          tempDir,
        );
        expect(start.exitCode).toBe(0);
        const rootId = startedRunId(parseJsonEvents(start.stdout));

        // Step 1 is the parent's own; passing it enters step 2, whose inline
        // substep launches write-file as an Inline Child with no token of its own.
        const toStep2 = runCli(withOwnerToken(['pass', '--step', '1'], tempDir), tempDir);
        expect(toStep2.exitCode).toBe(0);
        const launched = parseJsonEvents(toStep2.stdout).filter(
          (event) => event.type === 'runbook_started',
        );
        expect(launched).toHaveLength(1);
        expect(launched[0]).not.toHaveProperty('owner_token');
        expect((launched[0]?.runbook as { path?: string } | undefined)?.path).toBe(
          'end-to-end-test/write-file.runbook.md',
        );
        const childId = String(launched[0]?.runbookId);

        // The root token now targets the child, so --step names the child's
        // step. Entering its step 2 resolves the PlanPath artifact its
        // frontmatter OUTPUTS; completing it Collects its pass — and PlanPath —
        // into step 2. Step 3's inline child requires that PlanPath and
        // delegates its review, so its entry lists a Claim Ticket.
        const childStep = runCli(withOwnerToken(['pass', '--step', '1'], tempDir), tempDir);
        expect(childStep.exitCode).toBe(0);
        expect(statusOf(rootId, tempDir).position.current).toBe('2');
        const collected = runCli(withOwnerToken(['complete'], tempDir), tempDir);
        expect(collected.exitCode).toBe(0);
        const events = parseJsonEvents(collected.stdout);
        expect(events.filter((event) => event.type === 'error_occurred')).toEqual([]);
        const reviewEntry = events.find(
          (event) =>
            event.type === 'step_entered' &&
            (event.runbook as { path?: string } | undefined)?.path ===
              'end-to-end-test/review-and-collate.runbook.md',
        );
        expect(reviewEntry?.children).toEqual([
          expect.objectContaining({
            step: '1.1',
            runbook: 'end-to-end-test/review-file.runbook.md',
            ticket: expect.stringMatching(/^rdt_/),
          }),
        ]);
        expect(statusOf(childId, tempDir).status).toBe('completed');
        const root = statusOf(rootId, tempDir);
        expect(root.position.current).toBe('3');
        expect(root.vars).toHaveProperty('PlanPath');
      } finally {
        if (previousPluginRoot === undefined) {
          delete process.env.CLAUDE_PLUGIN_ROOT;
        } else {
          process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
        }
      }
    });
  });

  describe('prompted mode step navigation', () => {
    function runPromptedUntilStep(
      runbookPath: string,
      stepId: string,
      args: string[] = [],
    ): JsonEvent {
      let result = runCli(['run', runbookPath, '--prompted', ...args], tempDir);
      expect(result.exitCode).toBe(0);
      const events = parseJsonEvents(result.stdout);

      let entered = findEnteredStep(events, stepId);
      for (let index = 0; index < 30 && !entered; index += 1) {
        result = transition('pass', events, tempDir);
        expect(result.exitCode).toBe(0);
        entered = findEnteredStep(events, stepId);
      }

      if (!entered) {
        throw new Error(`Expected prompted runbook to enter step ${stepId}`);
      }
      return entered;
    }

    it.each([
      {
        file: ['planning', 'write-plan.runbook.md'],
        step: '7',
        artifactName: 'PlanPath',
        key: 'plan.json',
        args: ['--input', 'FeatureName=batch-8-parity'],
      },
      {
        file: ['planning', 'review', 'review-plan-technical-accuracy.runbook.md'],
        step: '4',
        artifactName: 'ReviewPath',
        key: 'review-plan-technical-accuracy.json',
        args: ['--input', 'PlanPath=/tmp/plan.json'],
      },
      {
        file: ['planning', 'review', 'review-plan-structural-integrity.runbook.md'],
        step: '4',
        artifactName: 'ReviewPath',
        key: 'review-plan-structural-integrity.json',
        args: ['--input', 'PlanPath=/tmp/plan.json'],
      },
    ])(
      'resolves ARTIFACTS for bundled runbook $file',
      ({ file, step, artifactName, key, args }) => {
        const previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
        process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
        try {
          const entered = runPromptedUntilStep(join(runbooksDir, ...file), step, args);
          const artifacts = entered.artifacts as
            | Record<string, { key?: unknown; uri?: unknown; path?: unknown }>
            | undefined;
          const artifact = artifacts?.[artifactName];

          expect(artifact?.key).toBe(key);
          if (typeof artifact?.uri !== 'string') {
            throw new Error(`Expected ${artifactName}.uri to be a string`);
          }
          expect(artifact.uri).toEqual(
            expect.stringMatching(
              new RegExp(`^rd://artifacts/[^/]+/rd_[a-f0-9]{32}/${escapeRegExp(key)}$`),
            ),
          );
          if (typeof artifact.path !== 'string') {
            throw new Error(`Expected ${artifactName}.path to be a string`);
          }
          expect(artifact.path).toEqual(
            expect.stringMatching(new RegExp(`/rd_[a-f0-9]{32}/${escapeRegExp(key)}$`)),
          );
          // Bare artifact alias now renders the local path, not the rd:// URI.
          expect(String(entered.prompt ?? entered.commandCode)).toContain(artifact.path);
        } finally {
          if (previousPluginRoot === undefined) {
            delete process.env.CLAUDE_PLUGIN_ROOT;
          } else {
            process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
          }
        }
      },
    );

    it('runs through pass/fail workflow', async () => {
      // Create test runbook inline (pattern from CLI check.test.ts)
      const testRunbook = `---
name: test-workflow
---
# Test Workflow

## 1. First Step
- PASS CONTINUE

Do the first thing.

## 2. Second Step
- PASS COMPLETE

Do the second thing.
`;
      const runbookPath = join(tempDir, 'test.runbook.md');
      await writeFile(runbookPath, testRunbook);

      // Start runbook in prompted mode; the owner token is printed once, here.
      let result = runCli(['run', runbookPath, '--prompted'], tempDir);
      expect(result.exitCode).toBe(0);
      const events = parseJsonEvents(result.stdout);
      const runId = startedRunId(events);
      expect(events.find((event) => event.type === 'runbook_started')?.owner_token).toMatch(
        /^rdo_/,
      );

      // Check we're on step 1
      expect(statusOf(runId, tempDir).position.current).toBe('1');

      // A bare pass is refused: the token is the authority, nothing is written.
      result = runCli(['pass', '--step', '1'], tempDir);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('TOKEN_REQUIRED');
      expect(statusOf(runId, tempDir).position.current).toBe('1');

      // Pass first step
      result = transition('pass', events, tempDir);
      expect(result.exitCode).toBe(0);

      // Check we're on step 2
      expect(statusOf(runId, tempDir).position.current).toBe('2');

      // --step must name the current position; a stale one is refused.
      result = runCli(withOwnerToken(['pass', '--step', '1'], tempDir), tempDir);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('INVALID_STEP');
      expect(statusOf(runId, tempDir).position.current).toBe('2');

      // Complete the runbook
      result = transition('pass', events, tempDir);
      expect(result.exitCode).toBe(0);
    });

    it('handles fail transition', async () => {
      const testRunbook = `---
name: test-fail-workflow
---
# Test Fail Workflow

## 1. First Step
- PASS CONTINUE
- FAIL GOTO 3

Do the first thing.

## 2. Normal Path
- PASS COMPLETE

Skipped on failure.

## 3. Recovery
- PASS COMPLETE

Recovery step.
`;
      const runbookPath = join(tempDir, 'test-fail.runbook.md');
      await writeFile(runbookPath, testRunbook);

      // Start runbook in prompted mode
      let result = runCli(['run', runbookPath, '--prompted'], tempDir);
      expect(result.exitCode).toBe(0);
      const events = parseJsonEvents(result.stdout);
      const runId = startedRunId(events);

      // Fail first step - should jump to step 3
      result = transition('fail', events, tempDir);
      expect(result.exitCode).toBe(0);

      // Check we're on step 3 (recovery)
      expect(statusOf(runId, tempDir).position.current).toBe('3');

      // Complete the runbook
      result = transition('pass', events, tempDir);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('goto command navigation', () => {
    it('jumps to specified step', async () => {
      const testRunbook = `---
name: test-goto
---
# Test Goto

## 1. First Step
- PASS CONTINUE

First step.

## 2. Second Step
- PASS CONTINUE

Second step.

## 3. Third Step
- PASS COMPLETE

Third step.
`;
      const runbookPath = join(tempDir, 'test-goto.runbook.md');
      await writeFile(runbookPath, testRunbook);

      // Start runbook in prompted mode
      let result = runCli(['run', runbookPath, '--prompted'], tempDir);
      expect(result.exitCode).toBe(0);
      const runId = startedRunId(parseJsonEvents(result.stdout));

      // Jump directly to step 3 (goto keeps its positional target; authority is --token)
      result = runCli(withOwnerToken(['goto', '3'], tempDir), tempDir);
      expect(result.exitCode).toBe(0);

      // Check we're on step 3
      expect(statusOf(runId, tempDir).position.current).toBe('3');
    });
  });
});
