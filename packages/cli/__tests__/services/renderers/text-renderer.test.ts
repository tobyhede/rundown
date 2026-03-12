import { describe, it, expect } from '@jest/globals';
import { TextRenderer } from '../../../src/services/renderers/text-renderer.js';
import type {
  OutputWriter,
  DetailOutput,
  ListOutput,
  RunbookEventV1,
  StepPosition,
} from '@rundown-org/core';

/**
 * Creates a mock OutputWriter that captures output for testing.
 */
function createMockWriter(): OutputWriter & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write: (text: string) => {
      lines.push(text);
    },
    writeLine: (text?: string) => {
      lines.push(text ?? '');
    },
    writeLines: (textLines: string[]) => {
      lines.push(...textLines);
    },
    writeError: (text: string) => {
      lines.push(text);
    },
    writeJson: (data: unknown, pretty?: boolean) => {
      lines.push(JSON.stringify(data, null, pretty ? 2 : undefined));
    },
  };
}

/** Helper to build a minimal EventEnvelope for RunbookEventV1 */
function envelope() {
  return {
    v: '1' as const,
    ts: new Date().toISOString(),
    runbookId: 'test-id',
    runbook: { name: 'test', path: '/test.md' },
    seq: 1,
  };
}

/** Row type for list rendering tests */
interface TestRow {
  name: string;
  status: string;
}

/** Helper to build a StepPosition */
function pos(current = '1', total = 3, substep?: string): StepPosition {
  return { current, total, substep };
}

describe('TextRenderer', () => {
  describe('renderDetail', () => {
    describe('object stringification (Issue A)', () => {
      it('formats nested objects as JSON instead of [object Object]', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        const event: DetailOutput = {
          type: 'detail',
          format: 'custom',
          data: {
            config: { nested: { value: 42 }, array: [1, 2, 3] },
          },
        };

        renderer.render(event);

        const output = writer.lines.join('\n');
        // Should NOT contain [object Object]
        expect(output).not.toContain('[object Object]');
        // Should contain the JSON representation
        expect(output).toContain('nested');
        expect(output).toContain('42');
      });

      it('formats simple objects as JSON', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        const event: DetailOutput = {
          type: 'detail',
          format: 'custom',
          data: {
            metadata: { key: 'value' },
          },
        };

        renderer.render(event);

        const output = writer.lines.join('\n');
        expect(output).not.toContain('[object Object]');
        expect(output).toContain('key');
        expect(output).toContain('value');
      });
    });

    describe('BigInt and circular reference handling (Issue B)', () => {
      it('handles BigInt values without throwing', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        const event: DetailOutput = {
          type: 'detail',
          format: 'custom',
          data: {
            largeNumber: BigInt(9007199254740991),
          },
        };

        // Should not throw
        expect(() => {
          renderer.render(event);
        }).not.toThrow();

        // Should have some output (the BigInt stringified)
        const output = writer.lines.join('\n');
        expect(output).toContain('LargeNumber:');
        expect(output).toContain('9007199254740991');
      });

      it('handles circular references without throwing', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        // Create a circular reference
        const circular: Record<string, unknown> = { name: 'test' };
        circular.self = circular;

        const event: DetailOutput = {
          type: 'detail',
          format: 'custom',
          data: {
            circular,
          },
        };

        // Should not throw
        expect(() => {
          renderer.render(event);
        }).not.toThrow();

        // Should have output with [circular] as fallback
        const output = writer.lines.join('\n');
        expect(output).toContain('[circular]');
      });
    });

    describe('echo format', () => {
      it('renders output text', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        renderer.render({
          type: 'detail',
          format: 'echo',
          data: { output: 'hello world', result: true },
        });

        expect(writer.lines).toContain('hello world');
      });

      it('renders error text', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        renderer.render({
          type: 'detail',
          format: 'echo',
          data: { error: 'something broke', result: false },
        });

        const output = writer.lines.join('\n');
        expect(output).toContain('Error:');
        expect(output).toContain('something broke');
      });
    });

    describe('prompt format', () => {
      it('wraps content in markdown fences', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        renderer.render({
          type: 'detail',
          format: 'prompt',
          data: { output: 'some content' },
        });

        expect(writer.lines[0]).toBe('```');
        expect(writer.lines[1]).toBe('some content');
        expect(writer.lines[2]).toBe('```');
      });
    });

    describe('check format', () => {
      it('renders PASS with step count', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        renderer.render({
          type: 'detail',
          format: 'check',
          data: { valid: true, stats: { steps: 5, substeps: 2 } },
        });

        const output = writer.lines.join('\n');
        expect(output).toContain('PASS');
        expect(output).toContain('5');
      });

      it('renders FAIL with error count and details', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        renderer.render({
          type: 'detail',
          format: 'check',
          data: {
            valid: false,
            errors: [{ line: 10, message: 'Missing step header' }, { message: 'Invalid command' }],
          },
        });

        const output = writer.lines.join('\n');
        expect(output).toContain('FAIL');
        expect(output).toContain('2 errors');
        expect(output).toContain('Line 10');
        expect(output).toContain('Missing step header');
        expect(output).toContain('Invalid command');
      });
    });

    describe('resolve format', () => {
      it('renders PASS with variables', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        renderer.render({
          type: 'detail',
          format: 'resolve',
          data: {
            valid: true,
            errors: [],
            stats: { steps: 3, substeps: 2 },
            variables: { environment: 'staging', port: '3000' },
          },
        });

        const output = writer.lines.join('\n');
        expect(output).toContain('PASS');
        expect(output).toContain('3 steps');
        expect(output).toContain('Variables:');
        expect(output).toContain('environment');
        expect(output).toContain('staging');
        expect(output).toContain('port');
        expect(output).toContain('3000');
      });

      it('renders FAIL with errors and variables', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        renderer.render({
          type: 'detail',
          format: 'resolve',
          data: {
            valid: false,
            errors: [{ message: 'Step numbering error' }],
            stats: { steps: 1, substeps: 0 },
            variables: { name: 'test' },
          },
        });

        const output = writer.lines.join('\n');
        expect(output).toContain('FAIL');
        expect(output).toContain('Step numbering error');
        expect(output).toContain('Variables:');
        expect(output).toContain('name');
      });

      it('renders sources section', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        renderer.render({
          type: 'detail',
          format: 'resolve',
          data: {
            valid: true,
            errors: [],
            stats: { steps: 1, substeps: 1 },
            variables: {},
            sources: {
              items: { kind: 'array', items: 3 },
              hosts: { kind: 'file', path: 'data/hosts.txt', format: 'text' },
            },
          },
        });

        const output = writer.lines.join('\n');
        expect(output).toContain('Sources:');
        expect(output).toContain('items');
        expect(output).toContain('array (3 items)');
        expect(output).toContain('hosts');
        expect(output).toContain('file (data/hosts.txt, text)');
      });

      it('renders unresolved variables section', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        renderer.render({
          type: 'detail',
          format: 'resolve',
          data: {
            valid: true,
            errors: [],
            stats: { steps: 1, substeps: 0 },
            variables: {},
            unresolved: ['missingVar', 'otherVar'],
          },
        });

        const output = writer.lines.join('\n');
        expect(output).toContain('Unresolved:');
        expect(output).toContain('{{missingVar}}');
        expect(output).toContain('{{otherVar}}');
      });

      it('omits empty sections', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        renderer.render({
          type: 'detail',
          format: 'resolve',
          data: {
            valid: true,
            errors: [],
            stats: { steps: 1, substeps: 0 },
            variables: {},
          },
        });

        const output = writer.lines.join('\n');
        expect(output).not.toContain('Sources:');
        expect(output).not.toContain('Unresolved:');
      });

      it('excludes warnings with kind "unresolved" from general warnings section', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        renderer.render({
          type: 'detail',
          format: 'resolve',
          data: {
            valid: true,
            errors: [],
            stats: { steps: 1, substeps: 0 },
            variables: {},
            unresolved: ['missingVar'],
            warnings: [
              { message: 'Unresolved variable: {{missingVar}}', kind: 'unresolved' },
              { message: 'Some other warning', line: 5 },
            ],
          },
        });

        const output = writer.lines.join('\n');
        // Unresolved shown in dedicated section
        expect(output).toContain('Unresolved:');
        expect(output).toContain('{{missingVar}}');
        // Other warning still rendered
        expect(output).toContain('Some other warning');
        // The unresolved warning message should NOT appear in the general warnings area
        // (it's filtered by kind, shown only in the Unresolved section)
        const warningLines = writer.lines.filter(
          (l) => l.includes('Warning:') && l.includes('Unresolved variable:'),
        );
        expect(warningLines).toHaveLength(0);
      });

      it('renders warnings without kind normally', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        renderer.render({
          type: 'detail',
          format: 'resolve',
          data: {
            valid: true,
            errors: [],
            stats: { steps: 1, substeps: 0 },
            variables: {},
            warnings: [{ message: 'Deprecated syntax', line: 3 }],
          },
        });

        const output = writer.lines.join('\n');
        expect(output).toContain('Warning:');
        expect(output).toContain('Deprecated syntax');
      });

      it('renders structural warnings via renderStructuralResult (no kind)', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        renderer.render({
          type: 'detail',
          format: 'resolve',
          data: {
            valid: true,
            errors: [],
            stats: { steps: 2, substeps: 0 },
            variables: { env: 'prod' },
            warnings: [
              { message: 'Deprecated step syntax', line: 5 },
              { message: 'Unresolved variable: {{foo}}', kind: 'unresolved' },
            ],
          },
        });

        const output = writer.lines.join('\n');
        // Structural warning (no kind) should appear
        expect(output).toContain('Deprecated step syntax');
        // Unresolved warning should NOT appear in the structural section
        // (it's rendered in the Unresolved section instead)
        const warningLines = writer.lines.filter((l) => l.includes('Warning:'));
        // Only the structural warning should be rendered as a Warning: line
        expect(warningLines).toHaveLength(1);
        expect(warningLines[0]).toContain('Deprecated step syntax');
      });
    });

    describe('scenario format', () => {
      it('renders name, description, expected, and tags', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        renderer.render({
          type: 'detail',
          format: 'scenario',
          data: {
            name: 'happy-path',
            description: 'Test the happy path',
            expected: 'COMPLETE',
            tags: ['smoke', 'ci'],
          },
        });

        const output = writer.lines.join('\n');
        expect(output).toContain('happy-path');
        expect(output).toContain('Test the happy path');
        expect(output).toContain('COMPLETE');
        expect(output).toContain('smoke, ci');
      });
    });

    describe('scenario_result format', () => {
      it('renders pass result', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        renderer.render({
          type: 'detail',
          format: 'scenario_result',
          data: { result: true, actual: 'COMPLETE' },
        });

        const output = writer.lines.join('\n');
        expect(output).toContain('COMPLETE');
      });

      it('renders fail result with expected vs actual', () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        renderer.render({
          type: 'detail',
          format: 'scenario_result',
          data: { result: false, expected: 'COMPLETE', actual: 'STOPPED' },
        });

        const output = writer.lines.join('\n');
        expect(output).toContain('STOPPED');
        expect(output).toContain('Expected: COMPLETE');
        expect(output).toContain('Actual:   STOPPED');
      });
    });
  });

  describe('renderList', () => {
    it('renders table from items and columns', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      const event: ListOutput<TestRow> = {
        type: 'list',
        items: [
          { name: 'foo', status: 'active' },
          { name: 'bar', status: 'done' },
        ],
        columns: [
          { header: 'Name', key: 'name' },
          { header: 'Status', key: 'status' },
        ],
      };

      renderer.render(event);

      const output = writer.lines.join('\n');
      expect(output).toContain('NAME');
      expect(output).toContain('STATUS');
      expect(output).toContain('foo');
      expect(output).toContain('bar');
    });

    it('renders emptyMessage when items array is empty', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      const event: ListOutput<TestRow> = {
        type: 'list',
        items: [],
        columns: [{ header: 'Name', key: 'name' }],
        emptyMessage: 'No items found.',
      };

      renderer.render(event);

      expect(writer.lines).toContain('No items found.');
    });

    it('renders nothing when items are empty and no emptyMessage', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      const event: ListOutput<TestRow> = {
        type: 'list',
        items: [],
        columns: [{ header: 'Name', key: 'name' }],
      };

      renderer.render(event);

      expect(writer.lines).toHaveLength(0);
    });
  });

  describe('renderMessage', () => {
    const levels = ['success', 'warning', 'error', 'info', 'dim'] as const;

    for (const level of levels) {
      it(`renders ${level} level message`, () => {
        const writer = createMockWriter();
        const renderer = new TextRenderer({ writer });

        renderer.render({
          type: 'message',
          text: `A ${level} message`,
          level,
        });

        const output = writer.lines.join('\n');
        expect(output).toContain(`A ${level} message`);
      });
    }
  });

  describe('renderError', () => {
    it('renders error text', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      renderer.render({
        type: 'error',
        message: 'Something went wrong',
      });

      const output = writer.lines.join('\n');
      expect(output).toContain('Error:');
      expect(output).toContain('Something went wrong');
    });

    it('renders error with code', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      renderer.render({
        type: 'error',
        message: 'Not found',
        code: 'ERR_NOT_FOUND',
      });

      const output = writer.lines.join('\n');
      expect(output).toContain('Error:');
      expect(output).toContain('Not found');
      expect(output).toContain('Code: ERR_NOT_FOUND');
    });
  });

  describe('renderStatus', () => {
    it('renders stash action with position', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      renderer.render({
        type: 'status',
        action: 'stash',
        data: { position: pos('2', 5) },
      });

      const output = writer.lines.join('\n');
      // printRunbookStashed renders something about stash
      expect(output.length).toBeGreaterThan(0);
    });

    it('renders pop success with step data', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      renderer.render({
        type: 'status',
        action: 'pop',
        data: {
          position: pos('1', 3),
          step: { name: 'Build project', description: 'Run build', prompted: false },
        },
      });

      const output = writer.lines.join('\n');
      expect(output).toContain('Build project');
    });

    it('renders pop failure as error', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      renderer.render({
        type: 'error',
        message: 'No stashed runbook found',
        code: 'NO_STASHED_RUNBOOK',
      });

      const output = writer.lines.join('\n');
      expect(output).toContain('No stashed runbook found');
    });
  });

  describe('execution events', () => {
    it('renders RUNBOOK_STARTED', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      const event: RunbookEventV1 = {
        ...envelope(),
        type: 'RUNBOOK_STARTED',
        payload: {
          prompted: false,
          statePath: '.claude/rundown/runs/test.json',
        },
      };

      renderer.render({ type: 'execution_event', event });

      const output = writer.lines.join('\n');
      expect(output).toContain('test');
      expect(output).toContain('START');
    });

    it('renders STEP_ENTERED', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      const event: RunbookEventV1 = {
        ...envelope(),
        type: 'STEP_ENTERED',
        payload: {
          position: pos('1', 3),
          stepName: 'Install dependencies',
          description: 'Run npm install',
          hasCommand: true,
          commandCode: 'npm install',
          commandLang: 'bash',
          isSubstep: false,
          prompted: false,
        },
      };

      renderer.render({ type: 'execution_event', event });

      const output = writer.lines.join('\n');
      expect(output).toContain('Install dependencies');
    });

    it('renders COMMAND_STARTED', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      const event: RunbookEventV1 = {
        ...envelope(),
        type: 'COMMAND_STARTED',
        payload: {
          command: 'npm install',
          displayCommand: 'npm install',
          position: pos(),
        },
      };

      renderer.render({ type: 'execution_event', event });

      const output = writer.lines.join('\n');
      expect(output).toContain('npm install');
    });

    it('renders STEP_TRANSITIONED', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      const event: RunbookEventV1 = {
        ...envelope(),
        type: 'STEP_TRANSITIONED',
        payload: {
          action: 'CONTINUE',
          from: '1',
          at: '2',
          result: 'PASS',
        },
      };

      renderer.render({ type: 'execution_event', event });

      const output = writer.lines.join('\n');
      expect(output).toContain('CONTINUE');
    });

    it('renders POLICY_DENIED', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      const event: RunbookEventV1 = {
        ...envelope(),
        type: 'POLICY_DENIED',
        payload: {
          command: 'rm -rf /',
          reason: 'Blocked by policy',
          position: pos(),
        },
      };

      renderer.render({ type: 'execution_event', event });

      const output = writer.lines.join('\n');
      expect(output).toContain('rm -rf /');
    });

    it('renders ERROR_OCCURRED', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      const event: RunbookEventV1 = {
        ...envelope(),
        type: 'ERROR_OCCURRED',
        payload: {
          message: 'Command failed with exit code 1',
          code: 'EXEC_FAILED',
        },
      };

      renderer.render({ type: 'execution_event', event });

      const output = writer.lines.join('\n');
      expect(output).toContain('Error: Command failed with exit code 1');
      expect(output).toContain('Code: EXEC_FAILED');
    });
  });

  describe('delegation display in status detail', () => {
    it('renders delegations section when present', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      const event: DetailOutput = {
        type: 'detail',
        data: {
          active: true,
          stashed: false,
          file: 'parent.md',
          state: 'running',
          position: { current: '1', total: 2 },
          step: { name: '1', description: 'Review' },
          delegations: [
            { substep: '1.1', runbook: 'review-code.md', state: 'pending' },
            { substep: '1.2', runbook: 'review-tests.md', state: 'claimed', childRunId: 'run_abc' },
            { substep: '1.3', runbook: 'review-security.md', state: 'cancelled' },
          ],
        },
        format: 'status',
      };

      renderer.render(event);
      const output = writer.lines.join('\n');

      expect(output).toContain('Delegations:');
      expect(output).toContain('1.1');
      expect(output).toContain('review-code.md');
      expect(output).toContain('(pending claim)');
      expect(output).toContain('1.2');
      expect(output).toContain('(claimed: run_abc)');
      expect(output).toContain('1.3');
      expect(output).toContain('(cancelled)');
    });

    it('does not render delegations section when absent', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      const event: DetailOutput = {
        type: 'detail',
        data: {
          active: true,
          stashed: false,
          file: 'parent.md',
          state: 'running',
          position: { current: '1', total: 2 },
          step: { name: '1', description: 'Review' },
        },
        format: 'status',
      };

      renderer.render(event);
      const output = writer.lines.join('\n');

      expect(output).not.toContain('Delegations:');
    });

    it('does not render delegations section when empty', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      const event: DetailOutput = {
        type: 'detail',
        data: {
          active: true,
          stashed: false,
          file: 'parent.md',
          state: 'running',
          position: { current: '1', total: 2 },
          step: { name: '1', description: 'Review' },
          delegations: [],
        },
        format: 'status',
      };

      renderer.render(event);
      const output = writer.lines.join('\n');

      expect(output).not.toContain('Delegations:');
    });
  });

  describe('flush', () => {
    it('is a no-op', () => {
      const writer = createMockWriter();
      const renderer = new TextRenderer({ writer });

      // Should not throw and should not produce output
      renderer.flush();
      expect(writer.lines).toHaveLength(0);
    });
  });
});
