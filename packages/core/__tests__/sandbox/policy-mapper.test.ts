import { describe, it, expect, jest } from '@jest/globals';
import { join, dirname, basename, resolve } from 'node:path';
import { mkdtemp, rm, writeFile, mkdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { realpathSync, type Stats } from 'node:fs';
import {
  policyToSandboxOptions,
  policyConfigToSandboxOptions,
} from '../../src/sandbox/policy-mapper.js';
import { PolicyEvaluator } from '../../src/policy/evaluator.js';
import {
  DEFAULT_POLICY,
  DEFAULT_POLICY_LINUX,
  type PolicyConfig,
} from '../../src/policy/schema.js';

function canonicalPathForTest(value: string): string {
  const absolute = resolve(value);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) {
      return absolute;
    }
    return join(canonicalPathForTest(parent), basename(absolute));
  }
}

describe('policyToSandboxOptions', () => {
  it('returns minimal options for default policy', () => {
    const evaluator = new PolicyEvaluator(DEFAULT_POLICY);
    const options = policyToSandboxOptions(evaluator, {
      cwd: '/test/cwd',
    });

    expect(options.cwd).toBe('/test/cwd');
    expect(options.repoRoot).toBe('/test/cwd');
    expect(options.readOnlyPaths).toBeDefined();
    expect(options.readWritePaths).toBeDefined();
    expect(options.denyPatterns).toBeDefined();
    expect(options.denyPaths).toBeDefined();
    expect(options.env).toEqual({});
  });

  it('uses provided repoRoot and tmpDir', () => {
    const evaluator = new PolicyEvaluator(DEFAULT_POLICY);
    const options = policyToSandboxOptions(evaluator, {
      cwd: '/test/cwd',
      repoRoot: '/custom/repo',
      tmpDir: '/custom/tmp',
    });

    expect(options.repoRoot).toBe('/custom/repo');
  });

  it('maps read.allow paths to readOnlyPaths', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: {
          allow: ['/allowed/read/**'],
          deny: [],
        },
        write: {
          allow: [],
          deny: [],
        },
      },
    };
    const evaluator = new PolicyEvaluator(policy);

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/test',
    });

    expect(options.readOnlyPaths).toContain('/allowed/read');
  });

  it('maps write.allow paths to readWritePaths', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: {
          allow: [],
          deny: [],
        },
        write: {
          allow: ['/allowed/write/**'],
          deny: [],
        },
      },
    };
    const evaluator = new PolicyEvaluator(policy);

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/test',
    });

    expect(options.readWritePaths).toContain('/allowed/write');
  });

  it('excludes write paths from readOnlyPaths', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: {
          allow: ['/shared/**'],
          deny: [],
        },
        write: {
          allow: ['/shared/**'],
          deny: [],
        },
      },
    };
    const evaluator = new PolicyEvaluator(policy);

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/test',
    });

    // Shared paths should be in readWritePaths, not readOnlyPaths
    expect(options.readWritePaths).toContain('/shared');
    expect(options.readOnlyPaths).not.toContain('/shared');
  });

  it('combines deny paths from read.deny and write.deny', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: {
          allow: [],
          deny: ['/denied/read/**'],
        },
        write: {
          allow: [],
          deny: ['/denied/write/**'],
        },
      },
    };
    const evaluator = new PolicyEvaluator(policy);

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/test',
    });

    expect(options.denyPaths).toContain('/denied/read');
    expect(options.denyPaths).toContain('/denied/write');
  });

  it('yields non-empty denyPatterns for the canonical default (would fail closed under Landlock)', () => {
    // The canonical default carries secret-file deny globs; these are what the
    // Linux backend cannot enforce, so it fails closed when they are present.
    const evaluator = new PolicyEvaluator(DEFAULT_POLICY);
    const options = policyToSandboxOptions(evaluator, { cwd: '/test' });
    expect(options.denyPatterns.length).toBeGreaterThan(0);
  });

  it('yields empty denyPatterns for the Linux default (Landlock can enforce it)', () => {
    // Option 4: the Linux default is allow-list only, so the mapper produces no
    // deny patterns and the Landlock backend will not hit its fail-closed guard.
    const evaluator = new PolicyEvaluator(DEFAULT_POLICY_LINUX);
    const options = policyToSandboxOptions(evaluator, { cwd: '/test' });
    expect(options.denyPatterns).toEqual([]);
    expect(options.denyPaths).toEqual([]);
  });

  it('resolves {repo} placeholder', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: {
          allow: ['{repo}/src/**'],
          deny: [],
        },
        write: {
          allow: [],
          deny: [],
        },
      },
    };
    const evaluator = new PolicyEvaluator(policy);

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/test',
      repoRoot: '/my/repo',
    });

    expect(options.readOnlyPaths).toContain('/my/repo/src');
  });

  it('resolves {tmp} placeholder', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        write: {
          allow: ['{tmp}/cache/**'],
          deny: [],
        },
        read: {
          allow: [],
          deny: [],
        },
      },
    };
    const evaluator = new PolicyEvaluator(policy);

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/test',
      tmpDir: '/var/tmp',
    });

    expect(options.readWritePaths).toContain(canonicalPathForTest('/var/tmp/cache'));
  });

  it('passes through allowUnsandboxed option', () => {
    const evaluator = new PolicyEvaluator(DEFAULT_POLICY);
    const options = policyToSandboxOptions(evaluator, {
      cwd: '/test',
      allowUnsandboxed: true,
    });

    expect(options.allowUnsandboxed).toBe(true);
  });

  it('adds Rundown-owned write grants to readWritePaths', async () => {
    const repoRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-'));
    const capturePath = join(repoRoot, '.rundown', 'runs', 'run-1', 'outputs', '1', 'Token');
    try {
      await mkdir(dirname(capturePath), { recursive: true });
      await writeFile(capturePath, 'token');

      const policy: PolicyConfig = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
        },
      };
      const evaluator = new PolicyEvaluator(policy);

      const options = policyToSandboxOptions(evaluator, {
        cwd: repoRoot,
        repoRoot,
        extraReadWritePaths: [capturePath],
      });

      expect(options.readWritePaths).toContain(capturePath);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('excludes extra read-write paths from readOnlyPaths', async () => {
    const repoRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-'));
    try {
      const capturePath = join(repoRoot, '.rundown', 'runs', 'run-1', 'outputs', '1', 'Token');
      await mkdir(dirname(capturePath), { recursive: true });
      await writeFile(capturePath, 'token');

      const policy: PolicyConfig = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          read: {
            allow: [capturePath],
            deny: [],
          },
          write: {
            allow: [],
            deny: [],
          },
        },
      };
      const evaluator = new PolicyEvaluator(policy);

      const options = policyToSandboxOptions(evaluator, {
        cwd: repoRoot,
        repoRoot,
        extraReadWritePaths: [capturePath],
      });

      expect(options.readWritePaths).toContain(capturePath);
      expect(options.readOnlyPaths).not.toContain(capturePath);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('deduplicates paths', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: {
          allow: ['/path/**', '/path/**'],
          deny: ['/denied/**', '/denied/**'],
        },
        write: {
          allow: [],
          deny: [],
        },
      },
    };
    const evaluator = new PolicyEvaluator(policy);

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/test',
    });

    // Should not have duplicates
    const readOnlyUnique = [...new Set(options.readOnlyPaths)];
    expect(options.readOnlyPaths).toEqual(readOnlyUnique);
  });

  it('uses effective override rules for the active runbook', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: { allow: [], deny: [] },
        write: { allow: [], deny: [] },
      },
      overrides: [
        {
          runbook: 'deploy/*.runbook.md',
          read: {
            allow: ['{repo}/deploy-secrets/**'],
            deny: ['{repo}/deploy-secrets/.env'],
          },
        },
      ],
      grants: [],
    };
    const evaluator = new PolicyEvaluator(policy, {
      repoRoot: '/repo',
      runbookPath: 'deploy/prod.runbook.md',
    });

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/repo',
      repoRoot: '/repo',
    });

    expect(options.readOnlyPaths).toContain('/repo/deploy-secrets');
    expect(options.denyPatterns).toContain('/repo/deploy-secrets/.env');
  });

  it('includes matching grants in effective sandbox paths', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: { allow: [], deny: [] },
        write: { allow: [], deny: [] },
      },
      overrides: [],
      grants: [
        {
          type: 'read',
          pattern: '{repo}/granted/**',
          runbook: 'deploy/*.runbook.md',
          scope: 'permanent',
          grantedAt: '2026-03-03T00:00:00.000Z',
        },
      ],
    };
    const evaluator = new PolicyEvaluator(policy, {
      repoRoot: '/repo',
      runbookPath: 'deploy/prod.runbook.md',
    });

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/repo',
      repoRoot: '/repo',
    });

    expect(options.readOnlyPaths).toContain('/repo/granted');
  });

  it('includes CLI read grants in sandbox read-only paths', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: { allow: [], deny: [] },
        write: { allow: [], deny: [] },
      },
    };
    const evaluator = new PolicyEvaluator(policy, {
      repoRoot: '/repo',
      cliGrants: { read: ['/repo/schema.json'] },
    });

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/repo',
      repoRoot: '/repo',
    });

    expect(options.readOnlyPaths).toContain('/repo/schema.json');
    expect(options.readWritePaths).not.toContain('/repo/schema.json');
  });

  it('includes CLI write grants in sandbox read-write paths', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: { allow: [], deny: [] },
        write: { allow: [], deny: [] },
      },
    };
    const evaluator = new PolicyEvaluator(policy, {
      repoRoot: '/repo',
      cliGrants: { write: ['/repo/dist/**'] },
    });

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/repo',
      repoRoot: '/repo',
    });

    expect(options.readWritePaths).toContain('/repo/dist');
    expect(options.readOnlyPaths).not.toContain('/repo/dist');
  });

  it('maps allowAll to broad sandbox read and write grants', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: { allow: [], deny: ['/repo/.env'] },
        write: { allow: [], deny: ['/repo/dist/secret.txt'] },
      },
    };
    const evaluator = new PolicyEvaluator(policy, {
      repoRoot: '/repo',
      allowAll: true,
    });

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/repo',
      repoRoot: '/repo',
    });

    expect(options.readWritePaths).toContain('/');
    expect(options.readOnlyPaths).not.toContain('/');
    expect(options.denyPatterns).toEqual([]);
    expect(options.denyPaths).toEqual([]);
  });

  it('maps denyAll to empty sandbox grants', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: { allow: ['/repo/**'], deny: [] },
        write: { allow: ['/repo/dist/**'], deny: [] },
      },
    };
    const evaluator = new PolicyEvaluator(policy, {
      repoRoot: '/repo',
      denyAll: true,
    });

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/repo',
      repoRoot: '/repo',
    });

    expect(options.readOnlyPaths).toEqual([]);
    expect(options.readWritePaths).toEqual([]);
    expect(options.denyPatterns).toEqual(['/**']);
    expect(options.denyPaths).toEqual([]);
  });

  it('does not emit deny paths that are covered by a higher-precedence CLI read grant', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: { allow: [], deny: ['/repo/.env'] },
        write: { allow: [], deny: [] },
      },
    };
    const evaluator = new PolicyEvaluator(policy, {
      repoRoot: '/repo',
      cliGrants: { read: ['/repo/.env'] },
    });

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/repo',
      repoRoot: '/repo',
    });

    expect(options.readOnlyPaths).toContain('/repo/.env');
    expect(options.denyPaths).not.toContain('/repo/.env');
    expect(options.denyPatterns).not.toContain('/repo/.env');
  });

  it('does not emit deny paths that are covered by a higher-precedence session write grant', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: { allow: [], deny: [] },
        write: { allow: [], deny: ['/repo/dist/secret.txt'] },
      },
    };
    const evaluator = new PolicyEvaluator(policy, { repoRoot: '/repo' });
    evaluator.addSessionGrant('write', '/repo/dist/secret.txt');

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/repo',
      repoRoot: '/repo',
    });

    expect(options.readWritePaths).toContain('/repo/dist/secret.txt');
    expect(options.denyPaths).not.toContain('/repo/dist/secret.txt');
    expect(options.denyPatterns).not.toContain('/repo/dist/secret.txt');
  });

  it('filters alias-spelled deny paths covered by canonical runtime grants', async () => {
    const repoRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-'));
    const aliasRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-alias-'));
    try {
      const secrets = join(repoRoot, 'secrets');
      await mkdir(secrets);
      const target = join(secrets, '.env');
      await writeFile(target, 'token');
      const alias = join(aliasRoot, 'secrets-link');
      await symlink(secrets, alias);
      const aliasTarget = join(alias, '.env');
      const canonicalTarget = await realpath(target);
      const policy: PolicyConfig = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          read: { allow: [], deny: [aliasTarget] },
          write: { allow: [], deny: [] },
        },
      };
      const evaluator = new PolicyEvaluator(policy, {
        repoRoot,
        cliGrants: { read: [canonicalTarget] },
      });

      const options = policyToSandboxOptions(evaluator, {
        cwd: repoRoot,
        repoRoot,
      });

      expect(options.readOnlyPaths).toContain(canonicalTarget);
      expect(options.denyPaths).not.toContain(canonicalTarget);
      expect(options.denyPaths).not.toContain(aliasTarget);
      expect(options.denyPatterns).not.toContain(aliasTarget);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(aliasRoot, { recursive: true, force: true });
    }
  });

  it('filters alias-spelled deny glob patterns covered by canonical runtime grants', async () => {
    const repoRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-'));
    const aliasRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-alias-'));
    try {
      const secrets = join(repoRoot, 'secrets');
      await mkdir(secrets);
      const target = join(secrets, '.env');
      await writeFile(target, 'token');
      const alias = join(aliasRoot, 'secrets-link');
      await symlink(secrets, alias);
      const denyPattern = join(alias, '**');
      const canonicalSecrets = await realpath(secrets);
      const policy: PolicyConfig = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          read: { allow: [], deny: [denyPattern] },
          write: { allow: [], deny: [] },
        },
      };
      const evaluator = new PolicyEvaluator(policy, {
        repoRoot,
        cliGrants: { read: [canonicalSecrets] },
      });

      const options = policyToSandboxOptions(evaluator, {
        cwd: repoRoot,
        repoRoot,
      });

      expect(options.readOnlyPaths).toContain(canonicalSecrets);
      expect(options.denyPaths).not.toContain(canonicalSecrets);
      expect(options.denyPatterns).not.toContain(denyPattern);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(aliasRoot, { recursive: true, force: true });
    }
  });

  it('realpath-normalizes read grants that pass through a symlink', async () => {
    const repoRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-'));
    const aliasRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-alias-'));
    try {
      const dir = join(repoRoot, 'schema-dir');
      await mkdir(dir);
      const alias = join(aliasRoot, 'schema-link');
      await symlink(dir, alias);
      const canonicalDir = await realpath(dir);
      const policy: PolicyConfig = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          read: { allow: [join(alias, '**')], deny: [] },
          write: { allow: [], deny: [] },
        },
      };
      const evaluator = new PolicyEvaluator(policy, { repoRoot });

      const options = policyToSandboxOptions(evaluator, {
        cwd: repoRoot,
        repoRoot,
      });

      expect(options.readOnlyPaths).toContain(canonicalDir);
      expect(options.readOnlyPaths).not.toContain(alias);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(aliasRoot, { recursive: true, force: true });
    }
  });

  it('realpath-normalizes future write grants through the nearest existing symlink ancestor', async () => {
    const repoRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-'));
    const aliasRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-alias-'));
    try {
      const dist = join(repoRoot, 'dist');
      await mkdir(dist);
      const alias = join(aliasRoot, 'dist-link');
      await symlink(dist, alias);
      const futurePath = join(alias, 'new-file.txt');
      const canonicalRepo = await realpath(repoRoot);
      const policy: PolicyConfig = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          read: { allow: [], deny: [] },
          write: { allow: [futurePath], deny: [] },
        },
      };
      const evaluator = new PolicyEvaluator(policy, { repoRoot });

      const options = policyToSandboxOptions(evaluator, {
        cwd: repoRoot,
        repoRoot,
      });

      expect(options.readWritePaths).toContain(join(canonicalRepo, 'dist', 'new-file.txt'));
      expect(options.readWritePaths).not.toContain(futurePath);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(aliasRoot, { recursive: true, force: true });
    }
  });

  it('normalizes the macOS tmpdir alias from /var/folders to /private/var/folders when present', async () => {
    const tmp = tmpdir();
    if (process.platform !== 'darwin' || !tmp.startsWith('/var/folders/')) {
      return;
    }
    const canonicalTmp = await realpath(tmp);
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: { allow: [], deny: [] },
        write: { allow: ['{tmp}/rundown-sandbox-test/**'], deny: [] },
      },
    };
    const evaluator = new PolicyEvaluator(policy, {
      repoRoot: '/repo',
      tmpDir: tmp,
    });

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/repo',
      repoRoot: '/repo',
      tmpDir: tmp,
    });

    expect(options.readWritePaths).toContain(join(canonicalTmp, 'rundown-sandbox-test'));
    expect(options.readWritePaths).not.toContain(join(tmp, 'rundown-sandbox-test'));
  });

  it('applies the same canonicalization to policyConfigToSandboxOptions', async () => {
    const repoRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-'));
    const aliasRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-alias-'));
    try {
      const dir = join(repoRoot, 'raw-policy-read');
      await mkdir(dir);
      const alias = join(aliasRoot, 'raw-policy-link');
      await symlink(dir, alias);
      const canonicalDir = await realpath(dir);
      const policy: PolicyConfig = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          read: { allow: [join(alias, '**')], deny: [] },
          write: { allow: [], deny: [] },
        },
      };

      const options = policyConfigToSandboxOptions(policy, {
        cwd: repoRoot,
        repoRoot,
      });

      expect(options.readOnlyPaths).toContain(canonicalDir);
      expect(options.readOnlyPaths).not.toContain(alias);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(aliasRoot, { recursive: true, force: true });
    }
  });

  it('includes metadata-read ancestors and grant roots for raw policy sandbox options', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: { allow: ['/Users/alice/project/schema.json'], deny: [] },
        write: { allow: ['/Users/alice/project/dist/**'], deny: [] },
      },
    };

    const options = policyConfigToSandboxOptions(policy, {
      cwd: '/Users/alice/project',
      repoRoot: '/Users/alice/project',
    });

    expect(options.metadataReadPaths).toEqual(
      expect.arrayContaining([
        '/Users',
        '/Users/alice',
        '/Users/alice/project',
        '/Users/alice/project/schema.json',
        '/Users/alice/project/dist',
      ]),
    );
  });

  it('includes metadata-read ancestors for sandbox grant roots', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: { allow: ['/Users/alice/project/schema.json'], deny: [] },
        write: { allow: ['/Users/alice/project/dist/**'], deny: [] },
      },
    };
    const evaluator = new PolicyEvaluator(policy, { repoRoot: '/Users/alice/project' });

    const options = policyToSandboxOptions(evaluator, {
      cwd: '/Users/alice/project',
      repoRoot: '/Users/alice/project',
    });

    expect(options.metadataReadPaths).toEqual(
      expect.arrayContaining(['/Users', '/Users/alice', '/Users/alice/project']),
    );
    expect(options.metadataReadPaths).toEqual(
      expect.arrayContaining(['/Users/alice/project/schema.json', '/Users/alice/project/dist']),
    );
  });

  it('rejects out-of-root extra read-write paths in policyToSandboxOptions', async () => {
    const repoRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-'));
    const outsidePath = join(dirname(repoRoot), 'outside.txt');
    try {
      await writeFile(outsidePath, 'outside');
      const policy: PolicyConfig = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
        },
      };
      const options = {
        cwd: repoRoot,
        repoRoot,
        extraReadWritePaths: [outsidePath],
      };

      const evaluator = new PolicyEvaluator(policy);
      expect(() => policyToSandboxOptions(evaluator, options)).toThrow(/escapes trusted roots/);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(outsidePath, { force: true });
    }
  });

  it('rejects out-of-root extra read-write paths in policyConfigToSandboxOptions', async () => {
    const repoRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-'));
    const outsidePath = join(dirname(repoRoot), 'outside.txt');
    try {
      await writeFile(outsidePath, 'outside');
      const policy: PolicyConfig = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
        },
      };
      const options = {
        cwd: repoRoot,
        repoRoot,
        extraReadWritePaths: [outsidePath],
      };

      expect(() => policyConfigToSandboxOptions(policy, options)).toThrow(/escapes trusted roots/);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(outsidePath, { force: true });
    }
  });

  it('rejects wrong-device extra read-write paths in policyToSandboxOptions', async () => {
    const repoRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-'));
    try {
      const capturePath = join(repoRoot, 'output.txt');
      const actualFs = await import('node:fs');
      // Reset modules and re-import so this test binds the mocked `node:fs` inside the fresh module.
      // The outer mapper reference keeps the original import for the branch check.
      jest.resetModules();
      jest.unstable_mockModule('node:fs', () => ({
        ...actualFs,
        realpathSync: jest.fn((value: string) => value),
        statSync: jest.fn((value: string) => {
          const dev = value.includes('output.txt') ? 2 : 1;
          return { dev } as unknown as Stats;
        }),
      }));
      const { policyToSandboxOptions: mockedPolicyToSandboxOptions } = await import(
        '../../src/sandbox/policy-mapper.js'
      );
      const policy: PolicyConfig = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
        },
      };
      const options = {
        cwd: repoRoot,
        repoRoot,
        extraReadWritePaths: [capturePath],
      };

      const evaluator = new PolicyEvaluator(policy);
      expect(() => mockedPolicyToSandboxOptions(evaluator, options)).toThrow(/different device/);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      jest.resetModules();
    }
  });

  it('rejects wrong-device extra read-write paths in policyConfigToSandboxOptions', async () => {
    const repoRoot = await mkdtemp(join(process.cwd(), 'policy-mapper-'));
    try {
      const capturePath = join(repoRoot, 'output.txt');
      const actualFs = await import('node:fs');
      // Reset modules and re-import so this test binds the mocked `node:fs` inside the fresh module.
      // The outer mapper reference keeps the original import for the branch check.
      jest.resetModules();
      jest.unstable_mockModule('node:fs', () => ({
        ...actualFs,
        realpathSync: jest.fn((value: string) => value),
        statSync: jest.fn((value: string) => {
          const dev = value.includes('output.txt') ? 2 : 1;
          return { dev } as unknown as Stats;
        }),
      }));
      const { policyConfigToSandboxOptions: mockedPolicyConfigToSandboxOptions } = await import(
        '../../src/sandbox/policy-mapper.js'
      );
      const policy: PolicyConfig = {
        ...DEFAULT_POLICY,
        default: {
          ...DEFAULT_POLICY.default,
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
        },
      };
      const options = {
        cwd: repoRoot,
        repoRoot,
        extraReadWritePaths: [capturePath],
      };

      expect(() => mockedPolicyConfigToSandboxOptions(policy, options)).toThrow(/different device/);
    } finally {
      jest.resetModules();
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('policyConfigToSandboxOptions', () => {
  it('works with raw policy config', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: {
          allow: ['/readable/**'],
          deny: [],
        },
        write: {
          allow: ['/writable/**'],
          deny: [],
        },
      },
    };

    const options = policyConfigToSandboxOptions(policy, {
      cwd: '/test/dir',
    });

    expect(options.cwd).toBe('/test/dir');
    expect(options.readOnlyPaths).toContain('/readable');
    expect(options.readWritePaths).toContain('/writable');
  });

  it('handles empty policy', () => {
    const options = policyConfigToSandboxOptions(DEFAULT_POLICY, {
      cwd: '/test',
    });

    expect(options.readOnlyPaths).toBeDefined();
    expect(options.readWritePaths).toBeDefined();
    expect(options.denyPaths).toBeDefined();
  });
});

describe('extractBasePath behavior', () => {
  it('extracts base path from glob with **', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: {
          allow: ['/home/user/**'],
          deny: [],
        },
        write: {
          allow: [],
          deny: [],
        },
      },
    };

    const options = policyConfigToSandboxOptions(policy, {
      cwd: '/test',
    });

    expect(options.readOnlyPaths).toContain(canonicalPathForTest('/home/user'));
  });

  it('extracts base path from glob with *.ext', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: {
          allow: ['/home/user/*.txt'],
          deny: [],
        },
        write: {
          allow: [],
          deny: [],
        },
      },
    };

    const options = policyConfigToSandboxOptions(policy, {
      cwd: '/test',
    });

    expect(options.readOnlyPaths).toContain(canonicalPathForTest('/home/user'));
  });

  it('returns path as-is when no glob characters', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: {
          allow: ['/home/user/specific-file.txt'],
          deny: [],
        },
        write: {
          allow: [],
          deny: [],
        },
      },
    };

    const options = policyConfigToSandboxOptions(policy, {
      cwd: '/test',
    });

    expect(options.readOnlyPaths).toContain(canonicalPathForTest('/home/user/specific-file.txt'));
  });

  it('handles glob in middle of path', () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        read: {
          allow: ['/home/*/documents'],
          deny: [],
        },
        write: {
          allow: [],
          deny: [],
        },
      },
    };

    const options = policyConfigToSandboxOptions(policy, {
      cwd: '/test',
    });

    expect(options.readOnlyPaths).toContain(canonicalPathForTest('/home'));
  });
});
