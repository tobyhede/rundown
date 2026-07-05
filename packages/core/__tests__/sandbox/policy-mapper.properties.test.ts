import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import { PolicyEvaluator } from '../../src/policy/evaluator.js';
import { DEFAULT_POLICY, type PolicyConfig } from '../../src/policy/schema.js';
import {
  policyConfigToSandboxOptions,
  policyToSandboxOptions,
} from '../../src/sandbox/policy-mapper.js';

const repoRoot = '/repo';

const segmentArb = fc
  .stringMatching(/^[a-z][a-z0-9_-]{0,8}$/)
  .filter((segment) => segment !== '.' && segment !== '..');

const relativePathArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join('/'));

function pathFor(relativePath: string): string {
  return `${repoRoot}/${relativePath}`;
}

function policyWithRules(args: {
  readAllow?: string[];
  readDeny?: string[];
  writeAllow?: string[];
  writeDeny?: string[];
}): PolicyConfig {
  return {
    ...DEFAULT_POLICY,
    default: {
      ...DEFAULT_POLICY.default,
      read: { allow: args.readAllow ?? [], deny: args.readDeny ?? [] },
      write: { allow: args.writeAllow ?? [], deny: args.writeDeny ?? [] },
    },
  };
}

function ancestorPaths(candidate: string): string[] {
  const parts = candidate.split('/').filter(Boolean);
  const ancestors: string[] = [];
  for (let i = 1; i <= parts.length; i += 1) {
    ancestors.push(`/${parts.slice(0, i).join('/')}`);
  }
  return ancestors;
}

describe('policyToSandboxOptions properties', () => {
  it('write grants win over read-only grants for the same root', () => {
    fc.assert(
      fc.property(relativePathArb, (relativePath) => {
        const grantRoot = pathFor(relativePath);
        const policy = policyWithRules({
          readAllow: [`${grantRoot}/**`],
          writeAllow: [`${grantRoot}/**`],
        });
        const evaluator = new PolicyEvaluator(policy, { repoRoot });

        const options = policyToSandboxOptions(evaluator, { cwd: repoRoot, repoRoot });

        expect(options.readWritePaths).toContain(grantRoot);
        expect(options.readOnlyPaths).not.toContain(grantRoot);
      }),
    );
  });

  it('runtime grants remove covered concrete deny paths', () => {
    fc.assert(
      fc.property(relativePathArb, segmentArb, (relativePath, fileName) => {
        const grantRoot = pathFor(relativePath);
        const deniedPath = `${grantRoot}/${fileName}`;
        const policy = policyWithRules({
          readDeny: [deniedPath],
        });
        const evaluator = new PolicyEvaluator(policy, {
          repoRoot,
          cliGrants: { read: [grantRoot] },
        });

        const options = policyToSandboxOptions(evaluator, { cwd: repoRoot, repoRoot });

        expect(options.readOnlyPaths).toContain(grantRoot);
        expect(options.denyPaths).not.toContain(deniedPath);
        expect(options.denyPatterns).not.toContain(deniedPath);
      }),
    );
  });

  it('metadata read paths include every grant root and ancestor except filesystem root', () => {
    fc.assert(
      fc.property(relativePathArb, relativePathArb, (readRelativePath, writeRelativePath) => {
        const readRoot = pathFor(readRelativePath);
        const writeRoot = pathFor(writeRelativePath);
        const policy = policyWithRules({
          readAllow: [`${readRoot}/**`],
          writeAllow: [`${writeRoot}/**`],
        });
        const evaluator = new PolicyEvaluator(policy, { repoRoot });

        const options = policyToSandboxOptions(evaluator, { cwd: repoRoot, repoRoot });

        for (const expected of [...ancestorPaths(readRoot), ...ancestorPaths(writeRoot)]) {
          expect(options.metadataReadPaths).toContain(expected);
        }
        expect(options.metadataReadPaths).not.toContain('/');
      }),
    );
  });

  it('canonicalized raw-policy grants are stable when mapped back through policy config', () => {
    fc.assert(
      fc.property(relativePathArb, relativePathArb, (readRelativePath, writeRelativePath) => {
        const first = policyConfigToSandboxOptions(
          policyWithRules({
            readAllow: [`${pathFor(readRelativePath)}/**`],
            writeAllow: [`${pathFor(writeRelativePath)}/**`],
          }),
          { cwd: repoRoot, repoRoot },
        );
        const second = policyConfigToSandboxOptions(
          policyWithRules({
            readAllow: first.readOnlyPaths,
            writeAllow: first.readWritePaths,
          }),
          { cwd: repoRoot, repoRoot },
        );

        expect(second.readOnlyPaths).toEqual(first.readOnlyPaths);
        expect(second.readWritePaths).toEqual(first.readWritePaths);
      }),
    );
  });
});
