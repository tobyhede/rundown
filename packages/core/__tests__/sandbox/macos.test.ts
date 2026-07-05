import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { SandboxOptions } from '../../src/sandbox/types.js';

// Mock child_process
const actualChildProcess = await import('node:child_process');
jest.unstable_mockModule('node:child_process', () => ({
  ...actualChildProcess,
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));

// Mock fs
const actualFs = await import('node:fs');
jest.unstable_mockModule('node:fs', () => ({
  ...actualFs,
  existsSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  realpathSync: jest.fn((p: string) => p), // Return path as-is for testing
}));

// Import after mocking
const { SeatbeltSandbox } = await import('../../src/sandbox/macos.js');
const { spawn, spawnSync } = await import('node:child_process');
const { existsSync, writeFileSync, unlinkSync } = await import('node:fs');

describe('SeatbeltSandbox', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    jest.clearAllMocks();
    (writeFileSync as jest.Mock).mockImplementation(() => undefined);
    (unlinkSync as jest.Mock).mockImplementation(() => undefined);
    (spawnSync as jest.Mock).mockReturnValue({ status: 0, error: undefined });
  });

  afterEach(() => {
    // Safety net: restore platform even if withPlatform helper isn't used
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  describe('getAvailability', () => {
    it('returns unavailable on non-darwin platform', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const sandbox = new SeatbeltSandbox();

      const availability = await sandbox.getAvailability();

      expect(availability.available).toBe(false);
      expect(availability.mechanism).toBe('none');
      expect(availability.reason).toContain('only available on macOS');
      expect(availability.platform).toBe('linux');
    });

    it('returns unavailable when sandbox-exec not found', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      (existsSync as jest.Mock).mockReturnValue(false);

      const sandbox = new SeatbeltSandbox();
      const availability = await sandbox.getAvailability();

      expect(availability.available).toBe(false);
      expect(availability.mechanism).toBe('none');
      expect(availability.reason).toContain('sandbox-exec not found');
    });

    it('returns available when on darwin and sandbox-exec exists', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      (existsSync as jest.Mock).mockReturnValue(true);
      (spawnSync as jest.Mock).mockReturnValue({ status: 0, error: undefined });

      const sandbox = new SeatbeltSandbox();
      const availability = await sandbox.getAvailability();

      expect(availability.available).toBe(true);
      expect(availability.mechanism).toBe('seatbelt');
      expect(availability.platform).toBe('darwin');
      expect(availability.supportsReadRestrictions).toBe(true);
      expect(availability.supportsWriteRestrictions).toBe(true);
      expect(availability.supportsDenyPaths).toBe(true);
      // The probe must exec /usr/bin/true: macOS ships no /bin/true, so a
      // /bin/true probe fails with ENOENT and falsely reports the sandbox
      // unavailable (#544).
      expect(spawnSync).toHaveBeenCalledWith(
        '/usr/bin/sandbox-exec',
        ['-f', expect.stringContaining('.sb'), '/usr/bin/true'],
        expect.objectContaining({
          stdio: 'ignore',
          timeout: 5000,
          killSignal: 'SIGKILL',
        }),
      );
    });

    it('returns unavailable when the probe profile cannot be written', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      (existsSync as jest.Mock).mockReturnValue(true);
      (writeFileSync as jest.Mock).mockImplementation(() => {
        throw new Error('disk full');
      });

      const sandbox = new SeatbeltSandbox();
      const availability = await sandbox.getAvailability();

      expect(availability).toEqual(
        expect.objectContaining({
          available: false,
          mechanism: 'none',
          platform: 'darwin',
          supportsReadRestrictions: false,
          supportsWriteRestrictions: false,
          supportsDenyPaths: false,
          reason: expect.stringContaining('disk full'),
        }),
      );
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it('returns unavailable when the probe spawn fails and uses a timeout', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      (existsSync as jest.Mock).mockReturnValue(true);
      (writeFileSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });
      (spawnSync as jest.Mock).mockImplementation(() => {
        throw new Error('probe timed out');
      });

      const sandbox = new SeatbeltSandbox();
      const availability = await sandbox.getAvailability();

      expect(spawnSync).toHaveBeenCalledWith(
        '/usr/bin/sandbox-exec',
        ['-f', expect.stringContaining('.sb'), '/usr/bin/true'],
        expect.objectContaining({
          stdio: 'ignore',
          timeout: 5000,
          killSignal: 'SIGKILL',
        }),
      );
      expect(availability).toEqual(
        expect.objectContaining({
          available: false,
          mechanism: 'none',
          platform: 'darwin',
          supportsReadRestrictions: false,
          supportsWriteRestrictions: false,
          supportsDenyPaths: false,
          reason: expect.stringContaining('probe timed out'),
        }),
      );
      expect(unlinkSync).toHaveBeenCalled();
    });

    it('caches availability result', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      (existsSync as jest.Mock).mockReturnValue(true);
      (spawnSync as jest.Mock).mockReturnValue({ status: 0, error: undefined });

      const sandbox = new SeatbeltSandbox();
      await sandbox.getAvailability();
      await sandbox.getAvailability();

      // existsSync should only be called once due to caching
      expect(existsSync).toHaveBeenCalledTimes(1);
    });
  });

  describe('isAvailable', () => {
    it('returns true when available', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      (existsSync as jest.Mock).mockReturnValue(true);
      (spawnSync as jest.Mock).mockReturnValue({ status: 0, error: undefined });

      const sandbox = new SeatbeltSandbox();
      const result = await sandbox.isAvailable();

      expect(result).toBe(true);
    });

    it('returns false when unavailable', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      const sandbox = new SeatbeltSandbox();
      const result = await sandbox.isAvailable();

      expect(result).toBe(false);
    });
  });

  describe('execute', () => {
    const mockOptions: SandboxOptions = {
      cwd: '/test/cwd',
      repoRoot: '/test/repo',
      readOnlyPaths: ['/test/read'],
      readWritePaths: ['/test/write'],
      denyPatterns: [],
      denyPaths: [],
      env: { PATH: '/usr/bin', HOME: '/Users/test' },
    };

    it('executes command successfully', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      (existsSync as jest.Mock).mockReturnValue(true);
      (writeFileSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });
      (unlinkSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });

      const mockChild = {
        on: jest.fn((event: string, callback: (arg?: number | Error) => void) => {
          if (event === 'close') {
            process.nextTick(() => {
              callback(0);
            });
          }
          return mockChild;
        }),
      };
      (spawn as jest.Mock).mockReturnValue(mockChild);

      const sandbox = new SeatbeltSandbox();
      const result = await sandbox.execute('echo hello', mockOptions);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.sandboxed).toBe(true);
      expect(writeFileSync).toHaveBeenCalled();
      expect(unlinkSync).toHaveBeenCalled();
    });

    it('writes metadata-only ancestor rules into the generated profile', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      (existsSync as jest.Mock).mockReturnValue(true);
      (writeFileSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });
      (unlinkSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });

      const mockChild = {
        on: jest.fn((event: string, callback: (arg?: number | Error) => void) => {
          if (event === 'close') {
            process.nextTick(() => {
              callback(0);
            });
          }
          return mockChild;
        }),
      };
      (spawn as jest.Mock).mockReturnValue(mockChild);

      const sandbox = new SeatbeltSandbox();
      await sandbox.execute('node script.js', {
        ...mockOptions,
        metadataReadPaths: ['/Users', '/Users/test', '/Users/test/project'],
      });

      expect(writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('(literal "/Users/test/project")'),
        expect.any(Object),
      );
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('(allow file-read-metadata'),
        expect.any(Object),
      );
    });

    it('handles non-zero exit code', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      (existsSync as jest.Mock).mockReturnValue(true);
      (writeFileSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });
      (unlinkSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });

      const mockChild = {
        on: jest.fn((event: string, callback: (arg?: number | Error) => void) => {
          if (event === 'close') {
            process.nextTick(() => {
              callback(1);
            });
          }
          return mockChild;
        }),
      };
      (spawn as jest.Mock).mockReturnValue(mockChild);

      const sandbox = new SeatbeltSandbox();
      const result = await sandbox.execute('exit 1', mockOptions);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.sandboxed).toBe(true);
    });

    it('handles null exit code', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      (existsSync as jest.Mock).mockReturnValue(true);
      (writeFileSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });
      (unlinkSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });

      const mockChild = {
        on: jest.fn((event: string, callback: (arg?: number | null | Error) => void) => {
          if (event === 'close') {
            process.nextTick(() => {
              callback(null);
            });
          }
          return mockChild;
        }),
      };
      (spawn as jest.Mock).mockReturnValue(mockChild);

      const sandbox = new SeatbeltSandbox();
      const result = await sandbox.execute('command', mockOptions);

      // null exit code should default to 1
      expect(result.exitCode).toBe(1);
      expect(result.success).toBe(false);
    });

    it('handles process error event', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      (existsSync as jest.Mock).mockReturnValue(true);
      (writeFileSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });
      (unlinkSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });

      const mockChild = {
        on: jest.fn((event: string, callback: (arg?: number | Error) => void) => {
          if (event === 'error') {
            process.nextTick(() => {
              callback(new Error('spawn failed'));
            });
          }
          return mockChild;
        }),
      };
      (spawn as jest.Mock).mockReturnValue(mockChild);

      const sandbox = new SeatbeltSandbox();
      const result = await sandbox.execute('invalid-command', mockOptions);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.sandboxed).toBe(true);
      expect(result.policyDenied).toBe(true);
      expect(result.denialReason).toContain('spawn failed');
    });

    it('cleans up profile file even when unlinkSync throws', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      (existsSync as jest.Mock).mockReturnValue(true);
      (writeFileSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });
      (unlinkSync as jest.Mock).mockImplementation(() => {
        throw new Error('unlink failed');
      });

      const mockChild = {
        on: jest.fn((event: string, callback: (arg?: number | Error) => void) => {
          if (event === 'close') {
            process.nextTick(() => {
              callback(0);
            });
          }
          return mockChild;
        }),
      };
      (spawn as jest.Mock).mockReturnValue(mockChild);

      const sandbox = new SeatbeltSandbox();
      // Should not throw despite unlinkSync failure
      const result = await sandbox.execute('echo hello', mockOptions);

      expect(result.success).toBe(true);
      expect(unlinkSync).toHaveBeenCalled();
    });

    it('generates profile with escaped paths', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      (existsSync as jest.Mock).mockReturnValue(true);
      (writeFileSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });
      (unlinkSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });

      const mockChild = {
        on: jest.fn((event: string, callback: (arg?: number | Error) => void) => {
          if (event === 'close') {
            process.nextTick(() => {
              callback(0);
            });
          }
          return mockChild;
        }),
      };
      (spawn as jest.Mock).mockReturnValue(mockChild);

      const optionsWithSpecialChars: SandboxOptions = {
        cwd: '/test/cwd',
        repoRoot: '/test/repo',
        readOnlyPaths: ['/path/with"quote'],
        readWritePaths: ['/path/with"double"quotes'],
        denyPatterns: [],
        denyPaths: [],
        env: { PATH: '/usr/bin' },
      };

      const sandbox = new SeatbeltSandbox();
      await sandbox.execute('echo hello', optionsWithSpecialChars);

      // Verify writeFileSync was called with escaped paths
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.sb'),
        expect.stringContaining('\\"'),
        expect.any(Object),
      );
    });

    it('spawns sandbox-exec with correct arguments', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      (existsSync as jest.Mock).mockReturnValue(true);
      (writeFileSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });
      (unlinkSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });

      const mockChild = {
        on: jest.fn((event: string, callback: (arg?: number | Error) => void) => {
          if (event === 'close') {
            process.nextTick(() => {
              callback(0);
            });
          }
          return mockChild;
        }),
      };
      (spawn as jest.Mock).mockReturnValue(mockChild);

      const sandbox = new SeatbeltSandbox();
      await sandbox.execute('echo test', mockOptions);

      expect(spawn).toHaveBeenCalledWith(
        '/usr/bin/sandbox-exec',
        expect.arrayContaining([
          '-f',
          expect.stringContaining('.sb'),
          '/bin/sh',
          '-c',
          'echo test',
        ]),
        expect.objectContaining({
          cwd: '/test/cwd',
          stdio: 'inherit',
          env: expect.objectContaining({
            HOME: '/Users/test',
            PATH: '/test/cwd/node_modules/.bin:/usr/bin',
          }),
        }),
      );
    });

    it('writes explicit deny rules into the generated profile', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      (existsSync as jest.Mock).mockReturnValue(true);
      (writeFileSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });
      (unlinkSync as jest.Mock).mockImplementation(() => {
        /* noop */
      });

      const mockChild = {
        on: jest.fn((event: string, callback: (arg?: number | Error) => void) => {
          if (event === 'close') {
            process.nextTick(() => {
              callback(0);
            });
          }
          return mockChild;
        }),
      };
      (spawn as jest.Mock).mockReturnValue(mockChild);

      const sandbox = new SeatbeltSandbox();
      await sandbox.execute('echo deny', {
        ...mockOptions,
        denyPaths: ['/test/repo/.env'],
      });

      expect(writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('(deny file-read* file-write* (literal "/test/repo/.env"))'),
        expect.any(Object),
      );
    });
  });
});
