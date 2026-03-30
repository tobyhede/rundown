/**
 * Contract and lifecycle integration tests for the subagent-stop hook.
 *
 * These tests use the real CLI to create runbook state, capture `rd status --json`
 * output, and feed it through the handler to validate the parsing contract between
 * the plugin and CLI.
 *
 * Critical: Delegation tests must use REAL tokens extracted from `rd delegate` output.
 * The handler hashes the token (SHA-256) and correlates against `tokenHash` in
 * the status output. A fake token's hash won't match.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setExecSync } from '../../src/workflow/hooks/rundown.js';
import { runCli, createMockHookInput, createMockExecSync } from '../helpers/test-utils.js';

// Mock Session to control delegation_active_token
const mockGet = jest.fn();
const mockSet = jest.fn();

jest.unstable_mockModule('../../src/session.js', () => ({
  Session: jest.fn().mockImplementation(() => ({
    get: mockGet,
    set: mockSet,
  })),
}));

const { handleSubagentStop } = await import('../../src/workflow/hooks/subagent-stop.js');

/** Fake token for non-delegation tests (hash won't match any real delegation). */
const FAKE_TOKEN = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const SIMPLE_RUNBOOK = `---
name: contract-test
---
# Contract Test

## 1. First step
- PASS CONTINUE

Do something.

## 2. Second step
- PASS COMPLETE

Do something else.
`;

const PARENT_RUNBOOK = `---
name: parent-contract
---
# Parent Contract

## 1. Delegated step

### 1.1 Child task
- PASS CONTINUE

Delegate this.

## 2. Final step
- PASS COMPLETE

Done.
`;

const CHILD_RUNBOOK = `---
name: child-contract
---
# Child Contract

## 1. Child work
- PASS COMPLETE

Do the child work.
`;

/** Extract delegation token from `rd delegate` stdout. */
function extractToken(stdout: string): string {
  const match = /Token:\s*(rdtk_\S+)/.exec(stdout);
  if (!match) throw new Error(`No token found in delegate output:\n${stdout}`);
  return match[1];
}

describe('subagent-stop contract tests', () => {
  let tempDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
    setExecSync(jest.fn() as never);

    tempDir = mkdtempSync(join(tmpdir(), 'rd-subagent-stop-contract-'));
    mkdirSync(join(tempDir, '.claude', 'rundown', 'runs'), { recursive: true });
  });

  afterEach(() => {
    setExecSync(jest.fn() as never);
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Capture real `rd status --json` output, inject it into the handler
   * via setExecSync, and call handleSubagentStop.
   *
   * @param token - Delegation token to place in Session mock (use real token for delegation tests)
   */
  async function captureStatusAndHandle(
    token: string,
  ): Promise<{ context?: string; violation?: string }> {
    mockGet.mockResolvedValue({ delegation_active_token: token });

    const statusResult = runCli('status --json', tempDir);
    expect(statusResult.exitCode).toBe(0);

    setExecSync(createMockExecSync(statusResult.stdout) as never);

    const input = createMockHookInput('SubagentStop', { cwd: tempDir });
    return handleSubagentStop(input);
  }

  /** Write parent + child runbooks, start parent, delegate, return real token. */
  function setupDelegation(): string {
    writeFileSync(join(tempDir, 'parent.runbook.md'), PARENT_RUNBOOK);
    writeFileSync(join(tempDir, 'child.runbook.md'), CHILD_RUNBOOK);

    const runResult = runCli(['run', join(tempDir, 'parent.runbook.md'), '--prompted'], tempDir);
    expect(runResult.exitCode).toBe(0);

    const delegateResult = runCli('delegate child.runbook.md --step 1.1', tempDir);
    expect(delegateResult.exitCode).toBe(0);

    return extractToken(delegateResult.stdout);
  }

  describe('status shape contract', () => {
    it('parses inactive status (no runbook running)', async () => {
      const result = await captureStatusAndHandle(FAKE_TOKEN);
      expect(result).toEqual({});
    });

    it('parses active status mid-execution (no delegations → completed)', async () => {
      writeFileSync(join(tempDir, 'test.runbook.md'), SIMPLE_RUNBOOK);
      const runResult = runCli(['run', join(tempDir, 'test.runbook.md'), '--prompted'], tempDir);
      expect(runResult.exitCode).toBe(0);

      const result = await captureStatusAndHandle(FAKE_TOKEN);

      // Active with no delegations → treated as completed (parent resumed)
      expect(result).toEqual({});
    });

    it('parses stashed status', async () => {
      writeFileSync(join(tempDir, 'test.runbook.md'), SIMPLE_RUNBOOK);
      let cliResult = runCli(['run', join(tempDir, 'test.runbook.md'), '--prompted'], tempDir);
      expect(cliResult.exitCode).toBe(0);

      cliResult = runCli('stash', tempDir);
      expect(cliResult.exitCode).toBe(0);

      const result = await captureStatusAndHandle(FAKE_TOKEN);

      expect(result.context).toBeDefined();
      expect(result.context).toContain('Delegation Incomplete');
    });
  });

  describe('delegation contract', () => {
    it('detects unclaimed delegation via tokenHash match', async () => {
      const token = setupDelegation();

      const result = await captureStatusAndHandle(token);

      expect(result.context).toBeDefined();
      expect(result.context).toContain('Delegation Never Claimed');
      expect(result.context).toContain('child.runbook.md');
    });

    it('treats claimed child with no delegations as completed', async () => {
      const token = setupDelegation();

      const claimResult = runCli(`claim ${token}`, tempDir);
      expect(claimResult.exitCode).toBe(0);

      const result = await captureStatusAndHandle(token);

      // After claim, child is active with no delegations → completed
      // (cannot distinguish from parent-resumed; no-delegations = completed)
      expect(result).toEqual({});
    });

    it('treats parent resumed after child pass as completed', async () => {
      const token = setupDelegation();

      let cliResult = runCli(`claim ${token}`, tempDir);
      expect(cliResult.exitCode).toBe(0);

      cliResult = runCli('pass', tempDir);
      expect(cliResult.exitCode).toBe(0);

      const result = await captureStatusAndHandle(token);

      // Parent resumes at step 2, no delegations → completed
      expect(result).toEqual({});
    });
  });

  describe('delegation lifecycle', () => {
    it('full lifecycle: delegate → claim → pass → completed', async () => {
      const token = setupDelegation();

      // Claim — child becomes active (no delegations visible)
      let cliResult = runCli(`claim ${token}`, tempDir);
      expect(cliResult.exitCode).toBe(0);

      // After claim: no delegations → treated as completed
      let result = await captureStatusAndHandle(token);
      expect(result).toEqual({});

      // Complete child
      cliResult = runCli('pass', tempDir);
      expect(cliResult.exitCode).toBe(0);

      // After child pass: parent resumed, no delegations → completed
      result = await captureStatusAndHandle(token);
      expect(result).toEqual({});
    });
  });
});
