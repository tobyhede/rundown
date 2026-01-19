import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Mock @inquirer/prompts before importing the module under test
jest.unstable_mockModule('@inquirer/prompts', () => ({
  select: jest.fn(),
  confirm: jest.fn(),
}));

// Dynamic import after mocking
const { select, confirm } = await import('@inquirer/prompts');
const {
  PolicyPrompter,
  createNonInteractivePrompter,
  createAutoYesPrompter,
} = await import('../../src/policy/prompter.js');
const { PolicyEvaluator } = await import('../../src/policy/evaluator.js');

describe('PolicyPrompter', () => {
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;
  const mockSelect = select as jest.MockedFunction<typeof select>;
  const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockSelect.mockReset();
    mockConfirm.mockReset();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  describe('non-interactive mode', () => {
    it('createNonInteractivePrompter returns auto-deny prompter', () => {
      const prompter = createNonInteractivePrompter();
      expect(prompter).toBeInstanceOf(PolicyPrompter);
    });

    it('requestPermission returns denied in non-interactive mode', async () => {
      const prompter = new PolicyPrompter({ nonInteractive: true });
      const result = await prompter.requestPermission('run', 'git push');
      expect(result).toEqual({ granted: false, persist: false });
    });

    it('confirmDangerous returns false in non-interactive mode', async () => {
      const prompter = new PolicyPrompter({ nonInteractive: true });
      const result = await prompter.confirmDangerous('Delete all files');
      expect(result).toBe(false);
    });
  });

  describe('auto-yes mode', () => {
    it('createAutoYesPrompter returns auto-approve prompter', () => {
      const prompter = createAutoYesPrompter();
      expect(prompter).toBeInstanceOf(PolicyPrompter);
    });

    it('requestPermission returns granted in auto-yes mode', async () => {
      const prompter = new PolicyPrompter({ autoYes: true });
      const result = await prompter.requestPermission('run', 'npm install');
      expect(result).toEqual({ granted: true, persist: false });
    });

    it('confirmDangerous returns true in auto-yes mode', async () => {
      const prompter = new PolicyPrompter({ autoYes: true });
      const result = await prompter.confirmDangerous('Format disk');
      expect(result).toBe(true);
    });

    it('records session grant when evaluator is provided', async () => {
      const evaluator = new PolicyEvaluator();
      const addGrantSpy = jest.spyOn(evaluator, 'addSessionGrant');
      const prompter = createAutoYesPrompter(evaluator);

      await prompter.requestPermission('run', 'curl api.example.com');

      expect(addGrantSpy).toHaveBeenCalledWith('run', 'curl api.example.com');
    });
  });

  describe('session state tracking', () => {
    it('tracks session-wide allow', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('session-all');

      const result = await prompter.requestPermission('run', 'git status');
      expect(result.granted).toBe(true);
      expect(result.allowAll).toBe(true);

      // Subsequent requests of same type should be auto-granted
      const result2 = await prompter.requestPermission('run', 'git commit');
      expect(result2.granted).toBe(true);
      expect(result2.allowAll).toBe(true);
    });

    it('tracks session-wide deny', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('deny-all');

      await prompter.requestPermission('run', 'rm -rf /');

      // Subsequent requests of same type should be auto-denied
      const result = await prompter.requestPermission('run', 'rm -f temp');
      expect(result.granted).toBe(false);
    });

    it('caches per-subject grants', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('session');

      await prompter.requestPermission('run', 'specific-command');

      // Same subject should be cached
      const result = await prompter.requestPermission('run', 'specific-command');
      expect(result.granted).toBe(true);
      // select should only be called once (cached result used second time)
      expect(mockSelect).toHaveBeenCalledTimes(1);
    });

    it('reset clears state', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('session-all');

      await prompter.requestPermission('run', 'git status');
      prompter.reset();

      // After reset, should prompt again
      mockSelect.mockResolvedValue('once');
      const result = await prompter.requestPermission('run', 'git status');
      expect(mockSelect).toHaveBeenCalledTimes(2);
      expect(result.granted).toBe(true);
    });
  });

  describe('interactive prompt flow', () => {
    it('once action grants without persist', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('once');

      const result = await prompter.requestPermission('run', 'echo test');
      expect(result).toEqual({ granted: true, persist: false });
    });

    it('session action grants with session scope', async () => {
      const evaluator = new PolicyEvaluator();
      const addGrantSpy = jest.spyOn(evaluator, 'addSessionGrant');
      const prompter = new PolicyPrompter({ evaluator });
      mockSelect.mockResolvedValue('session');

      const result = await prompter.requestPermission('run', 'node script.js');

      expect(result.granted).toBe(true);
      expect(result.scope).toBe('session');
      expect(addGrantSpy).toHaveBeenCalledWith('run', 'node script.js');
    });

    it('session-all action grants all same type', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('session-all');

      const result = await prompter.requestPermission('write', '/tmp/file.txt');

      expect(result.granted).toBe(true);
      expect(result.allowAll).toBe(true);
    });

    it('deny-once denies without persist', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('deny-once');

      const result = await prompter.requestPermission('run', 'dangerous-command');
      expect(result).toEqual({ granted: false, persist: false });
    });

    it('deny-all denies all same type', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('deny-all');

      const result = await prompter.requestPermission('env', 'API_KEY');

      expect(result.granted).toBe(false);
      // Future env requests should be auto-denied
    });

    it('handles unknown action by denying', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('unknown-action');

      const result = await prompter.requestPermission('run', 'cmd');
      expect(result).toEqual({ granted: false, persist: false });
    });

    it('handles prompt interruption by denying', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockRejectedValue(new Error('User canceled'));

      const result = await prompter.requestPermission('run', 'cmd');
      expect(result).toEqual({ granted: false, persist: false });
    });
  });

  describe('requestPersistablePermission', () => {
    it('asks about persistence after grant', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValueOnce('once');
      mockConfirm.mockResolvedValue(true);
      mockSelect.mockResolvedValueOnce('permanent');

      const result = await prompter.requestPersistablePermission('run', 'npm test');

      expect(result.granted).toBe(true);
      expect(result.persist).toBe(true);
      expect(result.scope).toBe('permanent');
    });

    it('returns without persist when user declines', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('once');
      mockConfirm.mockResolvedValue(false);

      const result = await prompter.requestPersistablePermission('run', 'npm build');

      expect(result.granted).toBe(true);
      expect(result.persist).toBe(false);
    });

    it('returns original result when permission denied', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('deny-once');

      const result = await prompter.requestPersistablePermission('run', 'bad-cmd');

      expect(result.granted).toBe(false);
      expect(mockConfirm).not.toHaveBeenCalled();
    });

    it('handles persistence prompt interruption', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('once');
      mockConfirm.mockRejectedValue(new Error('User canceled'));

      const result = await prompter.requestPersistablePermission('run', 'cmd');

      expect(result.granted).toBe(true);
      expect(result.persist).toBe(false);
    });
  });

  describe('confirmDangerous', () => {
    it('prompts for confirmation', async () => {
      const prompter = new PolicyPrompter();
      mockConfirm.mockResolvedValue(true);

      const result = await prompter.confirmDangerous('Delete database');

      expect(result).toBe(true);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Dangerous operation')
      );
    });

    it('shows details if provided', async () => {
      const prompter = new PolicyPrompter();
      mockConfirm.mockResolvedValue(false);

      await prompter.confirmDangerous('Delete files', 'This cannot be undone');

      expect(consoleLogSpy).toHaveBeenCalledWith('   This cannot be undone');
    });

    it('handles interruption by returning false', async () => {
      const prompter = new PolicyPrompter();
      mockConfirm.mockRejectedValue(new Error('User canceled'));

      const result = await prompter.confirmDangerous('Operation');
      expect(result).toBe(false);
    });
  });

  describe('type labels and formatting', () => {
    it('displays correct label for run permission', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('once');

      await prompter.requestPermission('run', 'ls -la');

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('command execution')
      );
    });

    it('displays correct label for read permission', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('once');

      await prompter.requestPermission('read', '/etc/passwd');

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('file read')
      );
    });

    it('displays correct label for write permission', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('once');

      await prompter.requestPermission('write', '/tmp/output.txt');

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('file write')
      );
    });

    it('displays correct label for env permission', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('once');

      await prompter.requestPermission('env', 'SECRET_KEY');

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('environment variable access')
      );
    });

    it('formats command subject correctly', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('once');

      await prompter.requestPermission('run', 'docker build .');

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Command:')
      );
    });

    it('formats path subject correctly for read', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('once');

      await prompter.requestPermission('read', '/path/to/file');

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('(read)')
      );
    });

    it('formats path subject correctly for write', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('once');

      await prompter.requestPermission('write', '/path/to/file');

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('(write)')
      );
    });

    it('formats env subject correctly', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('once');

      await prompter.requestPermission('env', 'MY_VAR');

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Variable:')
      );
    });

    it('displays reason if provided', async () => {
      const prompter = new PolicyPrompter();
      mockSelect.mockResolvedValue('once');

      await prompter.requestPermission('run', 'cmd', 'Needed for deployment');

      expect(consoleLogSpy).toHaveBeenCalledWith('   Needed for deployment');
    });
  });
});
