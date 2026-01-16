import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import * as fs from 'fs';
import * as path from 'path';

describe('JSON output integration tests', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('ls --json', () => {
    it('outputs empty array when no runbooks', () => {
      const result = runCli('ls --json', workspace);
      const output = JSON.parse(result.stdout);
      expect(Array.isArray(output)).toBe(true);
      expect(output).toHaveLength(0);
    });

    it('outputs array of active runbooks', () => {
      // Start a runbook
      // For run command, file can be in root
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: test-runbook
---
## Step 1
prompt: Wait
`);
      runCli('run --prompted test.runbook.md', workspace);

      const result = runCli('ls --json', workspace);
      const output = JSON.parse(result.stdout);
      
      expect(Array.isArray(output)).toBe(true);
      expect(output).toHaveLength(1);
      expect(output[0]).toHaveProperty('id');
      expect(output[0]).toHaveProperty('runbook', 'test.runbook.md');
      expect(output[0]).toHaveProperty('step', 'Step');
      // Should not contain internal props like _status
      expect(output[0]).not.toHaveProperty('_status');
    });

    it('outputs array of available runbooks with --all', () => {
      // discovery requires runbooks to be in specific dirs
      const runbooksDir = path.join(workspace.cwd, '.claude', 'rundown', 'runbooks');
      fs.mkdirSync(runbooksDir, { recursive: true });
      
      const runbookPath = path.join(runbooksDir, 'test.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: test-runbook
description: A test runbook
---
## Step 1
echo hello
`);
      
      const result = runCli('ls --all --json', workspace);
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

  describe('status --json', () => {
    it('outputs inactive status when empty', () => {
      const result = runCli('status --json', workspace);
      const output = JSON.parse(result.stdout);
      
      expect(output).toEqual({
        active: false,
        stashed: false
      });
    });

    it('outputs active status details', () => {
      const runbookPath = path.join(workspace.cwd, 'test.runbook.md');
      fs.writeFileSync(runbookPath, `---
name: test-runbook
---
## Step 1
prompt: Wait
`);
      runCli('run --prompted test.runbook.md', workspace);

      const result = runCli('status --json', workspace);
      const output = JSON.parse(result.stdout);

      expect(output.active).toBe(true);
      expect(output.stashed).toBe(false);
      expect(output.runbook).toHaveProperty('file', 'test.runbook.md');
      expect(output.step).toHaveProperty('current', 'Step');
      expect(output.step).toHaveProperty('total', 1);
    });
  });

  describe('check --json', () => {
    it('outputs valid status for correct runbook', () => {
      const runbookPath = path.join(workspace.cwd, 'valid.runbook.md');
      fs.writeFileSync(runbookPath, `## Step 1
echo hello
`);
      
      const result = runCli(`check ${runbookPath} --json`, workspace);
      const output = JSON.parse(result.stdout);

      expect(output.valid).toBe(true);
      expect(output.errors).toEqual([]);
      expect(output.stats).toEqual({ steps: 1, substeps: 0 });
    });

    it('outputs errors for invalid runbook', () => {
      const runbookPath = path.join(workspace.cwd, 'invalid.runbook.md');
      // Invalid transition to non-existent step
      fs.writeFileSync(runbookPath, `## Step 1
- PASS: GOTO 99
echo hello
`);

      const result = runCli(`check ${runbookPath} --json`, workspace);
      // Exit code should be 1
      expect(result.exitCode).toBe(1);
      
      const output = JSON.parse(result.stdout);
      expect(output.valid).toBe(false);
      expect(output.errors.length).toBeGreaterThan(0);
      expect(output.errors[0]).toHaveProperty('message');
    });

    it('outputs error for non-existent file', () => {
      const result = runCli('check non-existent.md --json', workspace);
      expect(result.exitCode).toBe(1);
      
      const output = JSON.parse(result.stdout);
      expect(output.valid).toBe(false);
      expect(output.errors[0].message).toContain('File not found');
    });
  });

  describe('prune --json', () => {
    it('outputs empty array when nothing to prune', () => {
      const result = runCli('prune --dry-run --json', workspace);
      const output = JSON.parse(result.stdout);
      expect(output).toEqual([]);
    });
  });

  describe('scenario --json', () => {
    it('ls outputs scenarios list', () => {
      const runbookPath = path.join(workspace.cwd, 'scenarios.runbook.md');
      fs.writeFileSync(runbookPath, `---
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
`);

      const result = runCli(`scenario ls ${runbookPath} --json`, workspace);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);

      expect(Array.isArray(output)).toBe(true);
      expect(output).toHaveLength(1);
      expect(output[0]).toEqual({
        name: 'test-scenario',
        expected: 'COMPLETE',
        description: 'A test scenario',
        tags: ''
      });
    });

    it('show outputs structured error for non-existent scenario', () => {
      const runbookPath = path.join(workspace.cwd, 'scenarios.runbook.md');
      fs.writeFileSync(runbookPath, `---
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
`);

      const result = runCli(`scenario show ${runbookPath} non-existent --json`, workspace);
      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);

      expect(output).toEqual({
        error: true,
        message: 'Scenario "non-existent" not found',
        available: ['test-scenario']
      });
    });
  });
});
