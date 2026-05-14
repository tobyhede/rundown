import { resolveForValue } from '../../src/runbook/source-resolver.js';
import { createJsonArrayStream } from '../../src/runbook/types.js';
import type { ForContext, JsonArrayStream, TemplateVarValue } from '../../src/runbook/types.js';
import { canonicalProjectRootForTest } from '../helpers/canonical-paths.js';
import { brandInitialTemplateVarsForTest } from '../helpers/effective-vars.js';
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

  describe('variable source with JsonArray', () => {
    const makeContext = (iteration: number): ForContext => ({
      stepId: '1',
      iteration,
      start: 1,
      end: 3,
      variable: 'item',
      implicit: false,
      source: { kind: 'variable', name: 'items' },
    });

    it('returns resolved with value at 1-based index', async () => {
      const fc = makeContext(2);
      const vars: Record<string, TemplateVarValue> = {
        items: ['alpha', 'beta', 'gamma'],
      };

      const result = await resolveForValue(fc, brandInitialTemplateVarsForTest(vars));

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.context.currentValue).toBe('beta');
      }
    });

    it('returns exhausted when index is out of bounds', async () => {
      const fc: ForContext = {
        ...makeContext(4),
        end: 10,
      };
      const vars: Record<string, TemplateVarValue> = {
        items: ['alpha', 'beta', 'gamma'],
      };

      const result = await resolveForValue(fc, brandInitialTemplateVarsForTest(vars));

      expect(result.kind).toBe('exhausted');
      if (result.kind === 'exhausted') {
        expect(result.capped.end).toBe(4);
      }
    });

    it('supports typed array items (numbers, objects)', async () => {
      const fc = makeContext(1);
      const vars: Record<string, TemplateVarValue> = {
        items: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      };

      const result = await resolveForValue(fc, brandInitialTemplateVarsForTest(vars));

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.context.currentValue).toEqual({ id: 1, name: 'Alice' });
      }
    });

    it('throws for undefined variable', async () => {
      const fc = makeContext(1);

      await expect(resolveForValue(fc, brandInitialTemplateVarsForTest({}))).rejects.toThrow(
        /not defined/,
      );
    });

    it('throws for non-iterable variable type', async () => {
      const fc = makeContext(1);
      const vars: Record<string, TemplateVarValue> = { items: 'not-an-array' };

      await expect(resolveForValue(fc, brandInitialTemplateVarsForTest(vars))).rejects.toThrow(
        /Type error/,
      );
    });
  });

  describe('variable source with JsonArrayStream', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-sr-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    const makeContext = (iteration: number): ForContext => ({
      stepId: '1',
      iteration,
      start: 1,
      implicit: false,
      source: { kind: 'variable', name: 'data' },
    });

    it('returns resolved with value and snapshot for JSONL file', async () => {
      const file = path.join(tmpDir, 'data.jsonl');
      await fs.writeFile(file, '{"id": 1, "name": "Alice"}\n{"id": 2, "name": "Bob"}\n');
      const stream: JsonArrayStream = createJsonArrayStream(file);
      const vars: Record<string, TemplateVarValue> = { data: stream };

      const result = await resolveForValue(makeContext(1), brandInitialTemplateVarsForTest(vars));

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.context.currentValue).toEqual({ id: 1, name: 'Alice' });
        expect(result.context.snapshot).toBeDefined();
        expect(result.context.snapshot?.line).toBe(1);
      }
    });

    it('returns exhausted for empty file', async () => {
      const file = path.join(tmpDir, 'empty.jsonl');
      await fs.writeFile(file, '');
      const vars: Record<string, TemplateVarValue> = {
        data: createJsonArrayStream(file),
      };

      const result = await resolveForValue(makeContext(1), brandInitialTemplateVarsForTest(vars));

      expect(result.kind).toBe('exhausted');
      if (result.kind === 'exhausted') {
        expect(result.capped.end).toBe(1);
      }
    });

    it('parses JSONL line to non-object JSON values (number)', async () => {
      const file = path.join(tmpDir, 'numbers.jsonl');
      await fs.writeFile(file, '42\n100\n');
      const vars: Record<string, TemplateVarValue> = {
        data: createJsonArrayStream(file),
      };

      const result = await resolveForValue(makeContext(1), brandInitialTemplateVarsForTest(vars));

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.context.currentValue).toBe(42);
      }
    });

    it('parses JSONL line to non-object JSON values (array)', async () => {
      const file = path.join(tmpDir, 'arrays.jsonl');
      await fs.writeFile(file, '[1, 2, 3]\n[4, 5, 6]\n');
      const vars: Record<string, TemplateVarValue> = {
        data: createJsonArrayStream(file),
      };

      const result = await resolveForValue(makeContext(2), brandInitialTemplateVarsForTest(vars));

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.context.currentValue).toEqual([4, 5, 6]);
      }
    });

    it('throws error on invalid JSONL line with file path and iteration index', async () => {
      const file = path.join(tmpDir, 'invalid.jsonl');
      await fs.writeFile(file, '{"valid": true}\n{invalid json}\n');
      const vars: Record<string, TemplateVarValue> = {
        data: createJsonArrayStream(file),
      };

      const err = await resolveForValue(
        makeContext(2),
        brandInitialTemplateVarsForTest(vars),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toContain(file);
      expect(message).toContain('line 2');
      expect(message).toContain('invalid json');
    });

    it('parses JSONL null value correctly', async () => {
      const file = path.join(tmpDir, 'nulls.jsonl');
      await fs.writeFile(file, 'null\nnull\n');
      const vars: Record<string, TemplateVarValue> = {
        data: createJsonArrayStream(file),
      };

      const result = await resolveForValue(makeContext(1), brandInitialTemplateVarsForTest(vars));

      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.context.currentValue).toBe(null);
        expect(JSON.stringify(result.context.currentValue)).toBe('null');
      }
    });
  });

  describe('projectRoot boundary enforcement', () => {
    let projectRoot: string;
    let outsideFile: string;

    beforeEach(async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-sr-sec-'));
      const rawProjectRoot = path.join(base, 'project');
      await fs.mkdir(rawProjectRoot);
      projectRoot = await canonicalProjectRootForTest(rawProjectRoot);
      outsideFile = path.join(base, 'outside.jsonl');
      await fs.writeFile(outsideFile, '"secret"\n');
    });

    afterEach(async () => {
      await fs.rm(path.dirname(projectRoot), { recursive: true, force: true });
    });

    const makeContext = (name = 'data'): ForContext => ({
      stepId: '1',
      iteration: 1,
      start: 1,
      implicit: false,
      source: { kind: 'variable', name },
    });

    it('throws policy-violation when JsonArrayStream path escapes project root', async () => {
      const vars: Record<string, TemplateVarValue> = {
        data: createJsonArrayStream(outsideFile),
      };

      await expect(
        resolveForValue(makeContext(), brandInitialTemplateVarsForTest(vars), projectRoot),
      ).rejects.toMatchObject({
        code: 'policy-violation',
      });
    });

    it('succeeds when JsonArrayStream path is within project root', async () => {
      const file = path.join(projectRoot, 'data.jsonl');
      await fs.writeFile(file, '"value"\n');
      const vars: Record<string, TemplateVarValue> = {
        data: createJsonArrayStream(file),
      };

      const result = await resolveForValue(
        makeContext(),
        brandInitialTemplateVarsForTest(vars),
        projectRoot,
      );
      expect(result.kind).toBe('resolved');
    });

    it('throws policy-violation for sibling-prefix path (e.g. /base/project-evil)', async () => {
      // /base/project-evil/data.jsonl starts with the same string as projectRoot
      // (/base/project) but is NOT inside it. path.relative() returns
      // '../project-evil/data.jsonl' — the dotdot prefix is caught correctly.
      // This test documents and regression-guards that behaviour.
      const base = path.dirname(projectRoot); // e.g. /tmp/rundown-sr-sec-xxxxx
      const siblingDir = path.join(base, 'project-evil');
      await fs.mkdir(siblingDir, { recursive: true });
      const siblingFile = path.join(siblingDir, 'data.jsonl');
      await fs.writeFile(siblingFile, '"secret"\n');

      const vars: Record<string, TemplateVarValue> = {
        data: createJsonArrayStream(siblingFile),
      };

      await expect(
        resolveForValue(makeContext(), brandInitialTemplateVarsForTest(vars), projectRoot),
      ).rejects.toMatchObject({
        code: 'policy-violation',
      });
    });

    it('skips boundary check when projectRoot is omitted', async () => {
      const vars: Record<string, TemplateVarValue> = {
        data: createJsonArrayStream(outsideFile),
      };

      const result = await resolveForValue(makeContext(), brandInitialTemplateVarsForTest(vars));
      expect(result.kind).toBe('resolved');
    });
  });
});
