import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
  type TestWorkspace,
} from '../helpers/test-utils.js';

describe('echo command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('exists and shows help', () => {
    const result = runCli('echo --help', workspace);
    expect(result.stdout).toContain('Echo command');
  });

  describe('result sequence', () => {
    beforeEach(async () => {
      // Start a runbook first (prompted mode to keep it active)
      runCli('run --prompted runbooks/retry.runbook.md', workspace);
    });

    it('returns pass by default (no flags)', () => {
      const result = runCli('echo npm install', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[PASS]');
    });

    it('returns pass with explicit --result pass', () => {
      const result = runCli('echo --result pass npm install', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[PASS]');
    });

    it('returns fail with --result fail', () => {
      const result = runCli('echo --result fail npm install', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('[FAIL]');
    });

    // NOTE: Tests for retry count indexing removed - they relied on 'next --retry'
    // which was removed when 'next' command was replaced by pass/fail/goto.
    // Retry behavior is now tested via FAIL conditions in runbooks.
  });

  describe('error handling', () => {
  it('fails when no active runbook', () => {
    const result = runCli('echo "hello"', workspace);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No active runbook');
  });

    it('fails with invalid result value', () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);

      const result = runCli('echo --result maybe npm install', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid result');
    });
  });
});
