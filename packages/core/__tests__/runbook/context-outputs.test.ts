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

    it('refuses to read when context dir is a symlink that escapes contextsDir', async () => {
      const escapeTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-escape-'));
      try {
        await fs.writeFile(
          path.join(escapeTarget, 'outputs.json'),
          JSON.stringify({ Injected: 'evil-value' }),
          'utf-8',
        );

        const ctxRoot = contextsDir(tmpDir);
        await fs.mkdir(ctxRoot, { recursive: true });
        const contextDir = path.join(ctxRoot, 'evil-id');
        await fs.symlink(escapeTarget, contextDir, 'dir');

        await expect(loadContextOutputs(tmpDir, 'evil-id')).rejects.toThrow(
          /escapes contexts directory/,
        );
      } finally {
        await fs.rm(escapeTarget, { recursive: true, force: true });
      }
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

    it('storeContextOutputs rejects when context dir is swapped for an escaping symlink between calls', async () => {
      // Test Layer B defense: inode check bracketing the mkdir→rename window.
      // 1. Call storeContextOutputs (succeeds, creates .rundown/contexts/ctx-a/)
      // 2. Delete the context dir and replace with escape symlink
      // 3. Call storeContextOutputs again (should detect swap and reject)
      const escapeTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-escape-'));
      try {
        // First call succeeds normally
        await storeContextOutputs(tmpDir, 'ctx-a', { Foo: 'one' });

        // Verify the first write succeeded
        const result = await loadContextOutputs(tmpDir, 'ctx-a');
        expect(result).toEqual({ Foo: 'one' });

        // Remove the real context directory and replace with escape symlink
        const ctxRoot = contextsDir(tmpDir);
        const contextDir = path.join(ctxRoot, 'ctx-a');
        await fs.rm(contextDir, { recursive: true });
        await fs.symlink(escapeTarget, contextDir, 'dir');

        // Second call should detect the swap and reject
        await expect(storeContextOutputs(tmpDir, 'ctx-a', { Foo: 'two' })).rejects.toThrow(
          /was replaced during write|escapes contexts directory/,
        );

        // Verify the escape target was not written to (outputs.json should not exist there)
        const escapeOutputsPath = path.join(escapeTarget, 'outputs.json');
        await expect(fs.readFile(escapeOutputsPath)).rejects.toThrow();
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

    it('storeContextOutputs rejects when final outputs.json is a pre-planted symlink', async () => {
      // Test Layer B defense: post-rename symlink detection and escape validation.
      // 1. Create the real context directory
      // 2. Plant an escape symlink at the outputs.json path
      // 3. Call storeContextOutputs (should detect escape and reject)
      const escapeTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-escape-'));
      try {
        // Create escape target (a simple file that would be written to if the symlink was followed)
        const escapeOutputsFile = path.join(escapeTarget, 'outputs.json');
        await fs.writeFile(escapeOutputsFile, 'initial content', 'utf-8');

        // Pre-create the context directory as a real directory
        const ctxRoot = contextsDir(tmpDir);
        const contextDir = path.join(ctxRoot, 'ctx-b');
        await fs.mkdir(contextDir, { recursive: true, mode: 0o700 });

        // Plant a symlink at the outputs.json path pointing to the escape target
        const outputsPath = path.join(contextDir, 'outputs.json');
        await fs.symlink(escapeOutputsFile, outputsPath);

        // Call storeContextOutputs — it should detect the escape and reject
        await expect(storeContextOutputs(tmpDir, 'ctx-b', { Foo: 'one' })).rejects.toThrow(
          /escapes contexts directory|replaced/,
        );

        // Verify the escape target was not overwritten with new outputs
        const escapeContent = await fs.readFile(escapeOutputsFile, 'utf-8');
        expect(escapeContent).toBe('initial content');
      } finally {
        await fs.rm(escapeTarget, { recursive: true, force: true });
      }
    });
  });
});
