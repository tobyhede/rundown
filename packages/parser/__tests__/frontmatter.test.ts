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

  it('extracts frontmatter with vars field containing strings', () => {
    const markdown = `---
name: my-runbook
vars:
  greeting: Hello
  name: World
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('my-runbook');
    expect(result.frontmatter?.vars).toEqual({
      greeting: 'Hello',
      name: 'World',
    });
  });

  it('extracts frontmatter with vars field containing numbers', () => {
    const markdown = `---
name: my-runbook
vars:
  port: 3000
  ratio: 1.618
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.vars).toEqual({
      port: 3000,
      ratio: 1.618,
    });
  });

  it('extracts frontmatter with vars field containing booleans', () => {
    const markdown = `---
name: my-runbook
vars:
  debug: true
  production: false
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.vars).toEqual({
      debug: true,
      production: false,
    });
  });

  it('extracts frontmatter with vars field containing mixed types', () => {
    const markdown = `---
name: my-runbook
vars:
  name: test-app
  port: 8080
  debug: true
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.vars).toEqual({
      name: 'test-app',
      port: 8080,
      debug: true,
    });
  });

  it('extracts frontmatter with empty vars object', () => {
    const markdown = `---
name: my-runbook
vars: {}
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.vars).toEqual({});
  });

  it('drops vars when containing invalid types (arrays)', () => {
    const markdown = `---
name: my-runbook
vars:
  items:
    - one
    - two
---
# Content`;

    const result = extractFrontmatter(markdown);

    // Invalid vars dropped, valid name preserved
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('my-runbook');
    expect(result.frontmatter?.vars).toBeUndefined();
    expect(result.content.trim()).toBe('# Content');
  });

  it('drops vars when containing invalid types (nested objects)', () => {
    const markdown = `---
name: my-runbook
vars:
  config:
    nested: value
---
# Content`;

    const result = extractFrontmatter(markdown);

    // Invalid vars dropped, valid name preserved
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('my-runbook');
    expect(result.frontmatter?.vars).toBeUndefined();
    expect(result.content.trim()).toBe('# Content');
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

  it('preserves typed inputs and required alongside unknown passthrough fields', () => {
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
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toMatch(/required\[0\].*not a valid identifier/);
  });

  it('coexists with vars', () => {
    const md = `---\nname: test\nvars:\n  port: 3000\nrequired:\n  - PlanPath\n---\n# Content`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.vars).toEqual({ port: 3000 });
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
    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringMatching(/bad-name.*not a valid identifier/),
      }),
    ]);
  });
});
