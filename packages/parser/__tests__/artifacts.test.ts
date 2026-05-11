import { describe, it, expect } from '@jest/globals';
import {
  parseArtifactDeclaration,
  parseRunbookDocument,
  RunbookSyntaxError,
} from '../src/index.js';

describe('parseArtifactDeclaration', () => {
  it('parses a bare key into rawToken (classification deferred to resolver)', () => {
    expect(parseArtifactDeclaration('PlanPath "plan.json"')).toEqual({
      name: 'PlanPath',
      rawToken: 'plan.json',
    });
  });

  it('parses a bare key with glob characters into rawToken', () => {
    expect(parseArtifactDeclaration('Reviews "*-reviews.json"')).toEqual({
      name: 'Reviews',
      rawToken: '*-reviews.json',
    });
  });

  it('parses a bare key with `?` glob character', () => {
    expect(parseArtifactDeclaration('Single "plan-?.json"')).toEqual({
      name: 'Single',
      rawToken: 'plan-?.json',
    });
  });

  it('parses a bare key with template markers (expansion deferred to resolver)', () => {
    expect(parseArtifactDeclaration('Plan "{{ContextId}}-plan.json"')).toEqual({
      name: 'Plan',
      rawToken: '{{ContextId}}-plan.json',
    });
  });

  it('parses a URI literal token (classification deferred to resolver)', () => {
    expect(parseArtifactDeclaration('Plan "rd://artifacts/ctx1/*/plan.json"')).toEqual({
      name: 'Plan',
      rawToken: 'rd://artifacts/ctx1/*/plan.json',
    });
  });

  it('accepts slashes inside the rawToken (URI form)', () => {
    expect(
      parseArtifactDeclaration('Plan "rd://artifacts/{{ContextId}}/{{RunId}}/plan.json"'),
    ).toEqual({
      name: 'Plan',
      rawToken: 'rd://artifacts/{{ContextId}}/{{RunId}}/plan.json',
    });
  });

  it('accepts a recursive `**` token (resolver enforces the rule)', () => {
    expect(parseArtifactDeclaration('Plans "**.json"')).toEqual({
      name: 'Plans',
      rawToken: '**.json',
    });
  });

  it('accepts the empty quoted token (resolver enforces the rule)', () => {
    expect(parseArtifactDeclaration('PlanPath ""')).toEqual({
      name: 'PlanPath',
      rawToken: '',
    });
  });

  it('parses the naked form (no quoted token)', () => {
    expect(parseArtifactDeclaration('Plan')).toEqual({
      name: 'Plan',
      rawToken: null,
    });
  });

  it('parses with single-quoted token', () => {
    expect(parseArtifactDeclaration("Plan 'plan.json'")).toEqual({
      name: 'Plan',
      rawToken: 'plan.json',
    });
  });

  it('returns null when the token is not quoted', () => {
    expect(parseArtifactDeclaration('PlanPath plan.json')).toBeNull();
  });

  it('returns null on an invalid identifier name', () => {
    expect(parseArtifactDeclaration('123bad "plan.json"')).toBeNull();
  });

  it('returns null on an empty string', () => {
    expect(parseArtifactDeclaration('')).toBeNull();
  });

  it('returns null when extra content appears after the quoted token', () => {
    expect(parseArtifactDeclaration('PlanPath "plan.json" extra')).toBeNull();
  });

  it('returns null when the quoted string is unbalanced', () => {
    expect(parseArtifactDeclaration('PlanPath "plan.json')).toBeNull();
    expect(parseArtifactDeclaration('PlanPath plan.json"')).toBeNull();
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
      { name: 'PlanPath', rawToken: 'plan.json' },
      { name: 'Reviews', rawToken: '*-reviews.json' },
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
    expect(step.substeps[0].artifacts).toEqual([{ name: 'ChildPath', rawToken: 'child.json' }]);
  });

  it('parses naked-form ARTIFACTS declaration on a step', () => {
    const md = `## 1. Consumer
- ARTIFACTS
  - Plan
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(runbook.steps[0].artifacts).toEqual([{ name: 'Plan', rawToken: null }]);
  });

  it('parses URI literal token through the document parser', () => {
    const md = `## 1. Reader
- ARTIFACTS
  - Plan "rd://artifacts/ctx1/*/plan.json"
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(runbook.steps[0].artifacts).toEqual([
      { name: 'Plan', rawToken: 'rd://artifacts/ctx1/*/plan.json' },
    ]);
  });

  it('parses bare key with template through the document parser', () => {
    const md = `## 1. Templated
- ARTIFACTS
  - Plan "{{ContextId}}-plan.json"
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(runbook.steps[0].artifacts).toEqual([
      { name: 'Plan', rawToken: '{{ContextId}}-plan.json' },
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
    expect(runbook.steps[0].artifacts).toEqual([{ name: 'PlanPath', rawToken: 'plan.json' }]);
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
    expect(step.artifacts).toEqual([{ name: 'ParentPath', rawToken: 'parent.json' }]);
    if (step.kind !== 'substeps') throw new Error('expected substeps step');
    expect(step.substeps[0].artifacts).toEqual([{ name: 'ChildPath', rawToken: 'child.json' }]);
  });
});
