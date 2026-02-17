import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { SandboxOptions } from '../../src/sandbox/types.js';

// Mock the dynamic imports
jest.unstable_mockModule('../../src/sandbox/linux.js', () => ({
  LandlockSandbox: jest.fn(),
}));

jest.unstable_mockModule('../../src/sandbox/macos.js', () => ({
  SeatbeltSandbox: jest.fn(),
}));

jest.unstable_mockModule('../../src/runbook/executor.js', () => ({
  executeCommand: jest.fn(),
}));

describe('Sandbox Index', () => {
  const originalPlatform = process.platform;
  let consoleWarnSpy: jest.SpiedFunction<typeof console.warn>;

  const mockSandboxOptions: SandboxOptions = {
    cwd: '/test/cwd',
    repoRoot: '/test/repo',
    readOnlyPaths: ['/test/read'],
    readWritePaths: ['/test/write'],
    denyPaths: ['/test/deny'],
    allowUnsandboxed: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset module cache for sandbox/index.js to get fresh imports
    jest.resetModules();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {
      /* noop */
    });
  });

  afterEach(() => {
    // Safety net: restore platform even if withPlatform helper isn't used
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    consoleWarnSpy.mockRestore();
  });

  describe('checkSandboxAvailability', () => {
    it('returns unavailable for unsupported platforms', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      const { checkSandboxAvailability } = await import('../../src/sandbox/index.js');
      const availability = await checkSandboxAvailability();

      expect(availability.available).toBe(false);
      expect(availability.mechanism).toBe('none');
      expect(availability.reason).toContain('not supported on platform');
    });
  });

  describe('isSandboxAvailable', () => {
    it('returns false when platform is unsupported', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      const { isSandboxAvailable } = await import('../../src/sandbox/index.js');
      const result = await isSandboxAvailable();

      expect(result).toBe(false);
    });
  });

  describe('executeWithSandbox', () => {
    it('returns policy denied when sandbox unavailable and allowUnsandboxed is false', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      const { executeWithSandbox } = await import('../../src/sandbox/index.js');
      const result = await executeWithSandbox('echo hello', {
        ...mockSandboxOptions,
        allowUnsandboxed: false,
      });

      expect(result.policyDenied).toBe(true);
      expect(result.exitCode).toBe(126);
      expect(result.sandboxed).toBe(false);
      expect(result.denialReason).toContain('unavailable');
    });

    it('falls back to unsandboxed execution when allowed', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      const executor = await import('../../src/runbook/executor.js');
      const mockFn = executor.executeCommand as unknown as jest.Mock<
        () => Promise<{ success: boolean; exitCode: number }>
      >;
      mockFn.mockResolvedValue({
        success: true,
        exitCode: 0,
      });

      const { executeWithSandbox } = await import('../../src/sandbox/index.js');
      const result = await executeWithSandbox('echo hello', {
        ...mockSandboxOptions,
        allowUnsandboxed: true,
      });

      expect(result.sandboxed).toBe(false);
      expect(result.success).toBe(true);
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('without sandbox'));
    });
  });
});
