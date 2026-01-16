import { describe, it, expect } from '@jest/globals';
import { parseRunbookDocument } from '../src/parser.js';

/**
 * Tests tags extraction through full document parsing (parseRunbookDocument).
 *
 * These tests verify tags flow correctly from frontmatter through to the
 * final Runbook object. For isolated frontmatter parsing tests, see
 * frontmatter.test.ts which tests RunbookFrontmatterSchema validation.
 */
describe('Tags extraction', () => {
  it('should extract tags from frontmatter', () => {
    const markdown = `---
name: test-runbook
tags:
  - retry
  - transition
---

# Test Runbook

## 1. Step
- PASS: COMPLETE
`;
    const result = parseRunbookDocument(markdown);
    expect(result.tags).toEqual(['retry', 'transition']);
  });

  it('should handle runbook without tags', () => {
    const markdown = `---
name: test-runbook
---

# Test Runbook

## 1. Step
- PASS: COMPLETE
`;
    const result = parseRunbookDocument(markdown);
    expect(result.tags).toBeUndefined();
  });

  it('should handle empty tags array', () => {
    const markdown = `---
name: test-runbook
tags: []
---

# Test Runbook

## 1. Step
- PASS: COMPLETE
`;
    const result = parseRunbookDocument(markdown);
    expect(result.tags).toEqual([]);
  });
});
