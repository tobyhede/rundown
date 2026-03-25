import { describe, it, expect } from '@jest/globals';
import { createRunbook } from './test-utils.js';

describe('createRunbook', () => {
  describe('basic rendering', () => {
    it('renders minimal runbook with default title', () => {
      const md = createRunbook({
        steps: [{ title: 'Echo', pass: 'COMPLETE', command: 'rd echo hello' }],
      });
      expect(md).toContain('# Test');
      expect(md).toContain('## 1. Echo');
      expect(md).toContain('- PASS COMPLETE');
      expect(md).toContain('rd echo hello');
    });

    it('renders frontmatter with name and vars', () => {
      const md = createRunbook({
        name: 'my-runbook',
        vars: { env: 'staging', port: 3000 },
        steps: [{ title: 'Deploy', pass: 'COMPLETE' }],
      });
      expect(md).toContain('---');
      expect(md).toContain('name: my-runbook');
      expect(md).toContain('  env: staging');
      expect(md).toContain('  port: 3000');
    });

    it('renders custom title', () => {
      const md = createRunbook({
        title: 'Deploy Pipeline',
        steps: [{ title: 'Start' }],
      });
      expect(md).toContain('# Deploy Pipeline');
    });

    it('renders step content', () => {
      const md = createRunbook({
        steps: [{ title: 'Review', content: 'Check the PR carefully.' }],
      });
      expect(md).toContain('Check the PR carefully.');
    });
  });

  describe('transitions and aggregation', () => {
    it('adds ALL/ANY qualifiers for steps with substeps', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Review',
            pass: 'CONTINUE',
            substeps: [{ title: 'Sub A' }],
          },
        ],
      });
      expect(md).toContain('- PASS ALL CONTINUE');
      expect(md).toContain('- FAIL ANY STOP');
    });

    it('auto-generates complement transition', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Loop',
            fail: 'STOP',
            for: { variable: 'i', start: 1, end: 3 },
            substeps: [{ title: 'Item' }],
          },
        ],
      });
      expect(md).toContain('- PASS ALL CONTINUE');
      expect(md).toContain('- FAIL ANY STOP');
    });

    it('does not add qualifiers for simple steps', () => {
      const md = createRunbook({
        steps: [{ title: 'Echo', pass: 'COMPLETE', fail: 'STOP' }],
      });
      expect(md).toContain('- PASS COMPLETE');
      expect(md).toContain('- FAIL STOP');
      expect(md).not.toContain('ALL');
      expect(md).not.toContain('ANY');
    });
  });

  describe('named steps (id field)', () => {
    it('renders named step with custom id', () => {
      const md = createRunbook({
        steps: [{ id: 'ErrorHandler', title: 'Handle errors' }],
      });
      expect(md).toContain('## ErrorHandler. Handle errors');
    });

    it('uses named id for substep numbering', () => {
      const md = createRunbook({
        steps: [
          {
            id: 'ErrorHandler',
            title: 'Handle errors',
            pass: 'COMPLETE',
            substeps: [{ title: 'Log error' }, { title: 'Notify' }],
          },
        ],
      });
      expect(md).toContain('### ErrorHandler.1 Log error');
      expect(md).toContain('### ErrorHandler.2 Notify');
    });

    it('does not consume numeric counter for named steps', () => {
      const md = createRunbook({
        steps: [
          { title: 'Setup', pass: 'GOTO ErrorHandler', command: 'rd echo setup' },
          { id: 'ErrorHandler', title: 'Handle errors', command: 'rd echo error' },
          { title: 'Cleanup', command: 'rd echo cleanup' },
        ],
      });
      expect(md).toContain('## 1. Setup');
      expect(md).toContain('## ErrorHandler. Handle errors');
      expect(md).toContain('## 2. Cleanup');
      // Must NOT produce ## 3.
      expect(md).not.toContain('## 3.');
    });
  });

  describe('FOR clause: numeric range', () => {
    it('renders named numeric range', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Loop',
            for: { variable: 'batch', start: 1, end: 5 },
            pass: 'CONTINUE',
            substeps: [{ title: 'Item' }],
          },
        ],
      });
      expect(md).toContain('- FOR batch IN 1 TO 5');
    });

    it('defaults variable to i', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Loop',
            for: { start: 1, end: 3 },
            pass: 'CONTINUE',
            substeps: [{ title: 'Item' }],
          },
        ],
      });
      expect(md).toContain('- FOR i IN 1 TO 3');
    });

    it('supports template variable bounds', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Loop',
            for: { variable: 'i', start: 1, end: '{{Max}}' },
            pass: 'CONTINUE',
            substeps: [{ title: 'Item' }],
          },
        ],
      });
      expect(md).toContain('- FOR i IN 1 TO {{Max}}');
    });
  });

  describe('FOR clause: single count', () => {
    it('renders unnamed count', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Loop',
            for: { count: 5 },
            pass: 'CONTINUE',
            substeps: [{ title: 'Item' }],
          },
        ],
      });
      expect(md).toContain('- FOR 5');
    });

    it('renders named count', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Loop',
            for: { variable: 'batch', count: 5 },
            pass: 'CONTINUE',
            substeps: [{ title: 'Item' }],
          },
        ],
      });
      expect(md).toContain('- FOR batch IN 5');
    });
  });

  describe('FOR clause: data source', () => {
    it('renders full source', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Process items',
            for: { source: 'items' },
            pass: 'CONTINUE',
            substeps: [{ title: 'Handle' }],
          },
        ],
      });
      expect(md).toContain('- FOR i IN {{ items }}');
    });

    it('renders full source with named variable', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Process servers',
            for: { variable: 'server', source: 'servers' },
            pass: 'CONTINUE',
            substeps: [{ title: 'Handle' }],
          },
        ],
      });
      expect(md).toContain('- FOR server IN {{ servers }}');
    });

    it('renders windowed source', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Process items',
            for: { start: 2, end: 4, source: 'items' },
            pass: 'CONTINUE',
            substeps: [{ title: 'Handle' }],
          },
        ],
      });
      expect(md).toContain('- FOR i IN 2 TO 4 OF {{ items }}');
    });

    it('renders windowed source with named variable', () => {
      const md = createRunbook({
        steps: [
          {
            title: 'Process items',
            for: { variable: 'item', start: 2, end: 4, source: 'items' },
            pass: 'CONTINUE',
            substeps: [{ title: 'Handle' }],
          },
        ],
      });
      expect(md).toContain('- FOR item IN 2 TO 4 OF {{ items }}');
    });
  });

  describe('FOR clause: type-level validation', () => {
    it('rejects empty ForClauseConfig at compile time', () => {
      createRunbook({
        steps: [
          {
            title: 'Bad',
            // @ts-expect-error — empty object is not assignable to ForClauseConfig
            for: {},
            substeps: [{ title: 'Item' }],
          },
        ],
      });
    });

    it('rejects partial windowed source (start without end) at compile time', () => {
      createRunbook({
        steps: [
          {
            title: 'Bad',
            // @ts-expect-error — start without end is not assignable to ForClauseConfig
            for: { source: 'items', start: 2 },
            substeps: [{ title: 'Item' }],
          },
        ],
      });
    });

    it('rejects partial windowed source (end without start) at compile time', () => {
      createRunbook({
        steps: [
          {
            title: 'Bad',
            // @ts-expect-error — end without start is not assignable to ForClauseConfig
            for: { source: 'items', end: 4 },
            substeps: [{ title: 'Item' }],
          },
        ],
      });
    });

    it('rejects count with start/end at compile time', () => {
      createRunbook({
        steps: [
          {
            title: 'Bad',
            // @ts-expect-error — count is mutually exclusive with start/end
            for: { count: 5, start: 1, end: 5 },
            substeps: [{ title: 'Item' }],
          },
        ],
      });
    });

    it('rejects count with source at compile time', () => {
      createRunbook({
        steps: [
          {
            title: 'Bad',
            // @ts-expect-error — count is mutually exclusive with source
            for: { count: 5, source: 'items' },
            substeps: [{ title: 'Item' }],
          },
        ],
      });
    });

    it('rejects numeric range with only start at compile time', () => {
      createRunbook({
        steps: [
          {
            title: 'Bad',
            // @ts-expect-error — numeric range requires both start and end
            for: { start: 1 },
            substeps: [{ title: 'Item' }],
          },
        ],
      });
    });
  });
});
