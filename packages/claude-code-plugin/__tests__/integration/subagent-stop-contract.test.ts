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
import { createHash } from 'node:crypto';
import { setExecSync } from '../../src/workflow/hooks/rundown.js';
import { runCli, createMockHookInput } from '../helpers/test-utils.js';
import { mockExecFileSync } from '../helpers/execfile-mock.js';

/** Default agent_id baked into createMockHookInput('SubagentStop'). */
const TEST_AGENT_ID = 'test-agent-123';

/** SHA-256 hash of `token` in the `sha256:<hex>` format used by the hook. */
function hashToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

// Mock Session to control delegation_active_token
import { createSessionMock, setGet } from '../helpers/session-mock.js';

const session = createSessionMock();
const mockSet = session.set;

jest.unstable_mockModule('../../src/session.js', () => ({
  Session: jest.fn().mockImplementation(() => session),
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

/** Extract delegation token from `rd delegate` JSON stdout. */
function extractToken(stdout: string): string {
  const parsed = JSON.parse(stdout) as { token?: string };
  if (!parsed.token) throw new Error(`No token found in delegate output:\n${stdout}`);
  return parsed.token;
}

describe('subagent-stop contract tests', () => {
  let tempDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the WeakMap-backed session state — jest.clearAllMocks only clears
    // call history, so metadata from a prior test would otherwise leak in.
    setGet(session, 'metadata', {});
    mockSet.mockResolvedValue(undefined);
    setExecSync(mockExecFileSync(''));

    tempDir = mkdtempSync(join(tmpdir(), 'rd-subagent-stop-contract-'));
    mkdirSync(join(tempDir, '.claude', 'rundown', 'runs'), { recursive: true });
  });

  afterEach(() => {
    setExecSync(mockExecFileSync(''));
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
    // Seed the per-agent token map (the production shape written by the
    // delegation-dispatch hook). The legacy global key `delegation_active_token`
    // is only consumed when the SubagentStop input has no `agent_id` — and
    // createMockHookInput defaults agent_id to TEST_AGENT_ID.
    setGet(session, 'metadata', {
      delegation_active_tokens: {
        [TEST_AGENT_ID]: {
          kind: 'delegation-active-token',
          agent_id: TEST_AGENT_ID,
          tokenHash: hashToken(token),
          createdAt: new Date().toISOString(),
        },
      },
    });

    const statusResult = runCli('status', tempDir);
    expect(statusResult.exitCode).toBe(0);

    setExecSync(mockExecFileSync(statusResult.stdout));

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

    it('surfaces parent state when active with no delegations and token unmatched', async () => {
      writeFileSync(join(tempDir, 'test.runbook.md'), SIMPLE_RUNBOOK);
      const runResult = runCli(['run', join(tempDir, 'test.runbook.md'), '--prompted'], tempDir);
      expect(runResult.exitCode).toBe(0);

      const result = await captureStatusAndHandle(FAKE_TOKEN);

      // Active with no delegations → completed with parent state surfaced
      expect(result.context).toContain('Delegation Step Complete');
      expect(result.context).toContain('test.runbook.md');
    });

    it('parses stashed status', async () => {
      writeFileSync(join(tempDir, 'test.runbook.md'), SIMPLE_RUNBOOK);
      let cliResult = runCli(['run', join(tempDir, 'test.runbook.md'), '--prompted'], tempDir);
      expect(cliResult.exitCode).toBe(0);

      cliResult = runCli('stash', tempDir);
      expect(cliResult.exitCode).toBe(0);

      const result = await captureStatusAndHandle(FAKE_TOKEN);

      expect(result.context).toBeDefined();
      expect(result.context).toContain('Delegation Stashed');
      expect(result.context).toContain('stashed without being completed');
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

    it('classifies claimed-but-idle child via parentLinkage tokenHash', async () => {
      const token = setupDelegation();

      const claimResult = runCli(`claim ${token}`, tempDir);
      expect(claimResult.exitCode).toBe(0);

      const result = await captureStatusAndHandle(token);

      // After claim, child is active and its parentLinkage.tokenHash matches
      // our consumed token → child_claimed_idle outcome. The banner must point
      // at the child and must NOT claim the parent has advanced.
      expect(result.context).toContain('Delegation Not Resolved');
      expect(result.context).toContain('child.runbook.md');
      expect(result.context).not.toContain('Delegation Step Complete');
    });

    it('surfaces parent state after child pass (parent resumed)', async () => {
      const token = setupDelegation();

      let cliResult = runCli(`claim ${token}`, tempDir);
      expect(cliResult.exitCode).toBe(0);

      cliResult = runCli('pass', tempDir);
      expect(cliResult.exitCode).toBe(0);

      const result = await captureStatusAndHandle(token);

      // Parent resumes at step 2, no delegations → surfaces parent state
      expect(result.context).toContain('Delegation Step Complete');
      expect(result.context).toContain('parent.runbook.md');
    });
  });

  describe('delegation lifecycle', () => {
    it('full lifecycle: delegate → claim (idle) → pass → parent resumed', async () => {
      const token = setupDelegation();

      // Claim — child becomes active carrying parentLinkage.tokenHash
      let cliResult = runCli(`claim ${token}`, tempDir);
      expect(cliResult.exitCode).toBe(0);

      // After claim only: child_claimed_idle via parentLinkage correlation.
      let result = await captureStatusAndHandle(token);
      expect(result.context).toContain('Delegation Not Resolved');
      expect(result.context).toContain('child.runbook.md');

      // Complete child
      cliResult = runCli('pass', tempDir);
      expect(cliResult.exitCode).toBe(0);

      // After child pass: parent resumed, no delegations → completed banner.
      result = await captureStatusAndHandle(token);
      expect(result.context).toContain('Delegation Step Complete');
      expect(result.context).toContain('parent.runbook.md');
    });
  });
});
