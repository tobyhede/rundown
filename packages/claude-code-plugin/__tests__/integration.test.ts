// packages/claude-code-plugin/__tests__/integration.test.ts
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const execAsync = promisify(exec);

// Helper function to run hook dispatch safely using stdin
async function runHookDispatch(
  cliPath: string,
  input: object,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [cliPath], { cwd: dirname(cliPath) });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, code });
    });

    proc.on('error', (err) => {
      reject(err);
    });

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

describe('Integration Tests', () => {
  let testDir: string;
  let cliPath: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(join(tmpdir(), 'rundown-test-integration-'));
    cliPath = join(__dirname, '../dist/cli.js');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Session Management', () => {
    test('set and get command', async () => {
      await execAsync(`node ${cliPath} session set active_command /execute ${testDir}`);
      const { stdout } = await execAsync(`node ${cliPath} session get active_command ${testDir}`);
      expect(stdout.trim()).toBe('/execute');
    });

    test('append and check contains', async () => {
      await execAsync(`node ${cliPath} session append file_extensions ts ${testDir}`);

      const result = await execAsync(
        `node ${cliPath} session contains file_extensions ts ${testDir}`,
      )
        .then(() => true)
        .catch(() => false);

      expect(result).toBe(true);
    });

    test('clear removes state', async () => {
      await execAsync(`node ${cliPath} session set active_command /plan ${testDir}`);
      await execAsync(`node ${cliPath} session clear ${testDir}`);

      const { stdout } = await execAsync(`node ${cliPath} session get active_command ${testDir}`);
      expect(stdout.trim()).toBe('');
    });
  });

  describe('Hook Dispatch with Session Tracking', () => {
    test('PostToolUse updates session', async () => {
      const hookInput = {
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        file_path: 'main.ts',
        cwd: testDir,
      };

      const { code } = await runHookDispatch(cliPath, hookInput);
      expect(code).toBe(0);

      const { stdout: files } = await execAsync(
        `node ${cliPath} session get edited_files ${testDir}`,
      );
      expect(files).toContain('main.ts');

      const containsTs = await execAsync(
        `node ${cliPath} session contains file_extensions ts ${testDir}`,
      )
        .then(() => true)
        .catch(() => false);
      expect(containsTs).toBe(true);
    });

    test('UserPromptSubmit with /command sets active_command', async () => {
      const input = {
        hook_event_name: 'UserPromptSubmit',
        user_message: '/execute do something',
        cwd: testDir,
      };
      const { code } = await runHookDispatch(cliPath, input);
      expect(code).toBe(0);

      const { stdout } = await execAsync(`node ${cliPath} session get active_command ${testDir}`);
      expect(stdout.trim()).toBe('execute');
    });

    test('PreToolUse Skill sets active_skill', async () => {
      const input = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'executing-plans' },
        cwd: testDir,
      };
      const { code } = await runHookDispatch(cliPath, input);
      expect(code).toBe(0);

      const { stdout } = await execAsync(`node ${cliPath} session get active_skill ${testDir}`);
      expect(stdout.trim()).toBe('executing-plans');
    });
  });

  describe('Error Handling', () => {
    test('handles corrupted state file gracefully', async () => {
      const stateFile = join(testDir, '.claude', 'session', 'state.json');
      await fs.mkdir(dirname(stateFile), { recursive: true });
      await fs.writeFile(stateFile, '{invalid json', 'utf-8');

      // Should reinitialize and work
      await execAsync(`node ${cliPath} session set active_command /plan ${testDir}`);
      const { stdout } = await execAsync(`node ${cliPath} session get active_command ${testDir}`);
      expect(stdout.trim()).toBe('/plan');
    });

    test('rejects invalid session keys', async () => {
      try {
        await execAsync(`node ${cliPath} session get invalid_key ${testDir}`);
        throw new Error('Should have thrown error');
      } catch (error: any) {
        if (error.message === 'Should have thrown error') throw error;
        expect(error.stderr).toContain('Invalid session key');
      }
    });

    test('rejects invalid array keys for append', async () => {
      try {
        await execAsync(`node ${cliPath} session append invalid_key value ${testDir}`);
        throw new Error('Should have thrown error');
      } catch (error: any) {
        if (error.message === 'Should have thrown error') throw error;
        expect(error.stderr).toContain('Invalid array key');
      }
    });
  });
});
