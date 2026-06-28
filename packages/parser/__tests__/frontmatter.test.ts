import { describe, it, expect } from '@jest/globals';
import { extractFrontmatter, nameFromFilename } from '../src/frontmatter.js';

describe('extractFrontmatter()', () => {
  it('extracts valid YAML frontmatter with all fields', () => {
    const markdown = `---
name: my-runbook
description: Test runbook
version: 1.0.0
author: John Doe
tags:
  - test
  - automation
---
# Content
This is the runbook content.`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('my-runbook');
    expect(result.frontmatter?.description).toBe('Test runbook');
    expect(result.frontmatter?.version).toBe('1.0.0');
    expect(result.frontmatter?.author).toBe('John Doe');
    expect(result.frontmatter?.tags).toEqual(['test', 'automation']);
    expect(result.content.trim()).toBe('# Content\nThis is the runbook content.');
  });

  // Regression guard for the js-yaml 3.x -> 4.x engine swap (GHSA-h67p-54hq-rp68
  // merge-key DoS): gray-matter is pnpm-patched to use js-yaml 4.x load(), whose
  // safe schema still resolves YAML anchors and `<<` merge keys. This pins that
  // frontmatter parsing keeps working after the engine change.
  it('resolves YAML anchors and merge keys in frontmatter (js-yaml 4.x engine)', () => {
    const markdown = `---
defaults: &defaults
  description: shared
name: merged-runbook
extra:
  <<: *defaults
  version: 2.0.0
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('merged-runbook');
    // The merge key copied `description` from the anchor and added `version`.
    expect((result.frontmatter as Record<string, unknown>).extra).toEqual({
      description: 'shared',
      version: '2.0.0',
    });
  });

  it('extracts valid YAML with only name field', () => {
    const markdown = `---
name: simple-runbook
---
# Content
Just content here.`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('simple-runbook');
    expect(result.frontmatter?.description).toBeUndefined();
    expect(result.frontmatter?.version).toBeUndefined();
    expect(result.content.trim()).toBe('# Content\nJust content here.');
  });

  it('returns null frontmatter when no --- delimiter present', () => {
    const markdown = `# No Frontmatter
This is just regular markdown content.
No YAML frontmatter here.`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe(markdown);
  });

  it('returns null frontmatter when YAML syntax is invalid', () => {
    const markdown = `---
name: my-runbook
invalid yaml: [unclosed bracket
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).toBeNull();
    // gray-matter still returns original content on parse error
    expect(result.content).toBe(markdown);
  });

  it('drops invalid name field', () => {
    const markdown = `---
name: invalid@name!
---
# Content`;

    const result = extractFrontmatter(markdown);

    // Invalid name is dropped (becomes undefined), content still stripped
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBeUndefined();
    expect(result.content.trim()).toBe('# Content');
  });

  it('extracts frontmatter when no content follows closing delimiter', () => {
    // Edge case: frontmatter-only document with no content after closing ---
    const markdown = `---
name: my-runbook
description: Test
---`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('my-runbook');
    expect(result.frontmatter?.description).toBe('Test');
    expect(result.content.trim()).toBe('');
  });

  it('extracts frontmatter with inputs field as a declaration list', () => {
    const markdown = `---
name: my-runbook
inputs:
  - greeting
  - name
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('my-runbook');
    expect(result.frontmatter?.inputs).toEqual(['greeting', 'name']);
  });

  it('extracts frontmatter with uppercase INPUTS: as a declaration list', () => {
    const markdown = `---
INPUTS:
  - environment
  - port
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter?.inputs).toEqual(['environment', 'port']);
  });

  it('returns undefined for an explicit empty INPUTS list', () => {
    const markdown = `---
name: my-runbook
INPUTS: []
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.inputs).toBeUndefined();
    expect(result.diagnostics).toHaveLength(0);
  });

  it('rejects legacy map-style inputs', () => {
    const markdown = `---
name: my-runbook
inputs:
  greeting: Hello
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.inputs).toBeUndefined();
    expect(result.diagnostics.some((d) => d.message.includes('YAML sequence'))).toBe(true);
  });

  // New tests for gray-matter specific behavior

  it('allows unknown fields via passthrough', () => {
    const markdown = `---
name: test-runbook
skill: my-skill
custom_field: some-value
another_field: 123
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('test-runbook');
    expect(result.frontmatter).toHaveProperty('skill', 'my-skill');
    expect(result.frontmatter).toHaveProperty('custom_field', 'some-value');
    expect(result.frontmatter).toHaveProperty('another_field', 123);
    expect(result.content.trim()).toBe('# Content');
  });

  it('preserves declarations and required alongside unknown passthrough fields', () => {
    const markdown = `---
name: test-runbook
inputs:
  - PlanPath
required:
  - Region
skill: my-skill
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter?.inputs).toEqual(['PlanPath']);
    expect(result.frontmatter?.required).toEqual(['Region']);
    expect(result.frontmatter).toHaveProperty('skill', 'my-skill');
  });

  it('handles horizontal rules (--) in content', () => {
    const markdown = `---
name: test-runbook
---

# Title

--

More content after horizontal rule`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('test-runbook');
    expect(result.content).toContain('--');
    expect(result.content).toContain('More content after horizontal rule');
  });

  it('handles triple dash horizontal rules (---) in content', () => {
    const markdown = `---
name: test-runbook
---

# Title

---

More content after horizontal rule`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('test-runbook');
    // The --- should be in the content, not treated as a second frontmatter block
    expect(result.content).toContain('---');
    expect(result.content).toContain('More content after horizontal rule');
  });

  it('returns valid frontmatter when name field is missing', () => {
    const markdown = `---
description: no name field here
version: 1.0.0
---
# Content`;

    const result = extractFrontmatter(markdown);

    // Name is now optional — frontmatter is valid without it
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBeUndefined();
    expect(result.frontmatter?.description).toBe('no name field here');
    expect(result.frontmatter?.version).toBe('1.0.0');
    expect(result.content.trim()).toBe('# Content');
  });

  it('returns null frontmatter when whitespace precedes opening ---', () => {
    const markdown = `
---
name: whitespace-test
---
# Content`;

    const result = extractFrontmatter(markdown);

    // gray-matter requires --- at the very start (no leading whitespace)
    // This is consistent with most frontmatter parsers
    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe(markdown);
  });

  it('accepts name with underscores', () => {
    const markdown = `---
name: my_runbook
---
# Content`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('my_runbook');
  });

  it('accepts name with mixed case', () => {
    const markdown = `---
name: My-Runbook
---
# Content`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('My-Runbook');
  });

  it('accepts name with underscores and hyphens and mixed case', () => {
    const markdown = `---
name: My_Runbook-v2
---
# Content`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('My_Runbook-v2');
  });

  it('accepts name with spaces', () => {
    const markdown = `---
name: my runbook
---
# Content`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('my runbook');
  });

  it('drops name when only whitespace', () => {
    const markdown = `---
name: "   "
---
# Content`;

    const result = extractFrontmatter(markdown);
    // Whitespace-only name fails regex validation, dropped to undefined
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBeUndefined();
  });

  it('returns null frontmatter for array YAML', () => {
    const markdown = `---
- one
- two
- three
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).toBeNull();
    expect(result.content.trim()).toBe('# Content');
  });

  it('returns null frontmatter for scalar YAML', () => {
    const markdown = `---
just a string
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).toBeNull();
    expect(result.content.trim()).toBe('# Content');
  });

  it('drops name when it has leading or trailing spaces', () => {
    const markdown = `---
name: " my runbook "
---
# Content`;

    const result = extractFrontmatter(markdown);
    // Leading/trailing spaces fail regex validation, name dropped to undefined
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBeUndefined();
  });
});

describe('nameFromFilename()', () => {
  it('extracts name from standard .runbook.md filename', () => {
    const filename = 'verify.runbook.md';
    const name = nameFromFilename(filename);
    expect(name).toBe('verify');
  });

  it('preserves hyphens in runbook names', () => {
    const filename = 'my-runbook.runbook.md';
    const name = nameFromFilename(filename);
    expect(name).toBe('my-runbook');
  });

  it('handles case-insensitive extension matching', () => {
    const filename = 'Test.RUNBOOK.MD';
    const name = nameFromFilename(filename);
    expect(name).toBe('Test');
  });
});

describe('extractFrontmatter() mutation killing', () => {
  it('rejects name with leading space', () => {
    const markdown = `---
name: " test"
---
# Content`;
    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBeUndefined();
  });

  it('accepts single-character name', () => {
    const markdown = `---
name: a
---
# Content`;
    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('a');
  });

  it('validates name regex end anchor (rejects name ending with space)', () => {
    const markdown = `---
name: "test "
---
# Content`;
    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBeUndefined();
  });

  it('returns null frontmatter for YAML null value', () => {
    const markdown = `---
null
---
# Content`;
    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).toBeNull();
  });

  it('returns null frontmatter for YAML number value', () => {
    const markdown = `---
42
---
# Content`;
    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).toBeNull();
  });

  it('returns null frontmatter for YAML boolean value', () => {
    const markdown = `---
true
---
# Content`;
    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).toBeNull();
  });
});

describe('nameFromFilename() mutation killing', () => {
  it('does not strip non-.runbook.md suffix', () => {
    expect(nameFromFilename('test.runbook.md.bak')).toBe('test.runbook.md.bak');
  });

  it('handles filename with only the extension', () => {
    expect(nameFromFilename('.runbook.md')).toBe('');
  });

  it('is case-insensitive for extension', () => {
    expect(nameFromFilename('test.RUNBOOK.MD')).toBe('test');
  });

  it('only removes trailing .runbook.md (not embedded)', () => {
    expect(nameFromFilename('my.runbook.md.runbook.md')).toBe('my.runbook.md');
  });
});

describe('required field', () => {
  it('parses required array', () => {
    const md = `---\nname: test\nrequired:\n  - VarA\n  - VarB\n---\n# Content`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.required).toEqual(['VarA', 'VarB']);
  });

  it('returns undefined when required is absent', () => {
    const md = `---\nname: test\n---\n# Content`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.required).toBeUndefined();
  });

  it('returns empty array for required: []', () => {
    const md = `---\nname: test\nrequired: []\n---\n# Content`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.required).toEqual([]);
  });

  it('drops to undefined for non-array required', () => {
    const md = `---\nname: test\nrequired: "not-array"\n---\n# Content`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.required).toBeUndefined();
  });

  it('drops invalid non-string entries and emits diagnostics', () => {
    const md = `---\nname: test\nrequired:\n  - 123\n  - true\n---\n# Content`;
    const { frontmatter, diagnostics } = extractFrontmatter(md);
    // Both entries invalid → no valid items kept, returns undefined
    expect(frontmatter?.required).toBeUndefined();
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].severity).toBe('error');
    expect(diagnostics[0].message).toMatch(/required\[0\].*string identifier/);
    expect(diagnostics[1].message).toMatch(/required\[1\].*string identifier/);
  });

  it('preserves valid entries and emits diagnostic for each invalid one', () => {
    const md = `---\nname: test\nrequired:\n  - ""\n  - VarA\n---\n# Content`;
    const { frontmatter, diagnostics } = extractFrontmatter(md);
    expect(frontmatter?.required).toEqual(['VarA']);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].message).toMatch(/required\[0\].*not a valid identifier/);
    expect(diagnostics[1].message).toMatch(/must also be declared in "inputs" or "artifacts"/);
  });

  it('coexists with inputs', () => {
    const md = `---\nname: test\ninputs:\n  - port\nrequired:\n  - PlanPath\n---\n# Content`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.inputs).toEqual(['port']);
    expect(frontmatter?.required).toEqual(['PlanPath']);
  });

  it('drops invalid identifier and emits diagnostic when only entry is invalid', () => {
    const md = `---\nname: test\nrequired:\n  - "123bad"\n---\n# Content`;
    const { frontmatter, diagnostics } = extractFrontmatter(md);
    expect(frontmatter?.required).toBeUndefined();
    expect(diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', message: expect.stringMatching(/123bad/) }),
    ]);
  });

  it('accepts valid underscore-prefixed identifiers', () => {
    const md = `---\nname: test\nrequired:\n  - _private\n  - MY_VAR\n---\n# Content`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.required).toEqual(['_private', 'MY_VAR']);
  });

  it('preserves valid entries when other entries have invalid identifiers', () => {
    const md = `---\nname: test\nrequired:\n  - GoodName\n  - "bad-name"\n---\n# Content`;
    const { frontmatter, diagnostics } = extractFrontmatter(md);
    expect(frontmatter?.required).toEqual(['GoodName']);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          message: expect.stringMatching(/bad-name.*not a valid identifier/),
        }),
        expect.objectContaining({
          severity: 'error',
          message: expect.stringMatching(/must also be declared in "inputs" or "artifacts"/),
        }),
      ]),
    );
  });

  it('rejects duplicate required names before subset validation', () => {
    const md = `---\nname: test\ninputs:\n  - PlanPath\nrequired:\n  - PlanPath\n  - PlanPath\n---\n# Content`;
    const { frontmatter, diagnostics } = extractFrontmatter(md);
    expect(frontmatter?.required).toEqual(['PlanPath']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toMatch(/duplicate entry "PlanPath".*"required"/i);
  });

  it('rejects poisoned required identifiers', () => {
    const md = `---\nname: test\nrequired:\n  - constructor\n---\n# Content`;
    const { frontmatter, diagnostics } = extractFrontmatter(md);
    expect(frontmatter?.required).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toMatch(/constructor.*not a valid identifier/i);
  });
});

describe('extractFrontmatter() — case-insensitive keys', () => {
  it('parses INPUTS: (uppercase) identically to inputs:', () => {
    const md = `---\nINPUTS:\n  - env\n---\n# Content`;
    const { frontmatter, diagnostics } = extractFrontmatter(md);
    expect(diagnostics).toHaveLength(0);
    expect(frontmatter?.inputs).toEqual(['env']);
  });

  it('parses Inputs: (mixed case) identically to inputs:', () => {
    const md = `---\nInputs:\n  - region\n---\n# Content`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.inputs).toEqual(['region']);
  });

  it('parses REQUIRED: (uppercase) identically to required:', () => {
    const md = `---\nREQUIRED:\n  - PlanPath\n---\n# Content`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.required).toEqual(['PlanPath']);
  });

  it('parses NAME: (uppercase) identically to name:', () => {
    const md = `---\nNAME: my-runbook\n---\n# Content`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.name).toBe('my-runbook');
  });

  it('first-occurrence wins on key collision (inputs: + INPUTS:)', () => {
    const md = `---\ninputs:\n  - first\nINPUTS:\n  - second\n---\n# Content`;
    const { frontmatter, diagnostics } = extractFrontmatter(md);
    // YAML preserves the first key; second is dropped
    expect(diagnostics).toHaveLength(0);
    expect(frontmatter?.inputs).toEqual(['first']);
  });

  it('preserves unknown passthrough keys unchanged', () => {
    const md = `---\nname: test\nMyCustomField: hello\n---\n# Content`;
    const { frontmatter } = extractFrontmatter(md);
    expect((frontmatter as any)?.MyCustomField).toBe('hello');
  });
});

describe('inputs: field (declaration list)', () => {
  it('parses inputs: as a string array', () => {
    const markdown = `---
inputs:
  - environment
  - port
  - debug
---
# Test`;
    const { frontmatter, diagnostics } = extractFrontmatter(markdown);
    expect(diagnostics).toHaveLength(0);
    expect(frontmatter?.inputs).toEqual(['environment', 'port', 'debug']);
  });

  it('rejects map-style entries inside the list', () => {
    const markdown = `---
inputs:
  - environment
  - PlanPath: staging
---
# Test`;
    const { frontmatter, diagnostics } = extractFrontmatter(markdown);
    expect(diagnostics).toHaveLength(1);
    expect(frontmatter?.inputs).toEqual(['environment']);
    expect(diagnostics[0].message).toContain('must be a string identifier');
  });

  it('rejects poisoned identifiers in inputs', () => {
    const markdown = `---
inputs:
  - __proto__
  - environment
---
# Test`;
    const { frontmatter, diagnostics } = extractFrontmatter(markdown);
    expect(frontmatter?.inputs).toEqual(['environment']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toMatch(/__proto__.*not a valid identifier/i);
  });

  it.each(['RunId', 'RunbookRef'])('rejects reserved runtime identity "%s" in inputs', (name) => {
    const markdown = `---
inputs:
  - ${name}
  - environment
---
# Test`;
    const { frontmatter, diagnostics } = extractFrontmatter(markdown);
    expect(frontmatter?.inputs).toEqual(['environment']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain(name);
    expect(diagnostics[0].message).toMatch(/reserved/i);
  });

  it('treats vars: as unknown passthrough (not a known field)', () => {
    const markdown = `---
vars:
  old: value
---
# Test`;
    const { frontmatter } = extractFrontmatter(markdown);
    // vars: is no longer a known field — it passes through as-is
    expect((frontmatter as Record<string, unknown>).vars).toEqual({ old: 'value' });
    expect(frontmatter?.inputs).toBeUndefined();
  });

  it('returns undefined when the inputs list is empty', () => {
    const markdown = `---
inputs:
  []
---
# Test`;
    const { frontmatter, diagnostics } = extractFrontmatter(markdown);
    expect(diagnostics).toHaveLength(0);
    expect(frontmatter?.inputs).toBeUndefined();
  });
});

describe('extractFrontmatter() — outputs field', () => {
  it('parses outputs: with naked-form entries', () => {
    const md = `---\noutputs:\n  - PlanPath\n---\n# Content`;
    const { frontmatter, diagnostics } = extractFrontmatter(md);
    expect(diagnostics).toHaveLength(0);
    expect(frontmatter?.outputs).toEqual([{ name: 'PlanPath' }]);
  });

  it('parses OUTPUTS: (uppercase) identically to outputs:', () => {
    const md = `---\nOUTPUTS:\n  - PlanPath\n---\n# Content`;
    const { frontmatter, diagnostics } = extractFrontmatter(md);
    expect(diagnostics).toHaveLength(0);
    expect(frontmatter?.outputs).toEqual([{ name: 'PlanPath' }]);
  });

  it('parses Outputs: (mixed case)', () => {
    const md = `---\nOutputs:\n  - ResultFile\n---\n# Content`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.outputs).toEqual([{ name: 'ResultFile' }]);
  });

  it('parses outputs: with with-value form entries', () => {
    const md = `---\noutputs:\n  - 'PlanPath {{ path "plan.json" }}'\n---\n# Content`;
    const { frontmatter, diagnostics } = extractFrontmatter(md);
    expect(diagnostics).toHaveLength(0);
    expect(frontmatter?.outputs).toHaveLength(1);
    expect(frontmatter?.outputs?.[0].name).toBe('PlanPath');
    expect(frontmatter?.outputs?.[0].value).toBe('{{ path "plan.json" }}');
  });

  it('parses mixed naked and with-value entries', () => {
    const md = `---\noutputs:\n  - NakedVar\n  - 'WithValue {{ path "out.json" }}'\n---\n# Content`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.outputs).toHaveLength(2);
    expect(frontmatter?.outputs?.[0]).toEqual({ name: 'NakedVar' });
    expect(frontmatter?.outputs?.[1].name).toBe('WithValue');
  });

  it('emits error diagnostic for reserved name in outputs', () => {
    const md = `---\noutputs:\n  - Step\n---\n# Content`;
    const { frontmatter, diagnostics } = extractFrontmatter(md);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('error');
    expect(diagnostics[0].message).toContain('"Step"');
    expect(frontmatter?.outputs).toBeUndefined();
  });

  it('emits error diagnostic for invalid identifier in outputs', () => {
    const md = `---\noutputs:\n  - "123bad"\n---\n# Content`;
    const { frontmatter, diagnostics } = extractFrontmatter(md);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('error');
    expect(frontmatter?.outputs).toBeUndefined();
  });

  it('emits error diagnostic for non-string entry in outputs', () => {
    const md = `---\noutputs:\n  - 42\n---\n# Content`;
    const { frontmatter, diagnostics } = extractFrontmatter(md);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('error');
    expect(diagnostics[0].message).toContain('outputs[0]');
    expect(frontmatter?.outputs).toBeUndefined();
  });

  it('preserves valid entries when other entries are invalid', () => {
    const md = `---\noutputs:\n  - GoodVar\n  - "123bad"\n---\n# Content`;
    const { frontmatter, diagnostics } = extractFrontmatter(md);
    expect(diagnostics).toHaveLength(1);
    expect(frontmatter?.outputs).toEqual([{ name: 'GoodVar' }]);
  });

  it('returns empty array for empty outputs array', () => {
    const md = `---\noutputs: []\n---\n# Content`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.outputs).toEqual([]);
  });
});

describe('frontmatter artifacts channel', () => {
  it('accepts an artifacts sequence of bare identifiers', () => {
    const { frontmatter, diagnostics } = extractFrontmatter(
      `---\nname: x\nartifacts:\n  - PlanPath\n---\n# X\n`,
    );
    expect(frontmatter?.artifacts).toEqual(['PlanPath']);
    expect(diagnostics).toEqual([]);
  });

  it('rejects a non-sequence artifacts value', () => {
    const { diagnostics } = extractFrontmatter(`---\nname: x\nartifacts: nope\n---\n# X\n`);
    expect(diagnostics.some((d) => /artifacts.*must be a YAML sequence/i.test(d.message))).toBe(
      true,
    );
  });

  it('rejects a non-string artifacts entry', () => {
    const { diagnostics } = extractFrontmatter(`---\nname: x\nartifacts:\n  - 3\n---\n# X\n`);
    expect(diagnostics.some((d) => /artifacts\[0\].*must be a string/i.test(d.message))).toBe(true);
  });

  it('rejects duplicate artifacts entries', () => {
    const { diagnostics } = extractFrontmatter(
      `---\nname: x\nartifacts:\n  - P\n  - P\n---\n# X\n`,
    );
    expect(diagnostics.some((d) => d.message.includes('duplicate entry "P"'))).toBe(true);
  });

  it('errors when a name appears in both inputs and artifacts', () => {
    const { diagnostics } = extractFrontmatter(
      `---\nname: x\ninputs:\n  - P\nartifacts:\n  - P\n---\n# X\n`,
    );
    expect(diagnostics.some((d) => /"P".*both "inputs" and "artifacts"/.test(d.message))).toBe(
      true,
    );
  });

  it('does NOT error when a name is in only one channel', () => {
    const { diagnostics } = extractFrontmatter(
      `---\nname: x\ninputs:\n  - A\nartifacts:\n  - B\n---\n# X\n`,
    );
    expect(diagnostics).toEqual([]);
  });

  it('validates required against inputs ∪ artifacts (artifacts-only name passes)', () => {
    const { diagnostics } = extractFrontmatter(
      `---\nname: x\nartifacts:\n  - PlanPath\nrequired:\n  - PlanPath\n---\n# X\n`,
    );
    expect(diagnostics).toEqual([]);
  });

  it('required diagnostic names both channels when unsatisfied', () => {
    const { diagnostics } = extractFrontmatter(
      `---\nname: x\ninputs:\n  - A\nrequired:\n  - Missing\n---\n# X\n`,
    );
    expect(
      diagnostics.some((d) =>
        d.message.includes('must also be declared in "inputs" or "artifacts"'),
      ),
    ).toBe(true);
  });

  it('no longer treats frontmatter ARTIFACTS as invalid', () => {
    const { diagnostics } = extractFrontmatter(`---\nname: x\nARTIFACTS:\n  - P\n---\n# X\n`);
    expect(diagnostics.some((d) => d.message.includes('ARTIFACTS is invalid in frontmatter'))).toBe(
      false,
    );
  });

  it('normalises ARTIFACTS: casing like INPUTS:', () => {
    const { frontmatter } = extractFrontmatter(
      `---\nname: x\nARTIFACTS:\n  - PlanPath\n---\n# X\n`,
    );
    expect(frontmatter?.artifacts).toEqual(['PlanPath']);
  });
});
