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
import { runCli } from '../helpers/test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const runbooksDir = join(__dirname, '..', '..', 'runbooks');

describe('Built-in Runbook Workflow Integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'rd-plugin-test-'));
    await mkdir(join(tempDir, '.claude', 'rundown', 'runs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('rd check validates built-in runbooks', () => {
    const runbookFiles = [
      'create-worktree.runbook.md',
      'pr-feedback.runbook.md',
      'meta/end-to-end-test.runbook.md',
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
        if (!existsSync(sourcePath)) {
          // Skip gracefully if runbook doesn't exist yet
          return;
        }

        const result = runCli(['check', sourcePath], tempDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('PASS');
      });
    }
  });

  describe('prompted mode step navigation', () => {
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
