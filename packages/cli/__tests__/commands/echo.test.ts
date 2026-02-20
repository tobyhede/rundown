import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Command } from 'commander';
import { createTestWorkspace, runCli, type TestWorkspace } from '../helpers/test-utils.js';
import { collect, registerEchoCommand } from '../../src/commands/echo.js';
import { OutputEmitter } from '../../src/services/output-emitter.js';
import { EXIT_COMMAND_ERROR } from '../../src/helpers/exit-codes.js';

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

  it('collect appends repeated result values', () => {
    expect(collect('pass', [])).toEqual(['pass']);
    expect(collect('fail', ['pass'])).toEqual(['pass', 'fail']);
  });

  describe('result sequence', () => {
    beforeEach(async () => {
      // Start a runbook first (prompted mode to keep it active)
      runCli('run --prompted runbooks/retry.runbook.md', workspace);
    });

    it('returns pass by default (no flags)', () => {
      const result = runCli('echo npm install', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('npm install');
    });

    it('returns pass with explicit --result pass', () => {
      const result = runCli('echo --result pass npm install', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('npm install');
    });

    it('returns fail with --result fail', () => {
      const result = runCli('echo --result fail npm install', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('npm install');
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

    it('emits command error exit code in JSON payload on unexpected exceptions', async () => {
      const cwdSpy = jest.spyOn(process, 'cwd').mockImplementation(() => {
        throw new Error('boom');
      });
      const detailSpy = jest.spyOn(OutputEmitter.prototype, 'detail');
      const flushSpy = jest
        .spyOn(OutputEmitter.prototype, 'flush')
        .mockImplementation(() => undefined);
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

      try {
        const program = new Command();
        registerEchoCommand(program);

        await expect(program.parseAsync(['node', 'rd', 'echo', '--json', 'hello'])).rejects.toThrow(
          'process.exit',
        );

        expect(detailSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            result: false,
            error: 'boom',
            exitCode: EXIT_COMMAND_ERROR,
          }),
          'echo',
        );
        expect(exitSpy).toHaveBeenCalledWith(EXIT_COMMAND_ERROR);
      } finally {
        cwdSpy.mockRestore();
        detailSpy.mockRestore();
        flushSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });
  });
});
