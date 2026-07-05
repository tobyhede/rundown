import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadPolicy,
  loadPolicySync,
  loadPolicyFromFile,
  loadPolicyFromFileSync,
  mergePolicies,
  PolicyConfigTrustRequiredError,
  writePolicyConfig,
} from '../../src/policy/loader.js';
import {
  DEFAULT_POLICY,
  DEFAULT_POLICY_LINUX,
  getDefaultPolicy,
  type PolicyConfig,
} from '../../src/policy/schema.js';

describe('Policy Loader - package.json', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundown-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const createPackageJson = (rundownConfig: object) => {
    const packageJson = {
      name: 'test-package',
      version: '1.0.0',
      rundown: rundownConfig,
    };
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));
  };

  describe('loadPolicy', () => {
    it('should load policy from package.json rundown field', async () => {
      createPackageJson({
        version: 1,
        default: { mode: 'deny' },
      });

      const result = await loadPolicy({ cwd: tempDir });

      expect(result.isDefault).toBe(false);
      expect(result.policy.default.mode).toBe('deny');
    });
  });

  describe('loadPolicySync', () => {
    it('should load policy from package.json rundown field', () => {
      createPackageJson({
        version: 1,
        default: { mode: 'deny' },
      });

      const result = loadPolicySync({ cwd: tempDir });

      expect(result.isDefault).toBe(false);
      expect(result.policy.default.mode).toBe('deny');
    });
  });

  describe('loadPolicyFromFile', () => {
    it('should load policy from package.json rundown field', async () => {
      createPackageJson({
        version: 1,
        default: { mode: 'deny' },
      });

      const result = await loadPolicyFromFile(path.join(tempDir, 'package.json'));

      expect(result.isDefault).toBe(false);
      expect(result.policy.default.mode).toBe('deny');
    });
  });

  describe('loadPolicyFromFileSync', () => {
    it('should load policy from package.json rundown field', () => {
      createPackageJson({
        version: 1,
        default: { mode: 'deny' },
      });

      const result = loadPolicyFromFileSync(path.join(tempDir, 'package.json'));

      expect(result.isDefault).toBe(false);
      expect(result.policy.default.mode).toBe('deny');
    });
  });
});

describe('Policy Loader - YAML files', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundown-yaml-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const writeYamlConfig = (filename: string, content: string) => {
    fs.writeFileSync(path.join(tempDir, filename), content);
  };

  describe('loadPolicy', () => {
    it('should load policy from .rundownrc.yaml', async () => {
      writeYamlConfig(
        '.rundownrc.yaml',
        `
version: 1
default:
  mode: deny
  run:
    allow:
      - git
      - npm
`,
      );

      const result = await loadPolicy({ cwd: tempDir });

      expect(result.isDefault).toBe(false);
      expect(result.policy.default.mode).toBe('deny');
      expect(result.policy.default.run.allow).toContain('git');
    });

    it('should load policy from .rundownrc.yml', async () => {
      writeYamlConfig(
        '.rundownrc.yml',
        `
version: 1
default:
  mode: prompted
`,
      );

      const result = await loadPolicy({ cwd: tempDir });

      expect(result.isDefault).toBe(false);
      expect(result.policy.default.mode).toBe('prompted');
    });

    it('should load policy from .rundownrc (no extension)', async () => {
      writeYamlConfig(
        '.rundownrc',
        `
version: 1
default:
  mode: execute
`,
      );

      const result = await loadPolicy({ cwd: tempDir });

      expect(result.isDefault).toBe(false);
      expect(result.policy.default.mode).toBe('execute');
    });
  });

  describe('loadPolicySync', () => {
    it('should load policy from .rundownrc.yaml', () => {
      writeYamlConfig(
        '.rundownrc.yaml',
        `
version: 1
default:
  mode: deny
`,
      );

      const result = loadPolicySync({ cwd: tempDir });

      expect(result.isDefault).toBe(false);
      expect(result.policy.default.mode).toBe('deny');
    });
  });

  describe('loadPolicyFromFile', () => {
    it('should load policy from YAML file by path', async () => {
      writeYamlConfig(
        'custom-policy.yaml',
        `
version: 1
default:
  mode: deny
`,
      );

      const result = await loadPolicyFromFile(path.join(tempDir, 'custom-policy.yaml'));

      expect(result.isDefault).toBe(false);
      expect(result.policy.default.mode).toBe('deny');
    });

    it('should load policy from YML file by path', async () => {
      writeYamlConfig(
        'custom-policy.yml',
        `
version: 1
default:
  mode: execute
`,
      );

      const result = await loadPolicyFromFile(path.join(tempDir, 'custom-policy.yml'));

      expect(result.isDefault).toBe(false);
      expect(result.policy.default.mode).toBe('execute');
    });
  });

  describe('loadPolicyFromFileSync', () => {
    it('should load policy from YAML file by path', () => {
      writeYamlConfig(
        'custom-policy.yaml',
        `
version: 1
default:
  mode: prompted
`,
      );

      const result = loadPolicyFromFileSync(path.join(tempDir, 'custom-policy.yaml'));

      expect(result.isDefault).toBe(false);
      expect(result.policy.default.mode).toBe('prompted');
    });
  });
});

describe('Policy Loader - JSON files', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundown-json-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load policy from .rundownrc.json', async () => {
    const config = {
      version: 1,
      default: { mode: 'deny' },
    };
    fs.writeFileSync(path.join(tempDir, '.rundownrc.json'), JSON.stringify(config, null, 2));

    const result = await loadPolicy({ cwd: tempDir });

    expect(result.isDefault).toBe(false);
    expect(result.policy.default.mode).toBe('deny');
  });

  it('should load policy from explicit JSON file path', async () => {
    const config = {
      version: 1,
      default: { mode: 'execute' },
    };
    fs.writeFileSync(path.join(tempDir, 'policy.json'), JSON.stringify(config, null, 2));

    const result = await loadPolicyFromFile(path.join(tempDir, 'policy.json'));

    expect(result.isDefault).toBe(false);
    expect(result.policy.default.mode).toBe('execute');
  });
});

describe('Policy Loader - JavaScript policy trust', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundown-js-policy-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('ignores rundown.config.js during auto-discovery', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'rundown.config.js'),
      `module.exports = { version: 1, default: { mode: 'deny' } };`,
    );

    const result = await loadPolicy({ cwd: tempDir });

    expect(result.isDefault).toBe(true);
    expect(result.filepath).toBeUndefined();
    expect(result.policy.default.mode).toBe(DEFAULT_POLICY.default.mode);
  });

  it('rejects explicit JS config without trust (async)', async () => {
    const configPath = path.join(tempDir, 'policy.cjs');
    fs.writeFileSync(configPath, `module.exports = { version: 1, default: { mode: 'deny' } };`);

    await expect(loadPolicyFromFile(configPath)).rejects.toBeInstanceOf(
      PolicyConfigTrustRequiredError,
    );
  });

  it('rejects explicit JS config without trust (sync)', () => {
    const configPath = path.join(tempDir, 'policy.cjs');
    fs.writeFileSync(configPath, `module.exports = { version: 1, default: { mode: 'deny' } };`);

    expect(() => loadPolicyFromFileSync(configPath)).toThrow(PolicyConfigTrustRequiredError);
  });

  it('loads explicit JS config when trust is enabled', async () => {
    const configPath = path.join(tempDir, 'policy.cjs');
    fs.writeFileSync(configPath, `module.exports = { version: 1, default: { mode: 'deny' } };`);

    const result = await loadPolicyFromFile(configPath, { trustJsPolicy: true });

    expect(result.isDefault).toBe(false);
    expect(result.policy.default.mode).toBe('deny');
  });

  it('loads explicit JS config synchronously when trust is enabled', () => {
    const configPath = path.join(tempDir, 'policy.cjs');
    fs.writeFileSync(configPath, `module.exports = { version: 1, default: { mode: 'deny' } };`);

    const result = loadPolicyFromFileSync(configPath, { trustJsPolicy: true });

    expect(result.isDefault).toBe(false);
    expect(result.policy.default.mode).toBe('deny');
  });
});

describe('Policy Loader - error paths', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundown-error-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('file not found', () => {
    it('should throw when file does not exist (async)', async () => {
      await expect(loadPolicyFromFile(path.join(tempDir, 'nonexistent.yaml'))).rejects.toThrow(
        'Policy config file not found',
      );
    });

    it('should throw when file does not exist (sync)', () => {
      expect(() => loadPolicyFromFileSync(path.join(tempDir, 'nonexistent.yaml'))).toThrow(
        'Policy config file not found',
      );
    });
  });

  describe('missing rundown field in package.json', () => {
    it('should throw when package.json has no rundown field (async)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test', version: '1.0.0' }),
      );

      await expect(loadPolicyFromFile(path.join(tempDir, 'package.json'))).rejects.toThrow(
        'No "rundown" field found in package.json',
      );
    });

    it('should throw when package.json has no rundown field (sync)', () => {
      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test', version: '1.0.0' }),
      );

      expect(() => loadPolicyFromFileSync(path.join(tempDir, 'package.json'))).toThrow(
        'No "rundown" field found in package.json',
      );
    });
  });

  describe('invalid config', () => {
    it('should throw on invalid discovered config even when useDefaults is true', async () => {
      fs.writeFileSync(
        path.join(tempDir, '.rundownrc.yaml'),
        'version: 1\ndefault:\n  mode: invalid-mode',
      );

      await expect(loadPolicy({ cwd: tempDir, useDefaults: true })).rejects.toThrow(
        'Invalid policy configuration',
      );
    });

    it('should throw on invalid config when useDefaults is false', async () => {
      fs.writeFileSync(
        path.join(tempDir, '.rundownrc.yaml'),
        'version: 1\ndefault:\n  mode: invalid-mode',
      );

      await expect(loadPolicy({ cwd: tempDir, useDefaults: false })).rejects.toThrow();
    });

    it('should throw on invalid discovered config (sync)', () => {
      fs.writeFileSync(
        path.join(tempDir, '.rundownrc.yaml'),
        'version: 1\ndefault:\n  mode: invalid-mode',
      );

      expect(() => loadPolicySync({ cwd: tempDir, useDefaults: true })).toThrow(
        'Invalid policy configuration',
      );
    });

    it('should throw on malformed discovered config instead of using defaults', async () => {
      fs.writeFileSync(path.join(tempDir, '.rundownrc.yaml'), 'version: 1\ndefault:\n  mode: [');

      await expect(loadPolicy({ cwd: tempDir, useDefaults: true })).rejects.toThrow(
        'Error loading policy config',
      );
    });
  });

  describe('unsupported extension', () => {
    it('should throw on unsupported file extension (async)', async () => {
      fs.writeFileSync(path.join(tempDir, 'policy.txt'), 'version: 1');

      await expect(loadPolicyFromFile(path.join(tempDir, 'policy.txt'))).rejects.toThrow(
        'Unsupported config file extension',
      );
    });

    it('should throw on unsupported file extension (sync)', () => {
      fs.writeFileSync(path.join(tempDir, 'policy.txt'), 'version: 1');

      expect(() => loadPolicyFromFileSync(path.join(tempDir, 'policy.txt'))).toThrow(
        'Unsupported config file extension',
      );
    });
  });

  describe('no config found', () => {
    it('should use defaults when no config found and useDefaults is true', async () => {
      const result = await loadPolicy({ cwd: tempDir, useDefaults: true });

      expect(result.isDefault).toBe(true);
      // Fallback materializes the platform-appropriate built-in default.
      expect(result.policy).toEqual(getDefaultPolicy());
    });

    it('should throw when no config found and useDefaults is false', async () => {
      await expect(loadPolicy({ cwd: tempDir, useDefaults: false })).rejects.toThrow(
        'No policy configuration found',
      );
    });

    it('should use defaults when no config found (sync)', () => {
      const result = loadPolicySync({ cwd: tempDir, useDefaults: true });

      expect(result.isDefault).toBe(true);
    });

    it('should throw when no config found (sync) and useDefaults is false', () => {
      expect(() => loadPolicySync({ cwd: tempDir, useDefaults: false })).toThrow(
        'No policy configuration found',
      );
    });

    describe('platform-specific built-in default', () => {
      const originalPlatform = process.platform;

      const setPlatform = (value: NodeJS.Platform): void => {
        Object.defineProperty(process, 'platform', { value, configurable: true });
      };

      afterEach(() => {
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
      });

      it('falls back to the allow-list-only Linux default on linux', async () => {
        setPlatform('linux');
        const result = await loadPolicy({ cwd: tempDir, useDefaults: true });

        expect(result.isDefault).toBe(true);
        expect(result.policy).toEqual(DEFAULT_POLICY_LINUX);
        expect(result.policy.default.read.deny).toEqual([]);
        expect(result.policy.default.write.deny).toEqual([]);
      });

      it('falls back to the canonical default (with file denies) on darwin', async () => {
        setPlatform('darwin');
        const result = await loadPolicy({ cwd: tempDir, useDefaults: true });

        expect(result.isDefault).toBe(true);
        expect(result.policy).toEqual(DEFAULT_POLICY);
        expect(result.policy.default.read.deny.length).toBeGreaterThan(0);
      });
    });
  });

  describe('explicit configPath option', () => {
    it('should load from explicit configPath (async)', async () => {
      fs.writeFileSync(path.join(tempDir, 'explicit.yaml'), 'version: 1\ndefault:\n  mode: deny');

      const result = await loadPolicy({
        configPath: path.join(tempDir, 'explicit.yaml'),
      });

      expect(result.isDefault).toBe(false);
      expect(result.policy.default.mode).toBe('deny');
    });

    it('should load from explicit configPath (sync)', () => {
      fs.writeFileSync(
        path.join(tempDir, 'explicit.yaml'),
        'version: 1\ndefault:\n  mode: execute',
      );

      const result = loadPolicySync({
        configPath: path.join(tempDir, 'explicit.yaml'),
      });

      expect(result.isDefault).toBe(false);
      expect(result.policy.default.mode).toBe('execute');
    });
  });
});

describe('Policy Loader - merge', () => {
  it('should return the platform default policy when no policies provided', () => {
    const result = mergePolicies();
    expect(result).toEqual(getDefaultPolicy());
  });

  it('should return the policy when single policy provided', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: { ...DEFAULT_POLICY.default, mode: 'deny' },
    };
    const result = mergePolicies(policy);
    expect(result).toEqual(policy);
  });

  it('should concatenate allow lists', () => {
    const policy1: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        run: { allow: ['git'], deny: [] },
      },
    };
    const policy2: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        run: { allow: ['npm'], deny: [] },
      },
    };

    const result = mergePolicies(policy1, policy2);

    expect(result.default.run.allow).toContain('git');
    expect(result.default.run.allow).toContain('npm');
  });

  it('should concatenate deny lists', () => {
    const policy1: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        run: { allow: [], deny: ['rm'] },
      },
    };
    const policy2: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        run: { allow: [], deny: ['sudo'] },
      },
    };

    const result = mergePolicies(policy1, policy2);

    expect(result.default.run.deny).toContain('rm');
    expect(result.default.run.deny).toContain('sudo');
  });

  it('should use later policy mode', () => {
    const policy1: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: { ...DEFAULT_POLICY.default, mode: 'deny' },
    };
    const policy2: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: { ...DEFAULT_POLICY.default, mode: 'execute' },
    };

    const result = mergePolicies(policy1, policy2);

    expect(result.default.mode).toBe('execute');
  });

  it('should use later policy network posture', () => {
    const policy1: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: { ...DEFAULT_POLICY.default, mode: 'deny', network: 'allow' },
    };
    const policy2: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: { ...DEFAULT_POLICY.default, mode: 'execute', network: 'deny' },
    };

    const result = mergePolicies(policy1, policy2);

    expect(result.default.mode).toBe('execute');
    expect(result.default.network).toBe('deny');
  });

  it('should concatenate overrides', () => {
    const policy1: PolicyConfig = {
      ...DEFAULT_POLICY,
      overrides: [{ runbook: 'deploy/*.md', mode: 'execute' }],
    };
    const policy2: PolicyConfig = {
      ...DEFAULT_POLICY,
      overrides: [{ runbook: 'test/*.md', mode: 'deny' }],
    };

    const result = mergePolicies(policy1, policy2);

    expect(result.overrides).toHaveLength(2);
  });

  it('should concatenate grants', () => {
    const policy1: PolicyConfig = {
      ...DEFAULT_POLICY,
      grants: [{ type: 'run', pattern: 'git', scope: 'session', grantedAt: '' }],
    };
    const policy2: PolicyConfig = {
      ...DEFAULT_POLICY,
      grants: [{ type: 'run', pattern: 'npm', scope: 'session', grantedAt: '' }],
    };

    const result = mergePolicies(policy1, policy2);

    expect(result.grants).toHaveLength(2);
  });
});

describe('Policy Loader - writePolicyConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundown-write-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should write JSON config', async () => {
    const filepath = path.join(tempDir, 'policy.json');
    await writePolicyConfig(DEFAULT_POLICY, filepath);

    const content = fs.readFileSync(filepath, 'utf-8');
    const parsed = JSON.parse(content);

    expect(parsed.version).toBe(1);
  });

  it('should write YAML config for .yaml extension', async () => {
    const filepath = path.join(tempDir, 'policy.yaml');
    await writePolicyConfig(DEFAULT_POLICY, filepath);

    const content = fs.readFileSync(filepath, 'utf-8');
    expect(content).toContain('version:');
  });

  it('should write YAML config for .yml extension', async () => {
    const filepath = path.join(tempDir, 'policy.yml');
    await writePolicyConfig(DEFAULT_POLICY, filepath);

    const content = fs.readFileSync(filepath, 'utf-8');
    expect(content).toContain('version:');
  });

  it('should default to YAML for unknown extension', async () => {
    const filepath = path.join(tempDir, 'policy');
    await writePolicyConfig(DEFAULT_POLICY, filepath);

    const content = fs.readFileSync(filepath, 'utf-8');
    expect(content).toContain('version:');
  });
});
