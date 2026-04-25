import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from '../helpers/mock-error-helpers.js';

// Mock core dependencies using unstable_mockModule for ESM
jest.unstable_mockModule('@rundown-org/core', () => ({
  loadPolicy: jest.fn(),
  PolicyEvaluator: jest.fn(),
  PolicyPrompter: jest.fn(),
  DEFAULT_POLICY: { allow: [], deny: [] },
  ...mockErrorHelpers,
}));

// Dynamic imports are needed after mocking
const core = await import('@rundown-org/core');
const {
  initializePolicyContext,
  getPolicyContext,
  getPolicyEvaluator,
  getPolicyPrompter,
  isPolicyEnforced,
  resetPolicyContext,
  parsePolicyCliOptions,
  getSandboxOptions,
} = await import('../../src/services/policy-context.js');

describe('policy context service', () => {
  beforeEach(() => {
    resetPolicyContext();
    jest.clearAllMocks();
  });

  describe('parsePolicyCliOptions', () => {
    it('parses basic options', () => {
      const opts = {
        allowRun: 'cmd1,cmd2',
        allowRead: 'path1',
        allowAll: true,
        yes: true,
      };
      const parsed = parsePolicyCliOptions(opts);
      expect(parsed.allowRun).toEqual(['cmd1', 'cmd2']);
      expect(parsed.allowRead).toEqual(['path1']);
      expect(parsed.allowAll).toBe(true);
      expect(parsed.yes).toBe(true);
    });

    it('handles arrays for allow options', () => {
      const opts = {
        allowRun: ['cmd1', 'cmd2'],
      };
      const parsed = parsePolicyCliOptions(opts);
      expect(parsed.allowRun).toEqual(['cmd1', 'cmd2']);
    });

    it('handles undefined values', () => {
      const parsed = parsePolicyCliOptions({});
      expect(parsed.allowRun).toBeUndefined();
      expect(parsed.allowAll).toBe(false);
      expect(parsed.sandbox).toBeUndefined();
    });

    it('handles sandbox flags', () => {
      expect(parsePolicyCliOptions({ sandbox: true }).sandbox).toBe(true);
      expect(parsePolicyCliOptions({ sandbox: false }).sandbox).toBe(false);
    });

    it('parses trustJsPolicy flag', () => {
      expect(parsePolicyCliOptions({ trustJsPolicy: true }).trustJsPolicy).toBe(true);
      expect(parsePolicyCliOptions({ trustJsPolicy: false }).trustJsPolicy).toBe(false);
    });

    it('returns undefined for invalid types', () => {
      const opts = {
        allowRun: 123 as unknown,
      };
      const parsed = parsePolicyCliOptions(opts as any);
      expect(parsed.allowRun).toBeUndefined();
    });

    describe('helpers option', () => {
      it('parses a single path', () => {
        const parsed = parsePolicyCliOptions({ helpers: 'a.js' });
        expect(parsed.helpers).toEqual(['a.js']);
      });

      it('parses comma-separated paths', () => {
        const parsed = parsePolicyCliOptions({ helpers: 'a.js,b.js' });
        expect(parsed.helpers).toEqual(['a.js', 'b.js']);
      });

      it('trims whitespace around entries', () => {
        const parsed = parsePolicyCliOptions({ helpers: ' a.js , b.js ' });
        expect(parsed.helpers).toEqual(['a.js', 'b.js']);
      });

      it('filters empty entries from doubled commas', () => {
        const parsed = parsePolicyCliOptions({ helpers: 'a.js,,b.js' });
        expect(parsed.helpers).toEqual(['a.js', 'b.js']);
      });

      it('returns undefined when helpers is absent', () => {
        const parsed = parsePolicyCliOptions({});
        expect(parsed.helpers).toBeUndefined();
      });

      it('passes through a string array directly', () => {
        const parsed = parsePolicyCliOptions({ helpers: ['a.js', 'b.js'] });
        expect(parsed.helpers).toEqual(['a.js', 'b.js']);
      });
    });
  });

  describe('getPolicyContext', () => {
    it('creates default context if not initialized', () => {
      const context = getPolicyContext();
      expect(context.isDefault).toBe(true);
      expect(context.policy).toBeDefined();
    });

    it('returns same instance on subsequent calls', () => {
      const c1 = getPolicyContext();
      const c2 = getPolicyContext();
      expect(c1).toBe(c2);
    });
  });

  describe('initializePolicyContext', () => {
    it('initializes context with options', async () => {
      (core.loadPolicy as jest.Mock).mockResolvedValue({
        policy: { allow: [], deny: [] },
        filepath: '/path/to/policy.yml',
        isDefault: false,
        warnings: [],
      });

      const context = await initializePolicyContext({ allowAll: true });

      expect(core.loadPolicy).toHaveBeenCalled();
      expect(context.isDefault).toBe(false);
      expect(context.cliOptions.allowAll).toBe(true);
      expect(context.configPath).toBe('/path/to/policy.yml');
    });

    it('forwards trustJsPolicy to the loader', async () => {
      (core.loadPolicy as jest.Mock).mockResolvedValue({
        policy: { allow: [], deny: [] },
        filepath: '/path/to/policy.cjs',
        isDefault: false,
        warnings: [],
      });

      await initializePolicyContext({ trustJsPolicy: true });

      expect(core.loadPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ trustJsPolicy: true }),
      );
    });

    it('logs warnings', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      (core.loadPolicy as jest.Mock).mockResolvedValue({
        policy: { allow: [], deny: [] },
        isDefault: true,
        warnings: ['Warning 1'],
      });

      await initializePolicyContext({});
      expect(consoleSpy).toHaveBeenCalledWith('Warning: Warning 1');
      consoleSpy.mockRestore();
    });
  });

  describe('isPolicyEnforced', () => {
    it('returns true by default', () => {
      getPolicyContext(); // ensure init
      expect(isPolicyEnforced()).toBe(true);
    });

    it('returns false if allowAll is set', async () => {
      (core.loadPolicy as jest.Mock).mockResolvedValue({
        policy: { allow: [], deny: [] },
        warnings: [],
      });
      await initializePolicyContext({ allowAll: true });
      expect(isPolicyEnforced()).toBe(false);
    });
  });

  describe('getSandboxOptions', () => {
    it('returns defaults', () => {
      getPolicyContext();
      const opts = getSandboxOptions();
      expect(opts.sandbox).toBe(true);
      expect(opts.sandboxStrict).toBe(false);
    });

    it('returns true for sandbox when initialized with empty options', async () => {
      (core.loadPolicy as jest.Mock).mockResolvedValue({ policy: {} });
      await initializePolicyContext({}); // No flags
      const opts = getSandboxOptions();
      expect(opts.sandbox).toBe(true);
    });

    it('returns false for sandbox if noSandbox is true', async () => {
      (core.loadPolicy as jest.Mock).mockResolvedValue({ policy: {} });
      await initializePolicyContext({ noSandbox: true });
      const opts = getSandboxOptions();
      expect(opts.sandbox).toBe(false);
    });

    it('returns false for sandbox if allowAll is true', async () => {
      (core.loadPolicy as jest.Mock).mockResolvedValue({ policy: {} });
      await initializePolicyContext({ allowAll: true });
      const opts = getSandboxOptions();
      expect(opts.sandbox).toBe(false);
    });

    it('respects sandboxStrict', async () => {
      (core.loadPolicy as jest.Mock).mockResolvedValue({ policy: {} });
      await initializePolicyContext({ sandboxStrict: true });
      const opts = getSandboxOptions();
      expect(opts.sandboxStrict).toBe(true);
    });
  });

  describe('accessors', () => {
    it('getPolicyEvaluator returns evaluator', () => {
      getPolicyContext();
      expect(getPolicyEvaluator()).toBeDefined();
    });

    it('getPolicyPrompter returns prompter', () => {
      getPolicyContext();
      expect(getPolicyPrompter()).toBeDefined();
    });
  });
});
