import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Command } from 'commander';
import { createTestWorkspace, runCliInProcess, type TestWorkspace } from '../helpers/test-utils.js';
// Stryker static-import linkage (mutation testing): links this test file into
// Jest's static inverse-module graph so `--findRelatedTests src/commands/echo.ts`
// credits the behavioural tests below (which reach the command only via the
// dynamic `import('../cli.js')` seam in runCliInProcess). See collect.test.ts.
import { registerEchoCommand } from '../../src/commands/echo.js';

describe('echo command wiring', () => {
  it('registers the echo command with its documented flags, descriptions, and defaults', () => {
    const program = new Command();
    registerEchoCommand(program);

    const echo = program.commands.find((c) => c.name() === 'echo');
    expect(echo).toBeDefined();
    expect(echo?.description()).toBe('Echo command for runbook testing');

    const byLong = new Map(echo!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()]).toEqual(expect.arrayContaining(['--result', '--text']));
    expect(byLong.get('--result')?.description).toBe('Add result to sequence (pass|fail)');
    expect(byLong.get('--result')?.short).toBe('-r');
    // `--result` accumulates into an array via its collect argParser; pin the default.
    expect((byLong.get('--result') as { defaultValue?: unknown }).defaultValue).toEqual([]);
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
  });
});

describe('echo command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('exists and shows help', async () => {
    const result = await runCliInProcess('echo --help --text', workspace);
    expect(result.stdout).toContain('Echo command');
  });

  describe('result sequence', () => {
    beforeEach(async () => {
      // Start a runbook first (prompted mode to keep it active)
      await runCliInProcess('run --prompted runbooks/retry.runbook.md --text', workspace);
    });

    it('returns pass by default (no flags)', async () => {
      const result = await runCliInProcess('echo npm install --text', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('npm install');
    });

    it('returns pass with explicit --result pass', async () => {
      const result = await runCliInProcess('echo --result pass npm install --text', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('npm install');
    });

    it('returns fail with --result fail', async () => {
      const result = await runCliInProcess('echo --result fail npm install --text', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('npm install');
    });

    // NOTE: Tests for retry count indexing removed - they relied on 'next --retry'
    // which was removed when 'next' command was replaced by pass/fail/goto.
    // Retry behavior is now tested via FAIL conditions in runbooks.
  });

  describe('error handling', () => {
    it('fails when no active runbook', async () => {
      const result = await runCliInProcess(['echo', 'hello', '--text'], workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No active runbook');
    });

    it('fails with invalid result value', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      const result = await runCliInProcess('echo --result maybe npm install --text', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid result');
    });
  });
});
