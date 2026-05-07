import { describe, it, expect } from '@jest/globals';
import {
  EXACT_ARTIFACT_KEY_PATTERN,
  WILDCARD_ARTIFACT_KEY_PATTERN,
  isWildcardArtifactKey,
  parseArtifactDeclaration,
  parseRunbookDocument,
  RunbookSyntaxError,
} from '../src/index.js';

describe('parseArtifactDeclaration', () => {
  it('parses an exact key (alphanumerics, dot, dash, underscore)', () => {
    expect(parseArtifactDeclaration('PlanPath "plan.json"')).toEqual({
      name: 'PlanPath',
      key: 'plan.json',
      kind: 'exact',
    });
  });

  it('parses a wildcard key with `*`', () => {
    expect(parseArtifactDeclaration('Reviews "*-reviews.json"')).toEqual({
      name: 'Reviews',
      key: '*-reviews.json',
      kind: 'wildcard',
    });
  });

  it('parses a wildcard key with `?`', () => {
    expect(parseArtifactDeclaration('Single "plan-?.json"')).toEqual({
      name: 'Single',
      key: 'plan-?.json',
      kind: 'wildcard',
    });
  });

  it('returns null when the key is not quoted', () => {
    expect(parseArtifactDeclaration('PlanPath plan.json')).toBeNull();
  });

  it('returns null on a slash in the key', () => {
    expect(parseArtifactDeclaration('PlanPath "plans/plan.json"')).toBeNull();
  });

  it('returns null on a `..` traversal key', () => {
    expect(parseArtifactDeclaration('PlanPath ".."')).toBeNull();
  });

  it('returns null on a `.` key', () => {
    expect(parseArtifactDeclaration('PlanPath "."')).toBeNull();
  });

  it('returns null on an empty key', () => {
    expect(parseArtifactDeclaration('PlanPath ""')).toBeNull();
  });

  it('returns null on a recursive `**` wildcard', () => {
    expect(parseArtifactDeclaration('Plans "**.json"')).toBeNull();
  });

  it('returns null on an invalid identifier name', () => {
    expect(parseArtifactDeclaration('123bad "plan.json"')).toBeNull();
  });

  it('returns null on an empty string', () => {
    expect(parseArtifactDeclaration('')).toBeNull();
  });

  it('returns null when only a name is provided (no key)', () => {
    expect(parseArtifactDeclaration('PlanPath')).toBeNull();
  });

  it('returns null when text inside the quotes contains whitespace', () => {
    expect(parseArtifactDeclaration('PlanPath "plan with space.json"')).toBeNull();
  });

  it('does not template-expand keys (literal `{{var}}` is rejected by the key pattern)', () => {
    expect(parseArtifactDeclaration('PlanPath "{{var}}"')).toBeNull();
  });

  it('isWildcardArtifactKey returns true for wildcard keys', () => {
    expect(isWildcardArtifactKey('*-reviews.json')).toBe(true);
    expect(isWildcardArtifactKey('plan-?.json')).toBe(true);
  });

  it('isWildcardArtifactKey returns false for exact keys', () => {
    expect(isWildcardArtifactKey('plan.json')).toBe(false);
  });

  it('exposes EXACT_ARTIFACT_KEY_PATTERN and WILDCARD_ARTIFACT_KEY_PATTERN', () => {
    expect(EXACT_ARTIFACT_KEY_PATTERN.test('plan.json')).toBe(true);
    expect(EXACT_ARTIFACT_KEY_PATTERN.test('plan*.json')).toBe(false);
    expect(WILDCARD_ARTIFACT_KEY_PATTERN.test('plan*.json')).toBe(true);
  });
});

describe('parseRunbookDocument with ARTIFACTS directive', () => {
  it('attaches parsed artifacts to step when ARTIFACTS directive is present', () => {
    const md = `## 1. Write plan
- ARTIFACTS
  - PlanPath "plan.json"
  - Reviews "*-reviews.json"
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(runbook.steps[0].artifacts).toEqual([
      { name: 'PlanPath', key: 'plan.json', kind: 'exact' },
      { name: 'Reviews', key: '*-reviews.json', kind: 'wildcard' },
    ]);
  });

  it('attaches parsed artifacts to a substep', () => {
    const md = `## 1. Parent
### 1.1 Child
- ARTIFACTS
  - ChildPath "child.json"
- PASS DEFER
- FAIL DEFER
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    expect(step.kind).toBe('substeps');
    if (step.kind !== 'substeps') throw new Error('expected substeps step');
    expect(step.substeps[0].artifacts).toEqual([
      { name: 'ChildPath', key: 'child.json', kind: 'exact' },
    ]);
  });

  it('leaves artifacts undefined when no ARTIFACTS directive is present', () => {
    const md = `## 1. Plain step
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook } = parseRunbookDocument(md);
    expect(runbook.steps[0].artifacts).toBeUndefined();
  });

  it('throws RunbookSyntaxError when ARTIFACTS has no nested list', () => {
    const md = `## 1. Step
- ARTIFACTS
- PASS CONTINUE
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
    expect(() => parseRunbookDocument(md)).toThrow(/ARTIFACTS.*requires at least one/);
  });

  it('throws RunbookSyntaxError on duplicate ARTIFACTS directive on the same target', () => {
    const md = `## 1. Step
- ARTIFACTS
  - PlanPath "plan.json"
- ARTIFACTS
  - OtherPath "other.json"
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
    expect(() => parseRunbookDocument(md)).toThrow(/duplicate.*ARTIFACTS/i);
  });

  it('throws on duplicate alias inside one ARTIFACTS block', () => {
    const md = `## 1. Step
- ARTIFACTS
  - PlanPath "a.json"
  - PlanPath "b.json"
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
    expect(() => parseRunbookDocument(md)).toThrow(/duplicate.*alias.*PlanPath/i);
  });

  it('throws on a reserved-name alias', () => {
    const md = `## 1. Step
- ARTIFACTS
  - context "x.json"
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
    expect(() => parseRunbookDocument(md)).toThrow(/reserved variable name/);
  });

  it('throws on an invalid artifact key (slash)', () => {
    const md = `## 1. Step
- ARTIFACTS
  - Plans "plans/plan.json"
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
    expect(() => parseRunbookDocument(md)).toThrow(/Invalid ARTIFACTS declaration/);
  });

  it('throws on a recursive `**` key', () => {
    const md = `## 1. Step
- ARTIFACTS
  - Plans "**.json"
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
  });

  it('throws when ARTIFACTS appears after OUTPUTS', () => {
    const md = `## 1. Step
- OUTPUTS
  - Version
- ARTIFACTS
  - PlanPath "plan.json"
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
    expect(() => parseRunbookDocument(md)).toThrow(/ARTIFACTS.*must appear before OUTPUTS/);
  });

  it('throws when ARTIFACTS appears after a transition', () => {
    const md = `## 1. Step
- PASS CONTINUE
- ARTIFACTS
  - PlanPath "plan.json"
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
  });

  it('throws when ARTIFACTS appears after prompt body content', () => {
    const md = `## 1. Step
Some prompt text first.
- ARTIFACTS
  - PlanPath "plan.json"
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
  });

  it('does not misclassify prose starting with "ARTIFACTS" as a directive', () => {
    const md = `## 1. Step with ARTIFACTS prose
- PASS CONTINUE
- FAIL STOP
- ARTIFACTS are documented in the spec
`;
    const { runbook } = parseRunbookDocument(md);
    expect(runbook.steps[0].artifacts).toBeUndefined();
    expect(runbook.steps[0].prompt).toContain('ARTIFACTS are documented');
  });

  it('accepts same-name ARTIFACTS and OUTPUTS declarations on the same step', () => {
    const md = `## 1. Same-name pair
- ARTIFACTS
  - PlanPath "plan.json"
- OUTPUTS
  - PlanPath
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(runbook.steps[0].artifacts).toEqual([
      { name: 'PlanPath', key: 'plan.json', kind: 'exact' },
    ]);
    expect(runbook.steps[0].outputs).toEqual([{ name: 'PlanPath' }]);
  });

  it('preserves both step-level and substep-level ARTIFACTS', () => {
    const md = `## 1. Parent
- ARTIFACTS
  - ParentPath "parent.json"
### 1.1 Child
- ARTIFACTS
  - ChildPath "child.json"
- PASS DEFER
- FAIL DEFER
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    expect(step.artifacts).toEqual([{ name: 'ParentPath', key: 'parent.json', kind: 'exact' }]);
    if (step.kind !== 'substeps') throw new Error('expected substeps step');
    expect(step.substeps[0].artifacts).toEqual([
      { name: 'ChildPath', key: 'child.json', kind: 'exact' },
    ]);
  });
});
