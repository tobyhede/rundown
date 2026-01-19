import { describe, it, expect } from '@jest/globals';
import {
  policyToSandboxOptions,
  policyConfigToSandboxOptions,
} from '../../src/sandbox/policy-mapper.js';
import { PolicyEvaluator } from '../../src/policy/evaluator.js';
import { DEFAULT_POLICY, type PolicyConfig } from '../../src/policy/schema.js';

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
    expect(options.denyPaths).toBeDefined();
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

    expect(options.readWritePaths).toContain('/var/tmp/cache');
  });

  it('passes through allowUnsandboxed option', () => {
    const evaluator = new PolicyEvaluator(DEFAULT_POLICY);
    const options = policyToSandboxOptions(evaluator, {
      cwd: '/test',
      allowUnsandboxed: true,
    });

    expect(options.allowUnsandboxed).toBe(true);
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

    expect(options.readOnlyPaths).toContain('/home/user');
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

    expect(options.readOnlyPaths).toContain('/home/user');
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

    expect(options.readOnlyPaths).toContain('/home/user/specific-file.txt');
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

    expect(options.readOnlyPaths).toContain('/home');
  });
});
