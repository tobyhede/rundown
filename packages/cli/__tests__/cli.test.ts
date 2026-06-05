import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
  runCliInProcess,
  type TestWorkspace,
} from './helpers/test-utils.js';

describe('CLI program', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('command registration', () => {
    it('shows help message with no arguments', () => {
      const result = runCli('--help', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('rundown');
    });

    it('shows version with --version flag', () => {
      const result = runCli('--version', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    });

    it('registers run command', () => {
      const result = runCli('run --help --text', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('run');
    });

    it('registers pass command', () => {
      const result = runCli('pass --help --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('registers fail command', () => {
      const result = runCli('fail --help --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('registers complete command', () => {
      const result = runCli('complete --help --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('registers goto command', () => {
      const result = runCli('goto --help --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('registers status command', () => {
      const result = runCli('status --help --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('registers stop command', () => {
      const result = runCli('stop --help --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('registers ls command', () => {
      const result = runCli('ls --help --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('registers stash command', () => {
      const result = runCli('stash --help --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('registers pop command', () => {
      const result = runCli('pop --help --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('registers echo command', () => {
      const result = runCli('echo --help --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('registers check command', () => {
      const result = runCli('check --help --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('registers prune command', () => {
      const result = runCli('prune --help --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('registers prompt command', () => {
      const result = runCli('prompt --help --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('registers scenarios command', () => {
      const result = runCli('scenarios --help --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('registers delegate command', () => {
      const result = runCli('delegate --help', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('registers claim command', () => {
      const result = runCli('claim --help', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('registers abort command', () => {
      const result = runCli('abort --help', workspace);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('global options', () => {
    it('accepts --no-color flag', () => {
      const result = runCli('status --no-color', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('accepts --schema flag', () => {
      const result = runCli('status --schema', workspace);
      expect(result.exitCode).toBe(0);
      // Should output JSON schema
      const output = JSON.parse(result.stdout);
      expect(output).toHaveProperty('$schema');
    });

    it('accepts --allow-all flag', () => {
      const result = runCli('status --allow-all --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('accepts --deny-all flag', () => {
      const result = runCli('status --deny-all --text', workspace);
      // May succeed or fail depending on implementation
      expect([0, 1]).toContain(result.exitCode);
    });

    it('accepts --yes flag', () => {
      const result = runCli('prune --yes --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('accepts --non-interactive flag', () => {
      const result = runCli('status --non-interactive --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('accepts --sandbox flag', () => {
      const result = runCli('status --sandbox --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('accepts --no-sandbox flag', () => {
      const result = runCli('status --no-sandbox --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('accepts --sandbox-strict flag', () => {
      const result = runCli('status --sandbox-strict --text', workspace);
      // May succeed or fail based on sandbox availability
      expect([0, 1]).toContain(result.exitCode);
    });

    it('rejects conflicting --allow-all and --deny-all flags', async () => {
      const result = await runCliInProcess('status --allow-all --deny-all --text', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'Conflicting policy options: --allow-all and --deny-all cannot be used together.',
      );
    });

    it('rejects conflicting --no-sandbox and --sandbox-strict flags', async () => {
      const result = await runCliInProcess(
        'status --no-sandbox --sandbox-strict --text',
        workspace,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'Conflicting policy options: --no-sandbox and --sandbox-strict cannot be used together.',
      );
    });
  });

  describe('policy options', () => {
    it('accepts --allow-run option', () => {
      const result = runCli('status --allow-run echo,ls --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('accepts --allow-read option', () => {
      const result = runCli('status --allow-read /tmp --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('accepts --allow-write option', () => {
      const result = runCli('status --allow-write /tmp --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('accepts --allow-env option', () => {
      const result = runCli('status --allow-env HOME,PATH --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('accepts --policy option', () => {
      const result = runCli('status --policy policy.json --text', workspace);
      // May fail if file doesn't exist, but flag is accepted
      expect([0, 1]).toContain(result.exitCode);
    });
  });

  describe('error handling', () => {
    it('shows error for unknown command', () => {
      const result = runCli('unknown-command --text', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/unknown|error/i);
    });

    it('shows error for invalid option', () => {
      const result = runCli('status --invalid-option --text', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/unknown option|error/i);
    });
  });

  describe('command aliases', () => {
    it('supports "no" alias for fail command', () => {
      const result = runCli('no --help', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/fail/i);
    });
  });

  describe('preAction hooks', () => {
    it('disables color when --no-color is provided', () => {
      const result = runCli('status --no-color', workspace);
      expect(result.exitCode).toBe(0);
      // Output should not contain ANSI escape codes
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching ANSI escape sequences
      expect(result.stdout).not.toMatch(/\x1b\[\d+m/);
    });
  });

  describe('schema output', () => {
    it('outputs schema for status command', () => {
      const result = runCli('status --schema', workspace);
      expect(result.exitCode).toBe(0);
      const schema = JSON.parse(result.stdout);
      expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    });

    it('outputs schema for pass command', () => {
      const result = runCli('pass --schema', workspace);
      expect(result.exitCode).toBe(0);
      const schema = JSON.parse(result.stdout);
      expect(schema).toHaveProperty('$schema');
    });

    it('outputs schema for fail command', () => {
      const result = runCli('fail --schema', workspace);
      expect(result.exitCode).toBe(0);
      const schema = JSON.parse(result.stdout);
      expect(schema).toHaveProperty('$schema');
    });

    it('returns error for schema without command', () => {
      const result = runCli('--schema', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/usage/i);
    });

    it('returns error for unknown command schema', () => {
      const result = runCli('unknown --schema', workspace);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('multiple flags combination', () => {
    it('handles and --no-color together', () => {
      const result = runCli('status --no-color', workspace);
      expect(result.exitCode).toBe(0);
      // Should output valid JSON
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });

    it('handles --allow-all and --yes together', () => {
      const result = runCli('prune --allow-all --yes', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('handles --non-interactive and --yes together', () => {
      const result = runCli('prune --non-interactive --yes', workspace);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('command-specific output', () => {
    it('outputs JSON for status', () => {
      const result = runCli('status', workspace);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toHaveProperty('active');
    });

    it('outputs JSON for ls', () => {
      const result = runCli('ls', workspace);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toBeDefined();
    });

    it('outputs JSON for pass with no active runbook', () => {
      const result = runCli('pass', workspace);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toHaveProperty('kind', 'warning');
      expect(output).toHaveProperty('message', 'No active runbook');
      expect(output).toHaveProperty('code', 'NO_ACTIVE_RUNBOOK');
    });
  });
});
