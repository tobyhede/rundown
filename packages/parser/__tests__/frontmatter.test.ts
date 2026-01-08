import { describe, it, expect } from '@jest/globals';
import { extractFrontmatter, nameFromFilename } from '../src/frontmatter.js';

describe('extractFrontmatter()', () => {
  it('extracts valid YAML frontmatter with all fields', () => {
    const markdown = `---
name: my-workflow
description: Test workflow
version: 1.0.0
author: John Doe
tags:
  - test
  - automation
---
# Content
This is the workflow content.`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('my-workflow');
    expect(result.frontmatter?.description).toBe('Test workflow');
    expect(result.frontmatter?.version).toBe('1.0.0');
    expect(result.frontmatter?.author).toBe('John Doe');
    expect(result.frontmatter?.tags).toEqual(['test', 'automation']);
    expect(result.content).toBe('# Content\nThis is the workflow content.');
  });

  it('extracts valid YAML with only required name field', () => {
    const markdown = `---
name: simple-workflow
---
# Content
Just content here.`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('simple-workflow');
    expect(result.frontmatter?.description).toBeUndefined();
    expect(result.frontmatter?.version).toBeUndefined();
    expect(result.content).toBe('# Content\nJust content here.');
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
name: my-workflow
invalid yaml: [unclosed bracket
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe(markdown);
  });

  it('returns null frontmatter when name format is invalid', () => {
    const markdown = `---
name: invalid name with spaces
---
# Content`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe(markdown);
  });

  it('returns null frontmatter when frontmatter is unclosed (only opening ---)' , () => {
    const markdown = `---
name: my-workflow
description: Never closed

# Content starts here`;

    const result = extractFrontmatter(markdown);

    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe(markdown);
  });
});

describe('nameFromFilename()', () => {
  it('extracts name from standard .runbook.md filename', () => {
    const filename = 'verify.runbook.md';
    const name = nameFromFilename(filename);
    expect(name).toBe('verify');
  });

  it('preserves hyphens in workflow names', () => {
    const filename = 'my-workflow.runbook.md';
    const name = nameFromFilename(filename);
    expect(name).toBe('my-workflow');
  });

  it('handles case-insensitive extension matching', () => {
    const filename = 'Test.RUNBOOK.MD';
    const name = nameFromFilename(filename);
    expect(name).toBe('Test');
  });
});
