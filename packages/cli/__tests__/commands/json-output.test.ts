import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCliInProcess, type TestWorkspace } from '../helpers/test-utils.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('JSON output integration tests', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('ls', () => {
    it('outputs empty array when no runbooks', async () => {
      const result = await runCliInProcess('ls', workspace);
      const output = JSON.parse(result.stdout);
      expect(Array.isArray(output)).toBe(true);
      expect(output).toHaveLength(0);
    });

    it('outputs array of active runbooks', async () => {
      // Start a runbook
      // For run command, file can be in root
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: test-runbook
---
## Step 1
prompt: Wait
`,
      );
      await runCliInProcess('run --prompted test.runbook.md --text', workspace);

      const result = await runCliInProcess('ls', workspace);
      const output = JSON.parse(result.stdout);

      expect(Array.isArray(output)).toBe(true);
      expect(output).toHaveLength(1);
      expect(output[0]).toHaveProperty('id');
      expect(output[0]).toHaveProperty('runbook', 'test.runbook.md');
      expect(output[0]).toHaveProperty('step', 'Step');
      // Should not contain internal props like _status
      expect(output[0]).not.toHaveProperty('_status');
    });

    it('outputs array of available runbooks with --all', async () => {
      // discovery requires runbooks to be in specific dirs
      const runbooksDirPath = workspace.runbooksDir();
      fs.mkdirSync(runbooksDirPath, { recursive: true });

      const runbookPath = path.join(runbooksDirPath, 'test.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: test-runbook
description: A test runbook
---
## Step 1
echo hello
`,
      );

      const result = await runCliInProcess('ls --all', workspace);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);

      expect(Array.isArray(output)).toBe(true);
      expect(output.length).toBeGreaterThan(0);
      const runbook = output.find((r: any) => r.name === 'test-runbook');
      expect(runbook).toBeDefined();
      expect(runbook).toHaveProperty('description', 'A test runbook');
      expect(runbook).toHaveProperty('path');
    });
  });

  describe('status', () => {
    it('outputs inactive status when empty', async () => {
      const result = await runCliInProcess('status', workspace);
      const output = JSON.parse(result.stdout);

      expect(output).toEqual({
        kind: 'status',
        active: false,
        stashed: false,
      });
    });

    it('outputs active status details', async () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: test-runbook
---
## 1 Step
prompt: Wait
`,
      );
      await runCliInProcess('run --prompted test.runbook.md --text', workspace);

      const result = await runCliInProcess('status', workspace);
      const output = JSON.parse(result.stdout);

      expect(output.active).toBe(true);
      expect(output.stashed).toBe(false);
      // Flat structure per docs/spec/cli-output.md
      expect(output).toHaveProperty('file', 'test.runbook.md');
      expect(output.position).toHaveProperty('current', '1');
      expect(output.position).toHaveProperty('total', 1);
    });
  });

  describe('check', () => {
    it('outputs valid status for correct runbook', async () => {
      const runbookPath = path.join(workspace.cwd, 'valid.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `## Step 1
echo hello
`,
      );

      const result = await runCliInProcess(`check ${runbookPath}`, workspace);
      const output = JSON.parse(result.stdout);

      expect(output.valid).toBe(true);
      expect(output.errors).toEqual([]);
      expect(output.stats).toEqual({ steps: 1, substeps: 0 });
    });

    it('outputs errors for invalid runbook', async () => {
      const runbookPath = path.join(workspace.cwd, 'invalid.runbook.md');
      // Invalid transition to non-existent step
      fs.writeFileSync(
        runbookPath,
        `## Step 1
- PASS GOTO 99
echo hello
`,
      );

      const result = await runCliInProcess(`check ${runbookPath}`, workspace);
      // Exit code should be 1
      expect(result.exitCode).toBe(1);

      const output = JSON.parse(result.stdout);
      expect(output.valid).toBe(false);
      expect(output.errors.length).toBeGreaterThan(0);
      expect(output.errors[0]).toHaveProperty('message');
    });

    it('counts step-level runbook-list shorthand as one substep', async () => {
      const runbookPath = path.join(workspace.cwd, 'runbook-shorthand.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `## 1. Review the plan
- FOR pass IN 1 TO 2
- PASS ALL CONTINUE
- FAIL ANY STOP

- review-plan-technical-accuracy.runbook.md
`,
      );

      const result = await runCliInProcess(`check ${runbookPath}`, workspace);
      const output = JSON.parse(result.stdout);

      expect(output.valid).toBe(true);
      expect(output.stats).toEqual({ steps: 1, substeps: 1 });
    });

    it('outputs error for non-existent file', async () => {
      const result = await runCliInProcess('check non-existent.md', workspace);
      expect(result.exitCode).toBe(1);

      const output = JSON.parse(result.stdout);
      expect(output.valid).toBe(false);
      expect(output.errors[0].message).toContain('Runbook not found');
    });
  });

  describe('prune', () => {
    it('outputs empty array when nothing to prune', async () => {
      const result = await runCliInProcess('prune --dry-run', workspace);
      const output = JSON.parse(result.stdout);
      expect(output).toEqual([]);
    });
  });

  describe('scenario', () => {
    it('ls outputs scenarios list', async () => {
      const runbookPath = path.join(workspace.cwd, 'scenarios.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: scenarios-test
scenarios:
  test-scenario:
    description: A test scenario
    commands:
      - echo hello
    result: COMPLETE
---
## Step 1
echo hello
`,
      );

      const result = await runCliInProcess(`scenario ls ${runbookPath}`, workspace);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);

      expect(Array.isArray(output)).toBe(true);
      expect(output).toHaveLength(1);
      expect(output[0]).toEqual({
        name: 'test-scenario',
        expected: 'COMPLETE',
        description: 'A test scenario',
        tags: '',
      });
    });

    it('show outputs structured error for non-existent scenario', async () => {
      const runbookPath = path.join(workspace.cwd, 'scenarios.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `---
name: scenarios-test
scenarios:
  test-scenario:
    description: A test scenario
    commands:
      - echo hello
    result: COMPLETE
---
## Step 1
echo hello
`,
      );

      const result = await runCliInProcess(`scenario show ${runbookPath} non-existent`, workspace);
      expect(result.exitCode).toBe(1);
      // In-process mode may append a process.exit error object after the real output;
      // parse the first complete JSON object from stdout
      const jsonBlocks = result.stdout.trim().split(/\n(?=\{)/);
      const output = JSON.parse(jsonBlocks[0]);

      // Uses standard error format from output.error()
      expect(output).toEqual(
        expect.objectContaining({
          kind: 'error',
          error: 'Scenario "non-existent" not found',
          code: 'SCENARIO_NOT_FOUND',
          command: 'scenario show',
          details: { available: ['test-scenario'] },
        }),
      );
    });
  });

  describe('breaking change: --json flag removed', () => {
    it('rejects --json on status as unknown option', async () => {
      const result = await runCliInProcess('status --json', workspace);
      expect(result.exitCode).not.toBe(0);
    });

    it('rejects --json on ls as unknown option', async () => {
      const result = await runCliInProcess('ls --json', workspace);
      expect(result.exitCode).not.toBe(0);
    });

    it('rejects --json on pass as unknown option', async () => {
      const result = await runCliInProcess('pass --json', workspace);
      expect(result.exitCode).not.toBe(0);
    });
  });
});
