import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { SandboxOptions } from '../../src/sandbox/types.js';

// Mock child_process — both spawnSync (wrapper lookup + functional probe) and
// spawn (execution) are exercised by LandlockSandbox.
const actualChildProcess = await import('node:child_process');
jest.unstable_mockModule('node:child_process', () => ({
  ...actualChildProcess,
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));

// Mock fs — existsSync backs the system-path existence filter; the temp-file
// helpers back the probe's enforcement control.
const actualFs = await import('node:fs');
jest.unstable_mockModule('node:fs', () => ({
  ...actualFs,
  existsSync: jest.fn(),
  mkdtempSync: jest.fn(() => '/tmp/rundown-landlock-probe-test'),
  writeFileSync: jest.fn(),
  rmSync: jest.fn(),
}));

// Import after mocking.
const { LandlockSandbox } = await import('../../src/sandbox/linux.js');
const { spawnSync, spawn } = await import('node:child_process');
const { existsSync } = await import('node:fs');

const WRAPPER_PATH = '/usr/local/bin/landrun';

const mockSandboxOptions: SandboxOptions = {
  cwd: '/test/cwd',
  repoRoot: '/test/repo',
  readOnlyPaths: ['/test/read'],
  readWritePaths: ['/test/write'],
  denyPaths: [],
  denyPatterns: [],
  env: {},
  allowUnsandboxed: false,
};

/**
 * Configure the spawnSync mock to distinguish the three call sites:
 *   - `which`               → wrapper discovery
 *   - args include /bin/true → probe positive control (wrapper runs)
 *   - args include /bin/cat  → probe enforcement control (denied read)
 */
function configureSpawnSync(opts: {
  wrapperFound: boolean;
  positiveStatus?: number;
  // Exit status of the deliberately-denied read. Non-zero => enforcement
  // observed (available); 0 => best-effort ran unsandboxed (unavailable).
  deniedStatus?: number;
}): void {
  (spawnSync as jest.Mock).mockImplementation((command: unknown, argv: unknown) => {
    if (command === 'which') {
      return opts.wrapperFound
        ? { status: 0, stdout: `${WRAPPER_PATH}\n` }
        : { status: 1, stdout: '' };
    }
    const args = (argv as string[] | undefined) ?? [];
    if (args.includes('/bin/cat')) {
      return { status: opts.deniedStatus ?? 1, error: undefined };
    }
    // /bin/true positive control
    return { status: opts.positiveStatus ?? 0, error: undefined };
  });
}

describe('LandlockSandbox', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    // Default: all system paths present.
    (existsSync as jest.Mock).mockReturnValue(true);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  describe('getAvailability', () => {
    it('returns unavailable on non-linux platform', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      const availability = await new LandlockSandbox().getAvailability();

      expect(availability.available).toBe(false);
      expect(availability.mechanism).toBe('none');
      expect(availability.reason).toContain('only available on Linux');
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it('reports available only when the enforcement probe observes enforcement', async () => {
      // Probe runs unconditionally; positive control passes and the
      // deliberately-denied read is blocked (non-zero).
      configureSpawnSync({ wrapperFound: true, positiveStatus: 0, deniedStatus: 1 });

      const availability = await new LandlockSandbox().getAvailability();

      expect(availability.available).toBe(true);
      expect(availability.mechanism).toBe('landlock');
      expect(availability.supportsReadRestrictions).toBe(true);
      expect(availability.supportsWriteRestrictions).toBe(true);
      expect(availability.supportsDenyPaths).toBe(false);
      // Positive control grants exec paths with --rox and runs /bin/true.
      expect(spawnSync).toHaveBeenCalledWith(
        WRAPPER_PATH,
        expect.arrayContaining(['--best-effort', '--rox', '/usr', '--', '/bin/true']),
        expect.objectContaining({ stdio: 'ignore', timeout: 5000, killSignal: 'SIGKILL' }),
      );
      // Enforcement control attempts a read of the ungranted probe file.
      expect(spawnSync).toHaveBeenCalledWith(
        WRAPPER_PATH,
        expect.arrayContaining(['--best-effort', '--', '/bin/cat']),
        expect.anything(),
      );
    });

    it('reports unavailable when the wrapper runs but enforcement is NOT observed', async () => {
      // Regression guard: this is the securityfs-says-landlock-but-syscall-
      // blocked case (e.g. container seccomp). The wrapper runs (positive
      // control exits 0) but --best-effort fell back to unsandboxed, so the
      // deliberately-denied read SUCCEEDS (0). We must NOT report available —
      // otherwise execution would run unsandboxed while claiming sandboxed:true.
      configureSpawnSync({ wrapperFound: true, positiveStatus: 0, deniedStatus: 0 });

      const availability = await new LandlockSandbox().getAvailability();

      expect(availability.available).toBe(false);
      expect(availability.mechanism).toBe('none');
      expect(availability.reason).toContain('enforcement probe');
    });

    it('reports unavailable when the probe positive control fails to run', async () => {
      configureSpawnSync({ wrapperFound: true, positiveStatus: 1 });

      const availability = await new LandlockSandbox().getAvailability();

      expect(availability.available).toBe(false);
      // Enforcement control is never attempted once the positive control fails.
      expect(spawnSync).not.toHaveBeenCalledWith(
        WRAPPER_PATH,
        expect.arrayContaining(['/bin/cat']),
        expect.anything(),
      );
    });

    it('filters non-existent system paths (e.g. /lib64 on arm64) from grants', async () => {
      (existsSync as jest.Mock).mockImplementation((p: unknown) => p !== '/lib64');
      configureSpawnSync({ wrapperFound: true, positiveStatus: 0, deniedStatus: 1 });

      await new LandlockSandbox().getAvailability();

      const trueCall = (spawnSync as jest.Mock).mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('/bin/true'),
      );
      expect(trueCall).toBeDefined();
      expect(trueCall?.[1] as string[]).not.toContain('/lib64');
      expect(trueCall?.[1] as string[]).toContain('/usr');
    });

    it('reports unavailable and skips the kernel check when no wrapper is found', async () => {
      configureSpawnSync({ wrapperFound: false });

      const availability = await new LandlockSandbox().getAvailability();

      expect(availability.available).toBe(false);
      expect(availability.reason).toContain('No Landlock wrapper found');
      // The probe runs after wrapper discovery, so the system-path existence
      // filter (existsSync) is never reached.
      expect(existsSync).not.toHaveBeenCalled();
    });

    it('memoizes availability across calls', async () => {
      configureSpawnSync({ wrapperFound: true, positiveStatus: 0, deniedStatus: 1 });

      const sandbox = new LandlockSandbox();
      await sandbox.getAvailability();
      const callsAfterFirst = (spawnSync as jest.Mock).mock.calls.length;
      await sandbox.getAvailability();

      expect((spawnSync as jest.Mock).mock.calls.length).toBe(callsAfterFirst);
    });
  });

  describe('execute', () => {
    it('blocks deny-path policy that the Linux backend cannot enforce', async () => {
      const result = await new LandlockSandbox().execute('echo hi', {
        ...mockSandboxOptions,
        denyPaths: ['/secret'],
      });

      expect(result.exitCode).toBe(126);
      expect(result.policyDenied).toBe(true);
      expect(result.sandboxed).toBe(false);
      expect(result.success).toBe(false);
    });

    it('invokes landrun with --best-effort and --rox system grants', async () => {
      configureSpawnSync({ wrapperFound: true, positiveStatus: 0, deniedStatus: 1 });
      const fakeChild = {
        on: (event: string, cb: (arg: number) => void) => {
          if (event === 'close') cb(0);
        },
      };
      (spawn as jest.Mock).mockReturnValue(fakeChild);

      const result = await new LandlockSandbox().execute('echo hi', {
        ...mockSandboxOptions,
        denyPaths: [],
      });

      expect(result.sandboxed).toBe(true);
      expect(result.exitCode).toBe(0);
      const [, argv] = (spawn as jest.Mock).mock.calls[0] as [string, string[]];
      expect(argv[0]).toBe('--best-effort');
      expect(argv).toContain('--rox');
      expect(argv).toContain('--rw');
      expect(argv.slice(-3)).toEqual(['/bin/sh', '-c', 'echo hi']);
    });

    it('honors a cached unavailable result and does not run the wrapper', async () => {
      // Regression for the wrapperPath-as-gate bug: the wrapper is found (so
      // wrapperPath is set) but the enforcement probe fails (unavailable). A
      // later execute() on the same instance must NOT run landrun.
      configureSpawnSync({ wrapperFound: true, positiveStatus: 0, deniedStatus: 0 });
      const sandbox = new LandlockSandbox();

      const availability = await sandbox.getAvailability();
      expect(availability.available).toBe(false);

      const result = await sandbox.execute('echo hi', { ...mockSandboxOptions, denyPaths: [] });

      expect(result.exitCode).toBe(126);
      expect(result.policyDenied).toBe(true);
      expect(result.sandboxed).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    });
  });
});
