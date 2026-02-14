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
  });
});
