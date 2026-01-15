import { describe, it, expect } from '@jest/globals';
import { parseWorkflowDocument } from '../src/parser.js';

/**
 * Tests tags extraction through full document parsing (parseWorkflowDocument).
 *
 * These tests verify tags flow correctly from frontmatter through to the
 * final Workflow object. For isolated frontmatter parsing tests, see
 * frontmatter.test.ts which tests WorkflowFrontmatterSchema validation.
 */
describe('Tags extraction', () => {
  it('should extract tags from frontmatter', () => {
    const markdown = `---
name: test-workflow
tags:
  - retry
  - transition
---

# Test Workflow

## 1. Step
- PASS: COMPLETE
`;
    const result = parseWorkflowDocument(markdown);
    expect(result.tags).toEqual(['retry', 'transition']);
  });

  it('should handle workflow without tags', () => {
    const markdown = `---
name: test-workflow
---

# Test Workflow

## 1. Step
- PASS: COMPLETE
`;
    const result = parseWorkflowDocument(markdown);
    expect(result.tags).toBeUndefined();
  });

  it('should handle empty tags array', () => {
    const markdown = `---
name: test-workflow
tags: []
---

# Test Workflow

## 1. Step
- PASS: COMPLETE
`;
    const result = parseWorkflowDocument(markdown);
    expect(result.tags).toEqual([]);
  });
});
