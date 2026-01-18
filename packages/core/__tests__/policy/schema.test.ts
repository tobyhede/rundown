import {
  parsePolicy,
  safeParsePolicyConfig,
  DEFAULT_POLICY,
} from '../../src/policy/schema.js';

describe('Policy Schema', () => {
  describe('parsePolicy', () => {
    it('should parse valid minimal config', () => {
      const config = { version: 1 };
      const result = parsePolicy(config);

      expect(result.version).toBe(1);
      expect(result.default.mode).toBe('prompted'); // default
      expect(result.overrides).toEqual([]);
      expect(result.grants).toEqual([]);
    });

    it('should parse config with default mode', () => {
      const config = {
        version: 1,
        default: {
          mode: 'execute',
        },
      };
      const result = parsePolicy(config);

      expect(result.default.mode).toBe('execute');
    });

    it('should parse config with run allow list', () => {
      const config = {
        version: 1,
        default: {
          run: {
            allow: ['git', 'npm', 'node'],
            deny: ['sudo'],
          },
        },
      };
      const result = parsePolicy(config);

      expect(result.default.run.allow).toEqual(['git', 'npm', 'node']);
      expect(result.default.run.deny).toEqual(['sudo']);
    });

    it('should parse config with overrides', () => {
      const config = {
        version: 1,
        overrides: [
          {
            runbook: 'deploy/*.runbook.md',
            mode: 'execute',
            run: {
              allow: ['curl', 'kubectl'],
            },
          },
        ],
      };
      const result = parsePolicy(config);

      expect(result.overrides).toHaveLength(1);
      expect(result.overrides[0].runbook).toBe('deploy/*.runbook.md');
      expect(result.overrides[0].mode).toBe('execute');
      expect(result.overrides[0].run?.allow).toEqual(['curl', 'kubectl']);
    });

    it('should parse config with grants', () => {
      const config = {
        version: 1,
        grants: [
          {
            type: 'run',
            pattern: 'docker',
            scope: 'permanent',
          },
        ],
      };
      const result = parsePolicy(config);

      expect(result.grants).toHaveLength(1);
      expect(result.grants[0].type).toBe('run');
      expect(result.grants[0].pattern).toBe('docker');
      expect(result.grants[0].scope).toBe('permanent');
    });

    it('should throw on invalid mode', () => {
      const config = {
        version: 1,
        default: {
          mode: 'invalid',
        },
      };

      expect(() => parsePolicy(config)).toThrow();
    });

    it('should throw on invalid permission type in grants', () => {
      const config = {
        version: 1,
        grants: [
          {
            type: 'invalid',
            pattern: 'test',
          },
        ],
      };

      expect(() => parsePolicy(config)).toThrow();
    });
  });

  describe('safeParsePolicyConfig', () => {
    it('should return success for valid config', () => {
      const config = { version: 1 };
      const result = safeParsePolicyConfig(config);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.errors).toBeUndefined();
    });

    it('should return errors for invalid config', () => {
      const config = {
        version: 1,
        default: {
          mode: 'invalid',
        },
      };
      const result = safeParsePolicyConfig(config);

      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });
  });

  describe('DEFAULT_POLICY', () => {
    it('should have version 1', () => {
      expect(DEFAULT_POLICY.version).toBe(1);
    });

    it('should default to prompted mode', () => {
      expect(DEFAULT_POLICY.default.mode).toBe('prompted');
    });

    it('should include common safe commands in allow list', () => {
      const allowedCommands = DEFAULT_POLICY.default.run.allow;
      expect(allowedCommands).toContain('git');
      expect(allowedCommands).toContain('npm');
      expect(allowedCommands).toContain('node');
    });

    it('should include dangerous commands in deny list', () => {
      const deniedCommands = DEFAULT_POLICY.default.run.deny;
      expect(deniedCommands).toContain('sudo');
      expect(deniedCommands).toContain('rm');
      expect(deniedCommands).toContain('curl');
    });

    it('should allow reading from repo and tmp', () => {
      const allowedPaths = DEFAULT_POLICY.default.read.allow;
      expect(allowedPaths).toContain('{repo}/**');
      expect(allowedPaths).toContain('{tmp}/**');
    });

    it('should deny reading secrets', () => {
      const deniedPaths = DEFAULT_POLICY.default.read.deny;
      expect(deniedPaths).toContain('**/.env');
      expect(deniedPaths).toContain('**/*secret*');
    });

    it('should filter sensitive env vars', () => {
      const deniedEnv = DEFAULT_POLICY.default.env.deny;
      expect(deniedEnv).toContain('*_TOKEN');
      expect(deniedEnv).toContain('AWS_*');
    });
  });
});
