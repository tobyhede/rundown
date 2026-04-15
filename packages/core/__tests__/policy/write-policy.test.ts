import * as path from 'node:path';
import { PolicyEvaluator } from '../../src/policy/evaluator.js';
import { DEFAULT_POLICY } from '../../src/policy/schema.js';

const REPO = '/test/repo';
const abs = (...parts: string[]): string => path.join(REPO, ...parts);
const evaluator = new PolicyEvaluator(DEFAULT_POLICY, { repoRoot: REPO });

describe('DEFAULT_POLICY write allowlist — semantic (glob-matcher)', () => {
  describe('generated .rundown paths are allowed', () => {
    it.each([
      ['.rundown/runs/abc.json'],
      ['.rundown/runs/nested/state.json'],
      ['.rundown/locks/run-abc.delegation.lock'],
      ['.rundown/session.json'],
      ['.rundown/work/main/artifact.txt'],
      ['.rundown/work/feature-foo/deep/file.md'],
      ['.rundown/contexts/ctx-abc/outputs.json'],
      ['.rundown/contexts/sprint-42/outputs.json'],
    ])('allows write to %s', (rel) => {
      expect(evaluator.checkPath(abs(rel), 'write').allowed).toBe(true);
    });
  });

  describe('user-managed and unrecognized .rundown paths are blocked', () => {
    it('.rundown/config.yaml is a hard deny (not merely prompt-gated)', () => {
      // config.yaml is in write.deny — it must be denied even if the caller
      // has a grant or override that widens the allowlist, and must NOT fall
      // back to a prompt which would let an inattentive user approve it.
      const decision = evaluator.checkPath(abs('.rundown/config.yaml'), 'write');
      expect(decision.allowed).toBe(false);
      expect(decision.requiresPrompt).toBe(false); // hard deny, not prompt-required
    });

    it.each([
      ['.rundown/other.json'], // unrecognized top-level file
      ['.rundown/config.yaml.bak'], // adjacent user file
    ])('denies write to %s', (rel) => {
      expect(evaluator.checkPath(abs(rel), 'write').allowed).toBe(false);
    });
  });
});
