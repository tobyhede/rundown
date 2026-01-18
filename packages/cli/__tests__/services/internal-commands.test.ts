import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isInternalRdCommand,
  executeRdCommandInternal,
} from '../../src/services/internal-commands.js';
import { RunbookStateManager, parseRunbook, type Runbook } from '@rundown/core';

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
    let consoleSpy: jest.SpiedFunction<typeof console.log>;
    let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

    const runbookContent = `## 1. Test step

- PASS: COMPLETE
- FAIL: STOP

Test step description.

\`\`\`bash
rd echo test
\`\`\`
`;

    /**
     * Helper to set up an active runbook for testing.
     * Creates runbook state file and adds it to the session.
     */
    async function setupActiveRunbook(): Promise<void> {
      const runbooksDir = join(tempDir, '.claude', 'rundown', 'runbooks');
      await writeFile(join(runbooksDir, 'test.runbook.md'), runbookContent);

      // Parse runbook to get Runbook object
      const steps = parseRunbook(runbookContent);
      const runbook: Runbook = {
        title: 'Test Runbook',
        steps,
      };

      // Create runbook state
      const state = await manager.create('test.runbook.md', runbook, { runbookPath: 'test.runbook.md', prompted: true });

      // Push to make it active
      await manager.pushRunbook(state.id);
    }

    beforeEach(async () => {
      // Create isolated temp directory with .claude structure
      tempDir = await mkdtemp(join(tmpdir(), 'internal-cmd-test-'));
      const runbooksDir = join(tempDir, '.claude', 'rundown', 'runbooks');
      const runsDir = join(tempDir, '.claude', 'rundown', 'runs');

      await mkdir(runbooksDir, { recursive: true });
      await mkdir(runsDir, { recursive: true });

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
      it('returns error result when no active runbook', async () => {
        const result = await executeRdCommandInternal('rd echo test', tempDir);

        expect(result).not.toBeNull();
        expect(result?.success).toBe(false);
        expect(result?.exitCode).toBe(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith('Error: No active runbook.');
      });

      it('returns pass by default when active runbook exists', async () => {
        await setupActiveRunbook();

        const result = await executeRdCommandInternal('rd echo test', tempDir);

        expect(result).not.toBeNull();
        expect(result?.success).toBe(true);
        expect(result?.exitCode).toBe(0);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('test'));
      });

      it('returns pass with explicit --result pass', async () => {
        await setupActiveRunbook();

        const result = await executeRdCommandInternal('rd echo --result pass test', tempDir);

        expect(result).not.toBeNull();
        expect(result?.success).toBe(true);
        expect(result?.exitCode).toBe(0);
      });

      it('returns fail with --result fail', async () => {
        await setupActiveRunbook();

        const result = await executeRdCommandInternal('rd echo --result fail test', tempDir);

        expect(result).not.toBeNull();
        expect(result?.success).toBe(false);
        expect(result?.exitCode).toBe(1);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('test'));
      });

      it('returns error for invalid result value', async () => {
        await setupActiveRunbook();

        const result = await executeRdCommandInternal('rd echo --result invalid test', tempDir);

        expect(result).not.toBeNull();
        expect(result?.success).toBe(false);
        expect(result?.exitCode).toBe(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid result'));
      });

      it('supports short -r flag', async () => {
        await setupActiveRunbook();

        const result = await executeRdCommandInternal('rd echo -r fail test', tempDir);

        expect(result).not.toBeNull();
        expect(result?.success).toBe(false);
        expect(result?.exitCode).toBe(1);
      });

      it('echoes command arguments in output', async () => {
        await setupActiveRunbook();

        await executeRdCommandInternal('rd echo npm install --save lodash', tempDir);

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('npm install --save lodash'));
      });

      it('works with rundown prefix', async () => {
        await setupActiveRunbook();

        const result = await executeRdCommandInternal('rundown echo test', tempDir);

        expect(result).not.toBeNull();
        expect(result?.success).toBe(true);
        expect(result?.exitCode).toBe(0);
      });

      it('supports multiple --result options', async () => {
        await setupActiveRunbook();

        // First call with retry count 0 should use first result (fail)
        const result = await executeRdCommandInternal(
          'rd echo --result fail --result pass test',
          tempDir
        );

        expect(result).not.toBeNull();
        expect(result?.success).toBe(false);
        expect(result?.exitCode).toBe(1);
      });
    });
  });
});
