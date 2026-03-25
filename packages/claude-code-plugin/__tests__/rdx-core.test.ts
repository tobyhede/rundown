import { describe, it, expect } from '@jest/globals';
import { renderToMarkdown } from '../src/rdx-core.js';

describe('renderToMarkdown', () => {
  describe('primitives and headings', () => {
    it('renders name as H1', () => {
      const md = renderToMarkdown({ name: 'Title' });
      expect(md).toBe('# Title\n');
    });

    it('renders name + string field as H1 + H2 section', () => {
      const md = renderToMarkdown({ name: 'Title', goal: 'Do X' });
      expect(md).toContain('# Title\n');
      expect(md).toContain('## Goal\n\nDo X\n');
    });

    it('omits null fields entirely', () => {
      const md = renderToMarkdown({ name: 'Title', dependencies: null });
      expect(md).not.toContain('Dependencies');
    });

    it('renders number as string paragraph', () => {
      const md = renderToMarkdown({ name: 'Root', count: 42 });
      expect(md).toContain('## Count\n\n42\n');
    });

    it('renders boolean as string paragraph', () => {
      const md = renderToMarkdown({ name: 'Root', enabled: true });
      expect(md).toContain('## Enabled\n\ntrue\n');
    });

    it('converts underscore field names to Title Case headings', () => {
      const md = renderToMarkdown({ name: 'Root', architecture_and_approach: 'Simple' });
      expect(md).toContain('## Architecture And Approach\n');
    });

    it('renders meta as YAML frontmatter', () => {
      const md = renderToMarkdown({ name: 'My Plan', meta: { version: '1.0.0' } });
      expect(md).toMatch(/^---\nversion: ['"]?1\.0\.0['"]?\n---\n/);
      expect(md).not.toContain('## Meta');
    });

    it('does not render meta in body', () => {
      const md = renderToMarkdown({
        name: 'Plan',
        meta: { version: '1.0.0', tags: ['planning'] },
        goal: 'Do it',
      });
      expect(md).toContain('---\n');
      expect(md).toContain('# Plan\n');
      expect(md).toContain('## Goal\n');
      expect(md).not.toContain('## Meta');
    });

    it('skips fields with empty-string keys', () => {
      const md = renderToMarkdown({ name: 'Root', '': 'hidden' });
      // Empty key should not produce a bare "## \n" heading
      expect(md).not.toMatch(/^##\s*$/m);
    });
  });

  describe('arrays', () => {
    it('renders array of primitives as bullet list', () => {
      const md = renderToMarkdown({ name: 'Root', items: ['a', 'b', 'c'] });
      expect(md).toContain('## Items\n\n- a\n- b\n- c\n');
    });

    it('omits empty arrays', () => {
      const md = renderToMarkdown({ name: 'Root', items: [] });
      expect(md).not.toContain('Items');
    });

    it('renders named array elements at parent depth without container heading', () => {
      const md = renderToMarkdown({
        name: 'Root',
        tasks: [
          { name: 'First Task', description: 'Do first thing' },
          { name: 'Second Task', description: 'Do second thing' },
        ],
      });
      expect(md).toContain('## 1. First Task\n');
      expect(md).toContain('## 2. Second Task\n');
      expect(md).not.toContain('## Tasks');
    });

    it('renders array of objects without name as pipe table', () => {
      const md = renderToMarkdown({
        name: 'Root',
        files: [
          { path: 'src/widget.ts', action: 'create', notes: 'Widget class' },
          { path: 'src/index.ts', action: 'edit' },
        ],
      });
      expect(md).toContain('| Path | Action | Notes |');
      expect(md).toMatch(/\|---+\|---+\|---+\|/); // separator row
      expect(md).toContain('| src/widget.ts | create | Widget class |');
      expect(md).toContain('| src/index.ts | edit |  |');
    });

    it('derives table column headers from union of all keys', () => {
      const md = renderToMarkdown({
        name: 'Root',
        items: [
          { a: '1', b: '2' },
          { a: '3', c: '4' },
        ],
      });
      expect(md).toContain('| A | B | C |');
    });

    it('escapes pipe characters in table cell values', () => {
      const md = renderToMarkdown({
        name: 'Root',
        items: [{ value: 'a|b', other: 'ok' }],
      });
      expect(md).toContain('| a\\|b | ok |');
      expect(md).not.toMatch(/\| a\|b \|/);
    });

    it('normalizes newlines in table cell values', () => {
      const md = renderToMarkdown({
        name: 'Root',
        items: [{ value: 'line1\nline2', other: 'a\r\nb' }],
      });
      expect(md).toContain('| line1 line2 | a b |');
    });

    it('escapes backslash characters in table cell values', () => {
      const md = renderToMarkdown({
        name: 'Root',
        items: [{ value: 'a\\b', other: 'c\\|d' }],
      });
      expect(md).toContain('| a\\\\b | c\\\\\\|d |');
    });

    it('renders nested named arrays with cascading numbers', () => {
      const md = renderToMarkdown({
        name: 'Root',
        tasks: [
          {
            name: 'Task One',
            subtasks: [
              { name: 'Sub A', description: 'Do A' },
              { name: 'Sub B', description: 'Do B' },
            ],
          },
        ],
      });
      expect(md).toContain('## 1. Task One\n');
      expect(md).toContain('### 1.1 Sub A\n');
      expect(md).toContain('### 1.2 Sub B\n');
    });
  });

  describe('code blocks', () => {
    it('renders field named code as fenced code block', () => {
      const md = renderToMarkdown({
        name: 'Root',
        code: 'console.log("hello");',
      });
      expect(md).toContain('```\nconsole.log("hello");\n```\n');
    });

    it('renders object with language and content as fenced code block', () => {
      const md = renderToMarkdown({
        name: 'Root',
        tasks: [
          {
            name: 'Task',
            code: { language: 'typescript', content: 'const x = 1;' },
          },
        ],
      });
      expect(md).toContain('```typescript\nconst x = 1;\n```\n');
    });

    it('renders nested object as subsection at depth+1', () => {
      const md = renderToMarkdown({
        name: 'Root',
        commit: { files: ['src/a.ts'], message: 'feat: add a' },
      });
      expect(md).toContain('## Commit\n');
      expect(md).toContain('### Files\n');
      expect(md).toContain('- src/a.ts\n');
      expect(md).toContain('### Message\n');
      expect(md).toContain('feat: add a\n');
    });

    it('caps heading depth at H6', () => {
      // Deeply nested object: Root(H1) > a(H2) > b(H3) > c(H4) > d(H5) > e(H6) > f(H6, capped)
      const md = renderToMarkdown({
        name: 'Root',
        a: { b: { c: { d: { e: { f: 'deep' } } } } },
      });
      // Count all headings — the deepest should be H6, not H7
      expect(md).not.toContain('#######');
      expect(md).toContain('###### F\n');
    });
  });

  describe('integration', () => {
    it('produces deterministic output (same input, same output)', () => {
      const input = {
        name: 'Add Widget',
        meta: { version: '1.0.0' },
        goal: 'Create a widget component.',
        architecture_and_approach: 'Simple component following existing patterns.',
        dependencies: null,
        files: [{ path: 'src/widget.ts', action: 'create', notes: 'Widget class' }],
        tasks: [
          {
            name: 'Implement Widget',
            files: [{ path: 'src/widget.ts', action: 'create' }],
            subtasks: [
              {
                name: 'Write failing test',
                description: 'Test widget construction.',
                code: { language: 'typescript', content: 'expect(new Widget()).toBeDefined();' },
              },
              {
                name: 'Implement widget',
                description: 'Create the widget class.',
                code: { language: 'typescript', content: 'export class Widget {}' },
              },
            ],
          },
        ],
      };
      const first = renderToMarkdown(input);
      const second = renderToMarkdown(input);
      expect(first).toBe(second);
    });

    it('renders the design doc example correctly', () => {
      const input = {
        name: 'Add Widget',
        meta: { version: '1.0.0' },
        goal: 'Create a widget component.',
        architecture_and_approach: 'Simple component following existing patterns.',
        dependencies: null,
        files: [{ path: 'src/widget.ts', action: 'create', notes: 'Widget class' }],
        tasks: [
          {
            name: 'Implement Widget',
            files: [{ path: 'src/widget.ts', action: 'create' }],
            subtasks: [
              {
                name: 'Write failing test',
                description: 'Test widget construction.',
                code: { language: 'typescript', content: 'expect(new Widget()).toBeDefined();' },
              },
              {
                name: 'Implement widget',
                description: 'Create the widget class.',
                code: { language: 'typescript', content: 'export class Widget {}' },
              },
            ],
          },
        ],
      };
      const md = renderToMarkdown(input);
      // Frontmatter
      expect(md).toMatch(/^---\n/);
      // H1
      expect(md).toContain('# Add Widget\n');
      // Prose sections
      expect(md).toContain('## Goal\n\nCreate a widget component.\n');
      expect(md).toContain('## Architecture And Approach\n');
      // Null omitted
      expect(md).not.toContain('Dependencies');
      // File table
      expect(md).toContain('| Path | Action | Notes |');
      expect(md).toContain('| src/widget.ts | create | Widget class |');
      // Task heading (named array replaces parent)
      expect(md).toContain('## 1. Implement Widget\n');
      expect(md).not.toContain('## Tasks');
      // Subtask headings
      expect(md).toContain('### 1.1 Write Failing Test\n');
      expect(md).toContain('### 1.2 Implement Widget\n');
      // Code blocks
      expect(md).toContain('```typescript\nexpect(new Widget()).toBeDefined();\n```');
      expect(md).toContain('```typescript\nexport class Widget {}\n```');
    });
  });

  describe('root-level arrays', () => {
    it('renders primitive array as bullet list', () => {
      const md = renderToMarkdown(['apple', 'banana', 'cherry']);
      expect(md).toContain('- apple');
      expect(md).toContain('- banana');
      expect(md).toContain('- cherry');
    });

    it('renders named object array as numbered sections', () => {
      const md = renderToMarkdown([
        { name: 'First', description: 'One' },
        { name: 'Second', description: 'Two' },
      ]);
      expect(md).toContain('# 1. First');
      expect(md).toContain('# 2. Second');
      expect(md).toContain('One');
      expect(md).toContain('Two');
    });

    it('renders plain object array as pipe table', () => {
      const md = renderToMarkdown([
        { path: 'src/a.ts', action: 'create' },
        { path: 'src/b.ts', action: 'edit' },
      ]);
      expect(md).toContain('| Path | Action |');
      expect(md).toContain('| src/a.ts | create |');
      expect(md).toContain('| src/b.ts | edit |');
    });

    it('renders empty array as empty string', () => {
      expect(renderToMarkdown([])).toBe('');
    });
  });

  describe('$schema stripping', () => {
    it('omits $schema field from rendered output', () => {
      const md = renderToMarkdown({
        $schema: 'plan',
        name: 'My Doc',
        goal: 'Do stuff',
      });
      expect(md).toContain('# My Doc');
      expect(md).toContain('Do stuff');
      expect(md).not.toContain('$schema');
      expect(md).not.toContain('plan');
    });

    it('renders all other fields normally alongside $schema', () => {
      const md = renderToMarkdown({
        $schema: 'plan',
        name: 'Title',
        meta: { version: '1.0.0' },
        summary: 'A summary',
      });
      expect(md).toContain('# Title');
      expect(md).toContain('---');
      expect(md).toContain('version:');
      expect(md).toContain('A summary');
      expect(md).not.toContain('$schema');
    });
  });
});
