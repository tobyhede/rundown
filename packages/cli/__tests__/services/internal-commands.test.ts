import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isInternalRdCommand,
  executeRdCommandInternal,
} from '../../src/services/internal-commands.js';
import {
  RunbookStateManager,
  generateOwnerToken,
  hashRunSecret,
  parseRunbook,
  type Runbook,
  type RunId,
  runbooksDir,
  runsDir,
} from '@rundown-org/core';

describe('internal-commands', () => {
  describe('isInternalRdCommand()', () => {
    it('returns true for "rd" prefix with space', () => {
      expect(isInternalRdCommand('rd echo test')).toBe(true);
      expect(isInternalRdCommand('rd pass')).toBe(true);
      expect(isInternalRdCommand('rd fail')).toBe(true);
      expect(isInternalRdCommand('rd status')).toBe(true);
    });

    it('returns true for "rundown" prefix with space', () => {
      expect(isInternalRdCommand('rundown echo test')).toBe(true);
      expect(isInternalRdCommand('rundown pass')).toBe(true);
      expect(isInternalRdCommand('rundown fail')).toBe(true);
    });

    it('returns true for bare "rd" or "rundown"', () => {
      expect(isInternalRdCommand('rd')).toBe(true);
      expect(isInternalRdCommand('rundown')).toBe(true);
    });

    it('returns false for non-rd commands', () => {
      expect(isInternalRdCommand('npm install')).toBe(false);
      expect(isInternalRdCommand('echo hello')).toBe(false);
      expect(isInternalRdCommand('node script.js')).toBe(false);
    });

    it('returns false for commands that start with rd but not as prefix', () => {
      expect(isInternalRdCommand('rdtest')).toBe(false);
      expect(isInternalRdCommand('rundowntest')).toBe(false);
    });

    it('handles leading/trailing whitespace', () => {
      expect(isInternalRdCommand('  rd echo test  ')).toBe(true);
      expect(isInternalRdCommand('  rundown pass  ')).toBe(true);
    });
  });

  describe('executeRdCommandInternal()', () => {
    let tempDir: string;
    let manager: RunbookStateManager;
    let runId: RunId;
    let consoleSpy: jest.SpiedFunction<typeof console.log>;
    let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

    const runbookContent = `## 1. Test step

- PASS COMPLETE
- FAIL STOP

Test step description.

\`\`\`bash
rd echo test
\`\`\`
`;

    /**
     * Helper to seed a running run for testing.
     *
     * `rd echo` runs inside a step command and learns its run from the
     * injected `RD_RUN_ID`, so the seeded run id is returned as the env the
     * command execution would inject.
     */
    async function setupRun(): Promise<Record<string, string>> {
      const runbooksDirPath = runbooksDir(tempDir);
      await writeFile(join(runbooksDirPath, 'test.runbook.md'), runbookContent);

      // Parse runbook to get Runbook object
      const steps = parseRunbook(runbookContent);
      const runbook: Runbook = {
        title: 'Test Runbook',
        steps,
      };

      // Create the run row owned by a fresh token
      const state = await manager.create({ source: 'project', path: 'test.runbook.md' }, runbook, {
        launchDir: '.',
        runbookPath: 'test.runbook.md',
        prompted: true,
        ownerTokenHash: hashRunSecret(generateOwnerToken()),
      });
      runId = state.id;
      return { RD_RUN_ID: state.id };
    }

    beforeEach(async () => {
      // Create isolated temp directory with .claude structure
      tempDir = await mkdtemp(join(tmpdir(), 'internal-cmd-test-'));
      const runbooksDirPath = runbooksDir(tempDir);
      const runsDirPath = runsDir(tempDir);

      await mkdir(runbooksDirPath, { recursive: true });
      await mkdir(runsDirPath, { recursive: true });

      manager = new RunbookStateManager(tempDir);

      // Spy on console methods
      consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    describe('unsupported commands', () => {
      it('returns null for unsupported subcommands', async () => {
        const result = await executeRdCommandInternal('rd status', tempDir);
        expect(result).toBeNull();
      });

      it('returns null for pass command (not yet implemented)', async () => {
        const result = await executeRdCommandInternal('rd pass', tempDir);
        expect(result).toBeNull();
      });

      it('returns null for fail command (not yet implemented)', async () => {
        const result = await executeRdCommandInternal('rd fail', tempDir);
        expect(result).toBeNull();
      });

      it('returns null for empty subcommand', async () => {
        const result = await executeRdCommandInternal('rd', tempDir);
        expect(result).toBeNull();
      });

      it('returns null for rundown without subcommand', async () => {
        const result = await executeRdCommandInternal('rundown', tempDir);
        expect(result).toBeNull();
      });
    });

    describe('echo command', () => {
      it('returns error result when no run context is injected', async () => {
        const previous = process.env.RD_RUN_ID;
        delete process.env.RD_RUN_ID;
        try {
          const result = await executeRdCommandInternal('rd echo test', tempDir);

          expect(result).not.toBeNull();
          expect(result?.success).toBe(false);
          expect(result?.exitCode).toBe(1);
          expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('No run context'));
        } finally {
          if (previous !== undefined) process.env.RD_RUN_ID = previous;
        }
      });

      it('returns error result when the injected run does not exist', async () => {
        const result = await executeRdCommandInternal('rd echo test', tempDir, {
          RD_RUN_ID: 'rd_00000000000000000000000000000000',
        });

        expect(result?.success).toBe(false);
        expect(result?.exitCode).toBe(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          'Error: Run rd_00000000000000000000000000000000 not found.',
        );
      });

      it('returns pass by default when the injected run exists', async () => {
        const env = await setupRun();

        const result = await executeRdCommandInternal('rd echo test', tempDir, env);
        expect(runId).toMatch(/^rd_/);

        expect(result).not.toBeNull();
        expect(result?.success).toBe(true);
        expect(result?.exitCode).toBe(0);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('test'));
      });

      it('returns pass with explicit --result pass', async () => {
        const env = await setupRun();

        const result = await executeRdCommandInternal('rd echo --result pass test', tempDir, env);

        expect(result).not.toBeNull();
        expect(result?.success).toBe(true);
        expect(result?.exitCode).toBe(0);
      });

      it('returns fail with --result fail', async () => {
        const env = await setupRun();

        const result = await executeRdCommandInternal('rd echo --result fail test', tempDir, env);

        expect(result).not.toBeNull();
        expect(result?.success).toBe(false);
        expect(result?.exitCode).toBe(1);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('test'));
      });

      it('returns error for invalid result value', async () => {
        const env = await setupRun();

        const result = await executeRdCommandInternal(
          'rd echo --result invalid test',
          tempDir,
          env,
        );

        expect(result).not.toBeNull();
        expect(result?.success).toBe(false);
        expect(result?.exitCode).toBe(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid result'));
      });

      it('supports short -r flag', async () => {
        const env = await setupRun();

        const result = await executeRdCommandInternal('rd echo -r fail test', tempDir, env);

        expect(result).not.toBeNull();
        expect(result?.success).toBe(false);
        expect(result?.exitCode).toBe(1);
      });

      it('echoes command arguments in output', async () => {
        const env = await setupRun();

        await executeRdCommandInternal('rd echo npm install --save lodash', tempDir, env);

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('npm install --save lodash'),
        );
      });

      it('works with rundown prefix', async () => {
        const env = await setupRun();

        const result = await executeRdCommandInternal('rundown echo test', tempDir, env);

        expect(result).not.toBeNull();
        expect(result?.success).toBe(true);
        expect(result?.exitCode).toBe(0);
      });

      it('strips --text flag from echo output instead of including it literally', async () => {
        const env = await setupRun();

        await executeRdCommandInternal('rd echo --text hello', tempDir, env);

        // '--text' must not appear in the echoed output
        expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('--text'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('hello'));
      });

      it('supports multiple --result options', async () => {
        const env = await setupRun();

        // First call with retry count 0 should use first result (fail)
        const result = await executeRdCommandInternal(
          'rd echo --result fail --result pass test',
          tempDir,
          env,
        );

        expect(result).not.toBeNull();
        expect(result?.success).toBe(false);
        expect(result?.exitCode).toBe(1);
      });
    });
  });
});
