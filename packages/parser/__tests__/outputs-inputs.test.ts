import { describe, it, expect } from '@jest/globals';
import { parseOutputDeclaration, parseRunbookDocument, RunbookSyntaxError } from '../src/index.js';

describe('parseOutputDeclaration', () => {
  it('parses name with {{ path "..." }} helper expression', () => {
    const result = parseOutputDeclaration('PlanPath {{ path "plan.json" }}');
    expect(result).toEqual({ name: 'PlanPath', value: '{{ path "plan.json" }}' });
  });

  it('parses name with bare identifier value', () => {
    const result = parseOutputDeclaration('VarName item');
    expect(result).toEqual({ name: 'VarName', value: 'item' });
  });

  it('parses name with quoted literal value (strips quotes)', () => {
    // The parser unwraps surrounding quotes from literal values
    const result = parseOutputDeclaration('VarName "literal"');
    expect(result).toEqual({ name: 'VarName', value: 'literal' });
  });

  it('returns null for empty string', () => {
    expect(parseOutputDeclaration('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseOutputDeclaration('   ')).toBeNull();
  });

  it('returns null for invalid identifier name', () => {
    expect(parseOutputDeclaration('123bad value')).toBeNull();
  });

  it('returns null when only a name is provided (no value)', () => {
    expect(parseOutputDeclaration('PlanPath')).toBeNull();
  });
});

describe('parseRunbookDocument INPUTS directive', () => {
  it('parses single variable name as a nested list item', () => {
    const md = `## 1. Step
- PASS CONTINUE
- FAIL STOP
- INPUTS
  - PlanPath
`;
    const { runbook } = parseRunbookDocument(md);
    expect(runbook.steps[0].inputs).toEqual(['PlanPath']);
  });

  it('parses multiple variable names as nested list items', () => {
    const md = `## 1. Step
- PASS CONTINUE
- FAIL STOP
- INPUTS
  - PlanPath
  - OtherVar
`;
    const { runbook } = parseRunbookDocument(md);
    expect(runbook.steps[0].inputs).toEqual(['PlanPath', 'OtherVar']);
  });

  it('throws RunbookSyntaxError when INPUTS directive has no nested list', () => {
    const md = `## 1. Step
- PASS CONTINUE
- FAIL STOP
- INPUTS
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
  });

  it('throws RunbookSyntaxError for invalid identifier in INPUTS list', () => {
    const md = `## 1. Step
- PASS CONTINUE
- FAIL STOP
- INPUTS
  - 123bad
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
  });

  it('does not misclassify prose starting with "INPUTS" as an INPUTS directive', () => {
    const md = `## 1. Step with INPUTS prose
- PASS CONTINUE
- FAIL STOP
- INPUTS are validated at runtime
`;
    // Should parse without error and NOT set inputs on the step
    const { runbook } = parseRunbookDocument(md);
    expect(runbook.steps[0].inputs).toBeUndefined();
    // The prose should be included in the step content
    const step = runbook.steps[0];
    expect(JSON.stringify(step)).toContain('INPUTS are validated');
  });

  it('old indented-text form (no list item marker) is treated as step content, not a directive', () => {
    // "  PlanPath" (indented continuation, no "- ") becomes part of the same paragraph as INPUTS,
    // so extractText returns "INPUTS\nPlanPath" which does NOT match the exact "INPUTS" check.
    // Result: treated as regular list item prose, not an INPUTS directive.
    const md = `## 1. Step
- PASS CONTINUE
- FAIL STOP
- INPUTS
  PlanPath
`;
    const { runbook } = parseRunbookDocument(md);
    // Not an INPUTS directive — inputs is undefined
    expect(runbook.steps[0].inputs).toBeUndefined();
  });

  it('attaches INPUTS to a substep when declared inside that substep', () => {
    const md = `## 1. Parent step
### 1.1 Child substep
- INPUTS
  - PlanPath
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    expect(step.kind).toBe('substeps');
    if (step.kind !== 'substeps') {
      throw new Error('expected substeps step');
    }
    expect(step.substeps[0].inputs).toEqual(['PlanPath']);
  });

  it('preserves both parent-step and substep INPUTS when both are declared', () => {
    const md = `## 1. Parent step
- INPUTS
  - SharedPath
### 1.1 Child substep
- INPUTS
  - ChildOnly
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    expect(step.inputs).toEqual(['SharedPath']);
    expect(step.kind).toBe('substeps');
    if (step.kind !== 'substeps') {
      throw new Error('expected substeps step');
    }
    expect(step.substeps[0].inputs).toEqual(['ChildOnly']);
  });
});

describe('parseRunbookDocument with OUTPUTS directive', () => {
  it('attaches parsed outputs to step when OUTPUTS directive is present', () => {
    const md = `## 1. Write plan
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - PlanPath {{ path "plan.json" }}
`;
    const { runbook } = parseRunbookDocument(md);
    expect(runbook.steps[0].outputs).toEqual([
      { name: 'PlanPath', value: '{{ path "plan.json" }}' },
    ]);
  });

  it('leaves outputs undefined when no OUTPUTS directive is present', () => {
    const md = `## 1. Simple step
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook } = parseRunbookDocument(md);
    expect(runbook.steps[0].outputs).toBeUndefined();
  });

  it('throws RunbookSyntaxError for invalid OUTPUTS declaration', () => {
    const md = `## 1. Bad outputs
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - 123bad value
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
  });

  it('attaches parsed outputs to a substep when OUTPUTS directive is present', () => {
    const md = `## 1. Parent step
### 1.1 Child substep
- OUTPUTS
  - ChildPath {{ path "child.json" }}
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    expect(step.kind).toBe('substeps');
    if (step.kind !== 'substeps') {
      throw new Error('expected substeps step');
    }
    expect(step.substeps[0].outputs).toEqual([
      { name: 'ChildPath', value: '{{ path "child.json" }}' },
    ]);
  });

  it('preserves both parent-step and substep OUTPUTS when both are declared', () => {
    const md = `## 1. Parent step
- OUTPUTS
  - ParentPath {{ path "parent.json" }}
### 1.1 Child substep
- OUTPUTS
  - ChildPath {{ path "child.json" }}
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    expect(step.outputs).toEqual([{ name: 'ParentPath', value: '{{ path "parent.json" }}' }]);
    expect(step.kind).toBe('substeps');
    if (step.kind !== 'substeps') {
      throw new Error('expected substeps step');
    }
    expect(step.substeps[0].outputs).toEqual([
      { name: 'ChildPath', value: '{{ path "child.json" }}' },
    ]);
  });
});

describe('parseRunbookDocument frontmatter.inputs', () => {
  it('parses inputs array from frontmatter', () => {
    const md = `---
name: child-runbook
inputs:
  - PlanPath
---
## 1. Step
- PASS COMPLETE
`;
    const { frontmatter } = parseRunbookDocument(md);
    expect(frontmatter?.inputs).toEqual(['PlanPath']);
  });

  it('leaves inputs undefined when not present in frontmatter', () => {
    const md = `---
name: no-inputs
---
## 1. Step
- PASS COMPLETE
`;
    const { frontmatter } = parseRunbookDocument(md);
    expect(frontmatter?.inputs).toBeUndefined();
  });
});
