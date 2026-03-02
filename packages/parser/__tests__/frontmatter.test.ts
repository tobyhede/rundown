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

  it('returns null frontmatter when name format is invalid', () => {
    const markdown = `---
name: invalid name with spaces
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).toBeNull();
    // gray-matter strips frontmatter even when validation fails
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

  it('returns null frontmatter when vars contains invalid types (arrays)', () => {
    const markdown = `---
name: my-runbook
vars:
  items:
    - one
    - two
---
# Content`;

    const result = extractFrontmatter(markdown);

    // Schema validation should fail for array values
    expect(result.frontmatter).toBeNull();
    // gray-matter strips frontmatter even when validation fails
    expect(result.content.trim()).toBe('# Content');
  });

  it('returns null frontmatter when vars contains invalid types (nested objects)', () => {
    const markdown = `---
name: my-runbook
vars:
  config:
    nested: value
---
# Content`;

    const result = extractFrontmatter(markdown);

    // Schema validation should fail for nested object values
    expect(result.frontmatter).toBeNull();
    // gray-matter strips frontmatter even when validation fails
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

  it('rejects name with spaces', () => {
    const markdown = `---
name: my runbook
---
# Content`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).toBeNull();
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
