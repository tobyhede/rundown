import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { executeCommandWithPolicy } from '../src/runbook/executor.js';
import { PolicyEvaluator, DEFAULT_POLICY, extractAllExecutables, extractBacktickCommands } from '../src/policy/index.js';
import { isSandboxAvailable, checkSandboxAvailability } from '../src/sandbox/index.js';

describe('Security Policy Gaps', () => {
  let tmpDir: string;
  let secretFile: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundown-security-test-'));
    secretFile = path.join(tmpDir, 'secret.txt');
    fs.writeFileSync(secretFile, 'SUPER SECRET DATA');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('File access enforcement', () => {
    it('blocks reading denied files when sandbox is available', async () => {
      // Skip if sandbox not available
      const sandboxAvailable = await isSandboxAvailable();
      if (!sandboxAvailable) {
        console.log('Skipping test: sandbox not available on this platform');
        return;
      }

      const policy = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          mode: 'deny' as const,
          run: {
            allow: ['cat'],
            deny: []
          },
          read: {
            allow: [],
            deny: ['**/secret.txt']
          },
          write: { allow: [], deny: [] },
          env: { allow: [], deny: [] }
        }
      };

      const evaluator = new PolicyEvaluator(policy, {
        repoRoot: tmpDir,
        tmpDir: tmpDir
      });

      const result = await executeCommandWithPolicy(`cat ${secretFile}`, tmpDir, {
        evaluator,
        sandbox: true,
      });

      // With sandbox, file access should be blocked
      expect(result.sandboxed).toBe(true);
      // The command should fail (either policyDenied or exitCode != 0)
      expect(result.success).toBe(false);
    });

    it('blocks writing to denied files when sandbox is available', async () => {
      const sandboxAvailable = await isSandboxAvailable();
      if (!sandboxAvailable) {
        console.log('Skipping test: sandbox not available on this platform');
        return;
      }

      const outputFile = path.join(tmpDir, 'output.txt');

      const policy = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          mode: 'deny' as const,
          run: {
            allow: ['echo', 'tee'],
            deny: []
          },
          read: { allow: [], deny: [] },
          write: {
            allow: [],
            deny: ['**/output.txt']
          },
          env: { allow: [], deny: [] }
        }
      };

      const evaluator = new PolicyEvaluator(policy, {
        repoRoot: tmpDir,
        tmpDir: tmpDir
      });

      const result = await executeCommandWithPolicy(`echo data | tee ${outputFile}`, tmpDir, {
        evaluator,
        sandbox: true,
      });

      expect(result.sandboxed).toBe(true);
      expect(result.success).toBe(false);
    });

    it('allows file access when sandbox is disabled', async () => {
      const policy = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          mode: 'deny' as const,
          run: {
            allow: ['cat'],
            deny: []
          },
          read: {
            allow: [],
            deny: ['**/secret.txt']
          },
          write: { allow: [], deny: [] },
          // Must allow PATH for commands to work
          env: { allow: ['PATH', 'HOME', 'USER', 'TERM'], deny: [] }
        }
      };

      const evaluator = new PolicyEvaluator(policy, {
        repoRoot: tmpDir,
        tmpDir: tmpDir
      });

      // With sandbox disabled, file access is NOT enforced
      const result = await executeCommandWithPolicy(`cat ${secretFile}`, tmpDir, {
        evaluator,
        sandbox: false,
      });

      // Command is allowed (no sandbox enforcement)
      expect(result.sandboxed).toBe(false);
      // Note: Command succeeds because sandbox is disabled
      expect(result.success).toBe(true);
    });

    it('fails with sandboxStrict when sandbox unavailable', async () => {
      // This test checks the strict mode behavior
      // On platforms where sandbox IS available, it won't trigger the strict failure
      // On platforms where sandbox is NOT available, it should fail

      const policy = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          mode: 'deny' as const,
          run: { allow: ['echo'], deny: [] },
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
          // Must allow PATH for commands to work
          env: { allow: ['PATH', 'HOME', 'USER', 'TERM'], deny: [] }
        }
      };

      const evaluator = new PolicyEvaluator(policy, { repoRoot: tmpDir });

      const result = await executeCommandWithPolicy('echo test', tmpDir, {
        evaluator,
        sandbox: true,
        sandboxStrict: true,
      });

      // If sandbox is available, the command was sandboxed
      // If sandbox is unavailable, command fails with policyDenied
      const availability = await checkSandboxAvailability();
      if (availability.available) {
        // Sandbox was used - command may or may not succeed depending on profile
        expect(result.sandboxed).toBe(true);
        // In strict mode with sandbox available, should not be policy denied
        expect(result.policyDenied).toBeFalsy();
      } else {
        expect(result.policyDenied).toBe(true);
        expect(result.sandboxed).toBe(false);
      }
    });
  });

  describe('Backtick command extraction', () => {
    it('blocks denied commands hidden in backticks', async () => {
      const policy = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          mode: 'deny' as const,
          run: {
            allow: ['echo'],
            deny: ['id']
          },
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
          env: { allow: [], deny: [] }
        }
      };

      const evaluator = new PolicyEvaluator(policy, { repoRoot: tmpDir });

      // The parser now extracts 'id' from backticks
      const result = await executeCommandWithPolicy('echo `id`', tmpDir, {
        evaluator,
        sandbox: false, // Disable sandbox to test command policy only
      });

      expect(result.policyDenied).toBe(true);
    });

    it('extracts executables from backticks', () => {
      const executables = extractBacktickCommands('echo `id`');
      expect(executables).toContain('id');
    });

    it('extracts multiple commands from backticks', () => {
      const executables = extractBacktickCommands('echo `whoami` `hostname`');
      expect(executables).toContain('whoami');
      expect(executables).toContain('hostname');
    });

    it('extractAllExecutables includes backtick commands', () => {
      const executables = extractAllExecutables('echo `id`');
      expect(executables).toContain('echo');
      expect(executables).toContain('id');
    });
  });

  describe('Subshell command extraction', () => {
    it('blocks denied commands hidden in subshells $(...)', async () => {
      const policy = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          mode: 'deny' as const,
          run: {
            allow: ['echo'],
            deny: ['id']
          },
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
          env: { allow: [], deny: [] }
        }
      };

      const evaluator = new PolicyEvaluator(policy, { repoRoot: tmpDir });

      const result = await executeCommandWithPolicy('echo $(id)', tmpDir, {
        evaluator,
        sandbox: false,
      });

      // shell-quote handles $() correctly
      expect(result.policyDenied).toBe(true);
    });
  });
});

describe('Sandbox Availability', () => {
  it('returns availability information for current platform', async () => {
    const availability = await checkSandboxAvailability();

    expect(availability).toHaveProperty('available');
    expect(availability).toHaveProperty('mechanism');
    expect(availability).toHaveProperty('platform');
    expect(availability).toHaveProperty('supportsReadRestrictions');
    expect(availability).toHaveProperty('supportsWriteRestrictions');

    // Platform should match current platform
    expect(availability.platform).toBe(process.platform);

    // Mechanism should be appropriate for platform
    if (process.platform === 'darwin') {
      expect(['seatbelt', 'none']).toContain(availability.mechanism);
    } else if (process.platform === 'linux') {
      expect(['landlock', 'none']).toContain(availability.mechanism);
    } else {
      expect(availability.mechanism).toBe('none');
    }
  });

  it('isSandboxAvailable returns boolean', async () => {
    const available = await isSandboxAvailable();
    expect(typeof available).toBe('boolean');
  });
});
