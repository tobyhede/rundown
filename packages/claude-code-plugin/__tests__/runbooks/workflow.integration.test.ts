/**
 * Integration tests for built-in runbook workflows.
 * Pattern: follows packages/cli/__tests__/check.test.ts structure
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { mkdtempSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  runCli,
  activeRunCapabilityFromRun,
  latestRunCapabilityFromOutput,
} from '../helpers/test-utils.js';

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

function eventRunbookPath(event: JsonEvent): string {
  const runbook = event.runbook as { readonly path?: unknown } | undefined;
  return typeof runbook?.path === 'string' ? runbook.path : '';
}

function inlineLaunchPath(event: JsonEvent): string {
  const inlineLaunch = event.inlineLaunch as
    | {
        readonly childRunbookPath?: unknown;
        readonly childRunbookRef?: { readonly path?: unknown };
      }
    | undefined;
  if (typeof inlineLaunch?.childRunbookPath === 'string') {
    return inlineLaunch.childRunbookPath;
  }
  return typeof inlineLaunch?.childRunbookRef?.path === 'string'
    ? inlineLaunch.childRunbookRef.path
    : '';
}

function eventPromptText(event: JsonEvent): string {
  return typeof event.prompt === 'string' ? event.prompt : '';
}

describe('Built-in Runbook Workflow Integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'rd-plugin-test-'));
    await mkdir(join(tempDir, '.claude', 'rundown', 'runs'), { recursive: true });
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

  describe('prompted mode step navigation', () => {
    function runPromptedUntilStep(
      runbookPath: string,
      stepId: string,
      args: string[] = [],
    ): JsonEvent {
      let result = runCli(['run', runbookPath, '--prompted', ...args], tempDir);
      expect(result.exitCode).toBe(0);
      let runCapability = activeRunCapabilityFromRun(result);
      const events = parseJsonEvents(result.stdout);

      let entered = findEnteredStep(events, stepId);
      for (let index = 0; index < 30 && !entered; index += 1) {
        result = runCli(['pass', '--run-capability', runCapability], tempDir);
        expect(result.exitCode).toBe(0);
        runCapability = latestRunCapabilityFromOutput(result.stdout) ?? runCapability;
        events.push(...parseJsonEvents(result.stdout));
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
    ])('resolves ARTIFACTS for bundled runbook $file', ({
      file,
      step,
      artifactName,
      key,
      args,
    }) => {
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
    });

    it('passes PlanPath from automatic write-plan launch into review-plan launch', async () => {
      const previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
      try {
        const wrapperPath = join(tempDir, 'inline-plan-review.runbook.md');
        await writeFile(
          wrapperPath,
          `# Inline Plan Review

## 1. Write plan
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Write child
- planning/write-plan.runbook.md

## 2. Review plan
- PASS ALL COMPLETE
- FAIL ANY STOP

### 2.1 Review child
- planning/review-plan.runbook.md
`,
        );

        const events: JsonEvent[] = [];
        let combinedOutput = '';
        let result = runCli(
          ['run', wrapperPath, '--prompted', '--input', 'FeatureName=inline-planpath-regression'],
          tempDir,
        );
        expect(result.exitCode).toBe(0);
        let runCapability = activeRunCapabilityFromRun(result);
        combinedOutput += result.stdout + result.stderr;
        events.push(...parseJsonEvents(result.stdout));

        let reviewEntered = events.find(
          (event) =>
            event.type === 'step_entered' &&
            eventRunbookPath(event).includes('planning/review-plan.runbook.md') &&
            eventPromptText(event).includes('plan.json'),
        );

        for (let index = 0; index < 40 && !reviewEntered; index += 1) {
          result = runCli(['pass', '--run-capability', runCapability], tempDir);
          expect(result.exitCode).toBe(0);
          runCapability = latestRunCapabilityFromOutput(result.stdout) ?? runCapability;
          combinedOutput += result.stdout + result.stderr;
          events.push(...parseJsonEvents(result.stdout));
          reviewEntered = events.find(
            (event) =>
              event.type === 'step_entered' &&
              eventRunbookPath(event).includes('planning/review-plan.runbook.md') &&
              eventPromptText(event).includes('plan.json'),
          );
        }

        if (!reviewEntered) {
          throw new Error('Expected automatic inline launch to enter review-plan with PlanPath');
        }

        const inlineLaunches = events.filter((event) => event.inlineLaunch !== undefined);
        expect(inlineLaunches.some((event) => inlineLaunchPath(event).includes('write-plan'))).toBe(
          true,
        );
        expect(
          inlineLaunches.some((event) => inlineLaunchPath(event).includes('review-plan')),
        ).toBe(true);
        expect(combinedOutput).toContain('inlineLaunch');
        expect(combinedOutput).toContain('PlanPath');
        expect(combinedOutput).not.toContain('rd run ');
        expect(combinedOutput).not.toContain('PlanPath is required');
        // Bare artifact alias now renders the local work-dir path, not the rd:// URI.
        expect(eventPromptText(reviewEntered)).toEqual(
          expect.stringMatching(/\.rundown\/work\/.*\/rd_[a-f0-9]{32}\/plan\.json/),
        );
        expect(eventPromptText(reviewEntered)).not.toContain('rd://artifacts/');
        expect(eventPromptText(reviewEntered)).not.toContain('{{ PlanPath }}');
      } finally {
        if (previousPluginRoot === undefined) {
          delete process.env.CLAUDE_PLUGIN_ROOT;
        } else {
          process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
        }
      }
    });

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

      // Start runbook in prompted mode
      let result = runCli(['run', runbookPath, '--prompted'], tempDir);
      expect(result.exitCode).toBe(0);

      // Check we're on step 1
      result = runCli('status', tempDir);
      expect(result.exitCode).toBe(0);
      const status1 = JSON.parse(result.stdout);
      expect(status1.position.current).toBe('1');

      // Pass first step
      result = runCli('pass', tempDir);
      expect(result.exitCode).toBe(0);

      // Check we're on step 2
      result = runCli('status', tempDir);
      expect(result.exitCode).toBe(0);
      const status2 = JSON.parse(result.stdout);
      expect(status2.position.current).toBe('2');

      // Complete the runbook
      result = runCli('pass', tempDir);
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

      // Fail first step - should jump to step 3
      result = runCli('fail', tempDir);
      expect(result.exitCode).toBe(0);

      // Check we're on step 3 (recovery)
      result = runCli('status', tempDir);
      expect(result.exitCode).toBe(0);
      const status = JSON.parse(result.stdout);
      expect(status.position.current).toBe('3');

      // Complete the runbook
      result = runCli('pass', tempDir);
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

      // Jump directly to step 3
      result = runCli('goto 3', tempDir);
      expect(result.exitCode).toBe(0);

      // Check we're on step 3
      result = runCli('status', tempDir);
      expect(result.exitCode).toBe(0);
      const status = JSON.parse(result.stdout);
      expect(status.position.current).toBe('3');
    });
  });
});
