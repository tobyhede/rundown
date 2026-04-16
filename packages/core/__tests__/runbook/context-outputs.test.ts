import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadContextOutputs, storeContextOutputs } from '../../src/runbook/context-outputs.js';
import { contextOutputsPath, contextsDir } from '../../src/paths.js';

describe('context-outputs', () => {
  let tmpDir: string;
  const contextId = 'ctx-test-1';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-ctx-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('loadContextOutputs', () => {
    it('returns empty object when outputs file does not exist', async () => {
      const result = await loadContextOutputs(tmpDir, contextId);
      expect(result).toEqual({});
    });

    it('reads and returns stored outputs when file exists', async () => {
      const filePath = contextOutputsPath(tmpDir, contextId);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify({ PlanPath: '/tmp/plan.json', Region: 'us-west' }),
        'utf-8',
      );

      const result = await loadContextOutputs(tmpDir, contextId);
      expect(result).toEqual({ PlanPath: '/tmp/plan.json', Region: 'us-west' });
    });

    it('filters non-string values from stored outputs', async () => {
      const filePath = contextOutputsPath(tmpDir, contextId);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify({ PlanPath: '/tmp/plan.json', Count: 42, Active: true }),
        'utf-8',
      );

      const result = await loadContextOutputs(tmpDir, contextId);
      expect(result).toEqual({ PlanPath: '/tmp/plan.json' });
    });

    it('throws when stored file contains malformed JSON', async () => {
      const filePath = contextOutputsPath(tmpDir, contextId);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'not valid json {{{', 'utf-8');

      await expect(loadContextOutputs(tmpDir, contextId)).rejects.toThrow();
    });

    it.each([
      ['array', '[1,2,3]'],
      ['null', 'null'],
      ['string primitive', '"hello"'],
      ['number primitive', '42'],
      ['boolean primitive', 'true'],
    ])('throws a descriptive error when outputs.json has top-level shape: %s', async (_label, raw) => {
      const filePath = contextOutputsPath(tmpDir, contextId);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, raw, 'utf-8');

      await expect(loadContextOutputs(tmpDir, contextId)).rejects.toThrow(/outputs\.json.*shape/);
    });
  });

  describe('storeContextOutputs', () => {
    it('creates the directory and file when they do not exist', async () => {
      await storeContextOutputs(tmpDir, contextId, { PlanPath: '/tmp/plan.json' });

      const filePath = contextOutputsPath(tmpDir, contextId);
      const raw = await fs.readFile(filePath, 'utf-8');
      expect(JSON.parse(raw)).toEqual({ PlanPath: '/tmp/plan.json' });
    });

    it('merges new outputs with existing outputs on disk', async () => {
      await storeContextOutputs(tmpDir, contextId, { PlanPath: '/tmp/plan.json' });
      await storeContextOutputs(tmpDir, contextId, { Region: 'us-west' });

      const result = await loadContextOutputs(tmpDir, contextId);
      expect(result).toEqual({
        PlanPath: '/tmp/plan.json',
        Region: 'us-west',
      });
    });

    it('overwrites existing values when the same key is published again', async () => {
      await storeContextOutputs(tmpDir, contextId, { PlanPath: '/old/path.json' });
      await storeContextOutputs(tmpDir, contextId, { PlanPath: '/new/path.json' });

      const result = await loadContextOutputs(tmpDir, contextId);
      expect(result).toEqual({ PlanPath: '/new/path.json' });
    });
  });

  describe('round-trip', () => {
    it('store then load returns the same values', async () => {
      const payload = {
        PlanPath: '/tmp/plan.json',
        Region: 'us-west',
        Version: '1.2.3',
      };
      await storeContextOutputs(tmpDir, contextId, payload);

      const result = await loadContextOutputs(tmpDir, contextId);
      expect(result).toEqual(payload);
    });
  });

  describe('concurrency', () => {
    it('concurrent writes from two callers both survive (no key lost)', async () => {
      // Both writes race — the file lock serializes them so neither overwrites the other
      await Promise.all([
        storeContextOutputs(tmpDir, contextId, { KeyA: 'valueA' }),
        storeContextOutputs(tmpDir, contextId, { KeyB: 'valueB' }),
      ]);

      const result = await loadContextOutputs(tmpDir, contextId);
      expect(result.KeyA).toBe('valueA');
      expect(result.KeyB).toBe('valueB');
    });

    it('sequential writes with overlapping keys: later write wins', async () => {
      // Awaited in sequence — the second call's value must be the one that persists.
      await storeContextOutputs(tmpDir, contextId, { Key: 'first' });
      await storeContextOutputs(tmpDir, contextId, { Key: 'second' });

      const result = await loadContextOutputs(tmpDir, contextId);
      expect(result.Key).toBe('second');
    });

    it('concurrent writes with overlapping keys: one writer wins, file stays valid', async () => {
      // Race two writes to the same key. The file lock serializes them, so the final
      // value is whichever call entered the critical section last — we don't care which,
      // just that the result is one of the two values and the file is not corrupted.
      await Promise.all([
        storeContextOutputs(tmpDir, contextId, { Key: 'first' }),
        storeContextOutputs(tmpDir, contextId, { Key: 'second' }),
      ]);

      const result = await loadContextOutputs(tmpDir, contextId);
      expect(['first', 'second']).toContain(result.Key);
    });

    it('refuses to write when context dir is a symlink that escapes contextsDir', async () => {
      // Pre-create the per-context dir as a symlink pointing outside .rundown/contexts/.
      // Without the realpath check, fs.writeFile + rename would silently follow it.
      const escapeTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-escape-'));
      try {
        const ctxRoot = contextsDir(tmpDir);
        await fs.mkdir(ctxRoot, { recursive: true });
        const contextDir = path.join(ctxRoot, 'evil-id');
        await fs.symlink(escapeTarget, contextDir, 'dir');

        await expect(storeContextOutputs(tmpDir, 'evil-id', { Key: 'v' })).rejects.toThrow(
          /escapes contexts directory/,
        );
      } finally {
        await fs.rm(escapeTarget, { recursive: true, force: true });
      }
    });

    it('N=10 concurrent writes all survive — no key lost under contention', async () => {
      // Without the file lock, interleaved read-merge-write would drop keys.
      // Each writer adds a unique key; all 10 must survive.
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          storeContextOutputs(tmpDir, contextId, { [`Key${String(i)}`]: `value${String(i)}` }),
        ),
      );

      const result = await loadContextOutputs(tmpDir, contextId);
      for (let i = 0; i < 10; i++) {
        expect(result[`Key${String(i)}`]).toBe(`value${String(i)}`);
      }
    });
  });
});
