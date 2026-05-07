import { describe, it, expect } from '@jest/globals';
import {
  parseOutputDeclaration,
  parseRunbookDocument,
  parseStepOutputDeclaration,
  RunbookSyntaxError,
} from '../src/index.js';

// Regex-escape a dynamic segment before interpolating it into a `RegExp`
// constructor — avoids the static-analysis ReDoS warning and is defensive
// against future callers passing non-identifier fixtures.
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('parseOutputDeclaration', () => {
  it('parses name with {{ path "..." }} helper expression', () => {
    const result = parseOutputDeclaration('PlanPath {{ path "plan.json" }}');
    expect(result).toEqual({ name: 'PlanPath', value: '{{ path "plan.json" }}' });
  });

  it('parses name with bare identifier value', () => {
    const result = parseOutputDeclaration('VarName item');
    expect(result).toEqual({ name: 'VarName', value: 'item' });
  });

  it('parses name with quoted literal value (preserves quotes for evaluator)', () => {
    // The parser preserves the raw value expression; the evaluator handles quote-stripping
    const result = parseOutputDeclaration('VarName "literal"');
    expect(result).toEqual({ name: 'VarName', value: '"literal"' });
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

describe('parseRunbookDocument INPUTS step directive (removed)', () => {
  it('emits a parse error diagnostic when - INPUTS directive appears in a step', () => {
    const md = `## 1. Step
- PASS CONTINUE
- FAIL STOP
- INPUTS
  - PlanPath
`;
    const result = parseRunbookDocument(md);
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toMatch(/INPUTS step directive has been removed/);
  });

  it('emits a parse error when - INPUTS directive appears in a substep', () => {
    const md = `## 1. Parent step
### 1.1 Child substep
- INPUTS
  - PlanPath
`;
    const result = parseRunbookDocument(md);
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toMatch(/INPUTS step directive has been removed/);
  });

  it('does not misclassify prose starting with "INPUTS" as an INPUTS directive', () => {
    const md = `## 1. Step with INPUTS prose
- PASS CONTINUE
- FAIL STOP
- INPUTS are validated at runtime
`;
    // Should parse without any INPUTS-removal error and include the prose in the prompt
    const result = parseRunbookDocument(md);
    const inputsErrors = result.diagnostics.filter(
      (d) => d.severity === 'error' && d.message.includes('INPUTS step directive'),
    );
    expect(inputsErrors).toHaveLength(0);
    expect(result.runbook.steps[0].prompt).toContain('INPUTS are validated');
  });

  it('old indented-text form (no list item marker) is treated as step content, not a directive', () => {
    // "  PlanPath" (indented continuation, no "- ") becomes part of the same paragraph as INPUTS,
    // so extractText returns "INPUTS\nPlanPath" which does NOT match the exact "INPUTS" check.
    // Result: treated as regular list item prose, no INPUTS-removal diagnostic.
    const md = `## 1. Step
- PASS CONTINUE
- FAIL STOP
- INPUTS
  PlanPath
`;
    const result = parseRunbookDocument(md);
    const inputsErrors = result.diagnostics.filter(
      (d) => d.severity === 'error' && d.message.includes('INPUTS step directive'),
    );
    expect(inputsErrors).toHaveLength(0);
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

  it('throws RunbookSyntaxError when OUTPUTS directive has no nested list', () => {
    const md = `## 1. Step
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
  });

  it('does not misclassify prose starting with "OUTPUTS" as an OUTPUTS directive', () => {
    const md = `## 1. Step with OUTPUTS prose
- PASS CONTINUE
- FAIL STOP
- OUTPUTS are validated at runtime
`;
    const { runbook } = parseRunbookDocument(md);
    expect(runbook.steps[0].outputs).toBeUndefined();
    expect(runbook.steps[0].prompt).toContain('OUTPUTS are validated');
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

  it('throws RunbookSyntaxError when OUTPUTS block contains duplicate names', () => {
    const md = `## 1. Step
- OUTPUTS
  - PlanPath {{ path "a.json" }}
  - PlanPath {{ path "b.json" }}
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
    expect(() => parseRunbookDocument(md)).toThrow(/duplicate.*output.*PlanPath/i);
  });

  it('emits a parse error diagnostic for each - INPUTS directive encountered', () => {
    // Previously threw on duplicate; now each INPUTS directive emits a removal diagnostic
    const md = `## 1. Two inputs directives
- INPUTS
  - PlanPath
- INPUTS
  - OtherVar
`;
    const result = parseRunbookDocument(md);
    const errors = result.diagnostics.filter(
      (d) => d.severity === 'error' && d.message.includes('INPUTS step directive has been removed'),
    );
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it('throws RunbookSyntaxError on duplicate OUTPUTS directive for the same target', () => {
    const md = `## 1. Duplicate outputs
- OUTPUTS
  - First {{ path "a.json" }}
- OUTPUTS
  - Second {{ path "b.json" }}
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
    expect(() => parseRunbookDocument(md)).toThrow(/duplicate.*OUTPUTS/i);
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

  it.each([
    'Context',
    'context',
    'Step',
    'Index',
    'RunId',
    'RunbookRef',
  ])('rejects reserved name "%s" in frontmatter required', (name) => {
    const md = `---
name: bad-required
required:
  - ${name}
---
## 1. Step
- PASS COMPLETE
`;
    const { frontmatter, diagnostics } = parseRunbookDocument(md);
    expect(frontmatter?.required).toBeUndefined();
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          message: expect.stringMatching(new RegExp(`${escapeForRegExp(name)}.*reserved`, 'i')),
        }),
      ]),
    );
  });
});

describe('parseRunbookDocument INPUTS directive — reserved-name guard (removed)', () => {
  // The - INPUTS step directive has been removed. All of these cases now produce
  // the generic "INPUTS step directive has been removed" error rather than specific
  // reserved-name errors. Tests verify the directive produces a removal error.

  it.each([
    'context',
    'Context',
    'CONTEXT',
    'step',
    'Step',
    'index',
    'Index',
  ])('emits removal diagnostic when step-level INPUTS contains "%s"', (name) => {
    const md = `## 1. Step
- INPUTS
  - ${name}
`;
    const result = parseRunbookDocument(md);
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toMatch(/INPUTS step directive has been removed/);
  });

  it('emits removal diagnostic when substep-level INPUTS contains "context"', () => {
    const md = `## 1. Parent
### 1.1 Child
- INPUTS
  - context
`;
    const result = parseRunbookDocument(md);
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toMatch(/INPUTS step directive has been removed/);
  });

  it('emits removal diagnostic for any - INPUTS directive with valid identifiers', () => {
    const md = `## 1. Step
- INPUTS
  - PlanPath
  - ContextDir
`;
    const result = parseRunbookDocument(md);
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toMatch(/INPUTS step directive has been removed/);
  });
});

describe('parseRunbookDocument - INPUTS step directive removal', () => {
  it('emits a parse error when - INPUTS directive appears in a step', () => {
    const markdown = `---
inputs:
  - Message
---
# My Runbook

## 1. Use message
- INPUTS
  - Message

The message is: {{Message}}
PASS CONTINUE
`;
    const result = parseRunbookDocument(markdown);
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toMatch(/INPUTS step directive has been removed/);
  });

  it('does not populate step.inputs on any step', () => {
    const markdown = `# Runbook\n\n## 1. Step\nDo a thing.\nPASS CONTINUE\n`;
    const result = parseRunbookDocument(markdown);
    const step = result.runbook.steps[0];
    expect(step).toBeDefined();
    // inputs is no longer a field on step AST nodes
    expect('inputs' in step).toBe(false);
  });
});

describe('parseRunbookDocument OUTPUTS directive — reserved-name guard', () => {
  it.each([
    'context',
    'Context',
    'STEP',
    'Index',
    'RunId',
    'RunbookRef',
  ])('throws RunbookSyntaxError when OUTPUTS uses reserved name "%s"', (name) => {
    const md = `## 1. Step
- OUTPUTS
  - ${name} {{ path "x.json" }}
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
    expect(() => parseRunbookDocument(md)).toThrow(/reserved/i);
  });

  it('throws when substep-level OUTPUTS uses reserved "context"', () => {
    const md = `## 1. Parent
### 1.1 Child
- OUTPUTS
  - context {{ path "x.json" }}
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
  });
});

describe('parseStepOutputDeclaration', () => {
  it('accepts naked form (name only) and returns { name }', () => {
    expect(parseStepOutputDeclaration('Version')).toEqual({ name: 'Version' });
  });

  it('rejects an invalid identifier in naked form', () => {
    expect(parseStepOutputDeclaration('123bad')).toBeNull();
  });

  it('preserves expression-form parsing', () => {
    expect(parseStepOutputDeclaration('PlanPath {{ path "plan.json" }}')).toEqual({
      name: 'PlanPath',
      value: '{{ path "plan.json" }}',
    });
  });

  it('returns null for empty / whitespace-only input', () => {
    expect(parseStepOutputDeclaration('')).toBeNull();
    expect(parseStepOutputDeclaration('   ')).toBeNull();
  });

  it('parses a reserved-name naked entry without rejecting (caller enforces reserved-name policy)', () => {
    expect(parseStepOutputDeclaration('step')).toEqual({ name: 'step' });
  });
});

describe('parseRunbookDocument step OUTPUTS naked form', () => {
  it('accepts a naked OUTPUTS entry on a step', () => {
    const md = `## 1. Capture
- OUTPUTS
  - Version
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);
    expect(runbook.steps[0].outputs).toEqual([{ name: 'Version' }]);
  });

  it('accepts a naked OUTPUTS entry on a substep', () => {
    const md = `## 1. Parent
### 1.1 Child
- OUTPUTS
  - DeployUrl
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);
    const step = runbook.steps[0];
    expect('substeps' in step ? step.substeps[0].outputs : undefined).toEqual([
      { name: 'DeployUrl' },
    ]);
  });

  it('accepts mixed naked + expression entries in a single OUTPUTS block', () => {
    const md = `## 1. Capture
- OUTPUTS
  - DeployUrl
  - Tag "{{ RunId }}-staging"
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);
    expect(runbook.steps[0].outputs).toEqual([
      { name: 'DeployUrl' },
      { name: 'Tag', value: '"{{ RunId }}-staging"' },
    ]);
  });

  it('still rejects reserved names in naked form', () => {
    const md = `## 1. Capture
- OUTPUTS
  - step
- PASS CONTINUE
- FAIL STOP
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
    expect(() => parseRunbookDocument(md)).toThrow(/reserved variable name/);
  });
});
