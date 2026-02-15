import { resolveForValue } from '../../src/runbook/source-resolver.js';
import type { ForContext } from '../../src/runbook/types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('resolveForValue', () => {
  describe('range source', () => {
    it('returns resolved with iteration as string value', async () => {
      const fc: ForContext = {
        stepId: '1',
        iteration: 3,
        start: 1,
        end: 5,
        variable: 'i',
        implicit: false,
        source: { kind: 'range' },
      };

      const result = await resolveForValue(fc);

      expect(result.kind).toBe('resolved');
      expect(result).toEqual({
        kind: 'resolved',
        context: { ...fc, currentValue: '3' },
      });
    });
  });

  describe('array source', () => {
    it('returns resolved with value at 1-based index', async () => {
      const fc: ForContext = {
        stepId: '1',
        iteration: 2,
        start: 1,
        end: 3,
        variable: 'item',
        implicit: false,
        source: { kind: 'array', items: ['alpha', 'beta', 'gamma'] },
      };

      const result = await resolveForValue(fc);

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.context.currentValue).toBe('beta');
      }
    });

    it('returns exhausted when index is out of bounds', async () => {
      const fc: ForContext = {
        stepId: '1',
        iteration: 4,
        start: 1,
        end: 10,
        variable: 'item',
        implicit: false,
        source: { kind: 'array', items: ['alpha', 'beta', 'gamma'] },
      };

      const result = await resolveForValue(fc);

      expect(result.kind).toBe('exhausted');
      if (result.kind === 'exhausted') {
        expect(result.capped.end).toBe(4);
      }
    });
  });

  describe('file source', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-sr-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns resolved with value and snapshot for file with content', async () => {
      const file = path.join(tmpDir, 'data.txt');
      await fs.writeFile(file, 'first\nsecond\nthird\n');

      const fc: ForContext = {
        stepId: '1',
        iteration: 1,
        start: 1,
        implicit: false,
        source: { kind: 'file', path: file, format: 'text', snapshot: null },
      };

      const result = await resolveForValue(fc);

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.context.currentValue).toBe('first');
        expect(result.context.source.kind).toBe('file');
        if (result.context.source.kind === 'file') {
          expect(result.context.source.snapshot).toBeDefined();
          expect(result.context.source.snapshot?.line).toBe(1);
        }
      }
    });

    it('returns exhausted for empty file', async () => {
      const file = path.join(tmpDir, 'empty.txt');
      await fs.writeFile(file, '');

      const fc: ForContext = {
        stepId: '1',
        iteration: 1,
        start: 1,
        implicit: false,
        source: { kind: 'file', path: file, format: 'text', snapshot: null },
      };

      const result = await resolveForValue(fc);

      expect(result.kind).toBe('exhausted');
      if (result.kind === 'exhausted') {
        expect(result.capped.end).toBe(1);
      }
    });

    describe('jsonl format', () => {
      it('parses JSONL line to object in currentValue', async () => {
        const file = path.join(tmpDir, 'data.jsonl');
        await fs.writeFile(file, '{"id": 1, "name": "Alice"}\n{"id": 2, "name": "Bob"}\n');

        const fc: ForContext = {
          stepId: '1',
          iteration: 1,
          start: 1,
          implicit: false,
          source: { kind: 'file', path: file, format: 'jsonl', snapshot: null },
        };

        const result = await resolveForValue(fc);

        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') {
          expect(result.context.currentValue).toEqual({ id: 1, name: 'Alice' });
          expect(result.context.source.kind).toBe('file');
          if (result.context.source.kind === 'file') {
            expect(result.context.source.snapshot).toBeDefined();
            expect(result.context.source.snapshot?.line).toBe(1);
          }
        }
      });

      it('parses JSONL line to non-object JSON values (number)', async () => {
        const file = path.join(tmpDir, 'numbers.jsonl');
        await fs.writeFile(file, '42\n100\n');

        const fc: ForContext = {
          stepId: '1',
          iteration: 1,
          start: 1,
          implicit: false,
          source: { kind: 'file', path: file, format: 'jsonl', snapshot: null },
        };

        const result = await resolveForValue(fc);

        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') {
          expect(result.context.currentValue).toBe(42);
        }
      });

      it('parses JSONL line to non-object JSON values (array)', async () => {
        const file = path.join(tmpDir, 'arrays.jsonl');
        await fs.writeFile(file, '[1, 2, 3]\n[4, 5, 6]\n');

        const fc: ForContext = {
          stepId: '1',
          iteration: 2,
          start: 1,
          implicit: false,
          source: { kind: 'file', path: file, format: 'jsonl', snapshot: null },
        };

        const result = await resolveForValue(fc);

        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') {
          expect(result.context.currentValue).toEqual([4, 5, 6]);
        }
      });

      it('throws error on invalid JSONL line with file path and iteration index', async () => {
        const file = path.join(tmpDir, 'invalid.jsonl');
        await fs.writeFile(file, '{"valid": true}\n{invalid json}\n');

        const fc: ForContext = {
          stepId: '1',
          iteration: 2,
          start: 1,
          implicit: false,
          source: { kind: 'file', path: file, format: 'jsonl', snapshot: null },
        };

        const err = await resolveForValue(fc).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        const message = (err as Error).message;
        expect(message).toContain(file);
        expect(message).toContain('2');
        expect(message).toContain('invalid json');
      });

      it('parses JSONL null value correctly and renders via JSON.stringify', async () => {
        const file = path.join(tmpDir, 'nulls.jsonl');
        await fs.writeFile(file, 'null\nnull\n');

        const fc: ForContext = {
          stepId: '1',
          iteration: 1,
          start: 1,
          implicit: false,
          source: { kind: 'file', path: file, format: 'jsonl', snapshot: null },
        };

        const result = await resolveForValue(fc);

        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') {
          expect(result.context.currentValue).toBe(null);
          expect(JSON.stringify(result.context.currentValue)).toBe('null');
        }
      });

      it('text format remains unchanged (string values)', async () => {
        const file = path.join(tmpDir, 'text.txt');
        await fs.writeFile(file, 'plain text line 1\nplain text line 2\n');

        const fc: ForContext = {
          stepId: '1',
          iteration: 1,
          start: 1,
          implicit: false,
          source: { kind: 'file', path: file, format: 'text', snapshot: null },
        };

        const result = await resolveForValue(fc);

        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') {
          expect(result.context.currentValue).toBe('plain text line 1');
          expect(typeof result.context.currentValue).toBe('string');
        }
      });
    });
  });
});
