import { extractRawFrontmatter } from '../../src/helpers/extract-raw-frontmatter.js';

describe('extractRawFrontmatter', () => {
  it('extracts all YAML fields including unknown ones', () => {
    const markdown = `---
name: test-workflow
scenarios:
  success:
    commands:
      - rd pass
    result: COMPLETE
custom_field: value
---

# Test Content
`;
    const result = extractRawFrontmatter(markdown);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('test-workflow');
    expect(result.frontmatter?.scenarios).toBeDefined();
    expect(result.frontmatter?.scenarios.success.commands).toEqual(['rd pass']);
    expect(result.frontmatter?.custom_field).toBe('value');
    expect(result.content).toContain('# Test Content');
  });

  it('returns null frontmatter for invalid YAML', () => {
    const markdown = `---
invalid: [unclosed
---

# Content
`;
    const result = extractRawFrontmatter(markdown);
    expect(result.frontmatter).toBeNull();
    expect(result.content).toContain('# Content');
  });

  it('returns null frontmatter when no frontmatter present', () => {
    const markdown = `# Just Content

No frontmatter here.
`;
    const result = extractRawFrontmatter(markdown);
    expect(result.frontmatter).toBeNull();
    expect(result.content).toContain('# Just Content');
  });

  it('handles leading whitespace before frontmatter', () => {
    const markdown = `

---
name: test
---

# Content
`;
    const result = extractRawFrontmatter(markdown);
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe('test');
    expect(result.content).toContain('# Content');
  });
});
