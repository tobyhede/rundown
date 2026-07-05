import {
  parsePolicy,
  safeParsePolicyConfig,
  DEFAULT_POLICY,
  DEFAULT_POLICY_LINUX,
  getDefaultPolicy,
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

    it('defaults omitted network policy to deny', () => {
      const result = parsePolicy({ version: 1 });

      expect(result.default.network).toBe('deny');
    });

    it('parses explicit default network allow', () => {
      const result = parsePolicy({
        version: 1,
        default: {
          network: 'allow',
        },
      });

      expect(result.default.network).toBe('allow');
    });

    it('parses runbook network override', () => {
      const result = parsePolicy({
        version: 1,
        overrides: [
          {
            runbook: 'deploy/*.runbook.md',
            network: 'allow',
          },
        ],
      });

      expect(result.overrides[0].network).toBe('allow');
    });

    it('rejects invalid network policy values', () => {
      expect(() =>
        parsePolicy({
          version: 1,
          default: {
            network: 'prompt',
          },
        }),
      ).toThrow();
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
      expect(result.errors?.length).toBeGreaterThan(0);
    });
  });

  describe('DEFAULT_POLICY', () => {
    it('should have version 1', () => {
      expect(DEFAULT_POLICY.version).toBe(1);
    });

    it('should default to prompted mode', () => {
      expect(DEFAULT_POLICY.default.mode).toBe('prompted');
    });

    it('denies network by default', () => {
      expect(DEFAULT_POLICY.default.network).toBe('deny');
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

    it('should restrict write access to generated .rundown subpaths only', () => {
      const allowedWrites = DEFAULT_POLICY.default.write.allow;
      // Broad .rundown/** must NOT be present (would allow rewriting config.yaml)
      expect(allowedWrites).not.toContain('{repo}/.rundown/**');
      // Generated subpaths should be present
      expect(allowedWrites).toContain('{repo}/.rundown/runs/**');
      expect(allowedWrites).toContain('{repo}/.rundown/locks/**');
      expect(allowedWrites).toContain('{repo}/.rundown/session.json');
      expect(allowedWrites).toContain('{repo}/.rundown/work/**');
      // runbooks/ contains user-authored sources, not generated state — must NOT be writable by default
      expect(allowedWrites).not.toContain('{repo}/.rundown/runbooks/**');
    });

    it('does not grant write to build-output directories by default', () => {
      // Build dirs are unused by Rundown-managed runbooks and, on Linux (allow-
      // list only), would be unguarded blast radius. Build-writing runbooks must
      // opt in via --allow-write. .claude/** is retained for the plugin's session
      // state, and {tmp}/** is retained for scratch space.
      const allowedWrites = DEFAULT_POLICY.default.write.allow;
      expect(allowedWrites).not.toContain('{repo}/node_modules/**');
      expect(allowedWrites).not.toContain('{repo}/dist/**');
      expect(allowedWrites).not.toContain('{repo}/build/**');
      expect(allowedWrites).not.toContain('{repo}/.next/**');
      expect(allowedWrites).toContain('{repo}/.claude/**');
      expect(allowedWrites).toContain('{tmp}/**');
    });
  });

  describe('DEFAULT_POLICY_LINUX', () => {
    it('clears the read and write deny lists (allow-list only)', () => {
      expect(DEFAULT_POLICY_LINUX.default.read.deny).toEqual([]);
      expect(DEFAULT_POLICY_LINUX.default.write.deny).toEqual([]);
    });

    it('preserves the canonical allow lists verbatim', () => {
      expect(DEFAULT_POLICY_LINUX.default.read.allow).toEqual(DEFAULT_POLICY.default.read.allow);
      expect(DEFAULT_POLICY_LINUX.default.write.allow).toEqual(DEFAULT_POLICY.default.write.allow);
      expect(DEFAULT_POLICY_LINUX.default.run.allow).toEqual(DEFAULT_POLICY.default.run.allow);
      expect(DEFAULT_POLICY_LINUX.default.env.allow).toEqual(DEFAULT_POLICY.default.env.allow);
    });

    it('keeps the run and env deny lists (evaluator-enforced, work under Landlock)', () => {
      expect(DEFAULT_POLICY_LINUX.default.run.deny).toEqual(DEFAULT_POLICY.default.run.deny);
      expect(DEFAULT_POLICY_LINUX.default.env.deny).toEqual(DEFAULT_POLICY.default.env.deny);
    });

    it('preserves version, mode, overrides, and grants', () => {
      expect(DEFAULT_POLICY_LINUX.version).toBe(DEFAULT_POLICY.version);
      expect(DEFAULT_POLICY_LINUX.default.mode).toBe(DEFAULT_POLICY.default.mode);
      expect(DEFAULT_POLICY_LINUX.overrides).toEqual(DEFAULT_POLICY.overrides);
      expect(DEFAULT_POLICY_LINUX.grants).toEqual(DEFAULT_POLICY.grants);
    });

    it('preserves the canonical network default', () => {
      expect(DEFAULT_POLICY_LINUX.default.network).toBe(DEFAULT_POLICY.default.network);
    });

    it('preserves the canonical policy mode on Linux', () => {
      expect(DEFAULT_POLICY_LINUX.default.mode).toBe(DEFAULT_POLICY.default.mode);
    });

    it('does not share mutable nested references with DEFAULT_POLICY', () => {
      // Verify independence by reference identity rather than mutating the
      // shared exported singletons: fresh nested arrays/objects mean a later
      // mutation of one default can never leak into the other.
      expect(DEFAULT_POLICY_LINUX.default).not.toBe(DEFAULT_POLICY.default);
      expect(DEFAULT_POLICY_LINUX.default.read.allow).not.toBe(DEFAULT_POLICY.default.read.allow);
      expect(DEFAULT_POLICY_LINUX.default.write.allow).not.toBe(DEFAULT_POLICY.default.write.allow);
      expect(DEFAULT_POLICY_LINUX.default.run.deny).not.toBe(DEFAULT_POLICY.default.run.deny);
      expect(DEFAULT_POLICY_LINUX.default.env.deny).not.toBe(DEFAULT_POLICY.default.env.deny);
    });
  });

  describe('getDefaultPolicy', () => {
    it('returns the allow-list-only Linux default on linux', () => {
      expect(getDefaultPolicy('linux')).toBe(DEFAULT_POLICY_LINUX);
    });

    it('returns the canonical default on macOS (Seatbelt enforces file denies)', () => {
      expect(getDefaultPolicy('darwin')).toBe(DEFAULT_POLICY);
    });

    it('returns the canonical default on other platforms (no sandbox)', () => {
      expect(getDefaultPolicy('win32')).toBe(DEFAULT_POLICY);
    });
  });
});
