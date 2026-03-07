import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCliInProcess, type TestWorkspace } from '../helpers/test-utils.js';

describe('echo command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('exists and shows help', async () => {
    const result = await runCliInProcess('echo --help', workspace);
    expect(result.stdout).toContain('Echo command');
  });

  describe('result sequence', () => {
    beforeEach(async () => {
      // Start a runbook first (prompted mode to keep it active)
      await runCliInProcess('run --prompted runbooks/retry.runbook.md', workspace);
    });

    it('returns pass by default (no flags)', async () => {
      const result = await runCliInProcess('echo npm install', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('npm install');
    });

    it('returns pass with explicit --result pass', async () => {
      const result = await runCliInProcess('echo --result pass npm install', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('npm install');
    });

    it('returns fail with --result fail', async () => {
      const result = await runCliInProcess('echo --result fail npm install', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('npm install');
    });

    // NOTE: Tests for retry count indexing removed - they relied on 'next --retry'
    // which was removed when 'next' command was replaced by pass/fail/goto.
    // Retry behavior is now tested via FAIL conditions in runbooks.
  });

  describe('error handling', () => {
    it('fails when no active runbook', async () => {
      const result = await runCliInProcess(['echo', 'hello'], workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No active runbook');
    });

    it('fails with invalid result value', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

      const result = await runCliInProcess('echo --result maybe npm install', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid result');
    });
  });
});
