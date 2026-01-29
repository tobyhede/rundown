import { describe, it, expect } from '@jest/globals';
import { TextRenderer } from '../../../src/services/renderers/text-renderer.js';
import type { OutputWriter, DetailOutput } from '@rundown-org/core';

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
  });
});
