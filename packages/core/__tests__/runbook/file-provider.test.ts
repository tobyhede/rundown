import {
  createFileProvider,
  computeFileSnapshot,
  validateFileSnapshot,
} from '../../src/runbook/file-provider.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('FileProvider', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-fp-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('text format', () => {
    it('streams lines sequentially', async () => {
      const file = path.join(tmpDir, 'servers.txt');
      await fs.writeFile(file, 'alpha\nbeta\ngamma\n');

      const provider = await createFileProvider(file, 'text');
      const results: string[] = [];
      let item = await provider.next();
      while (!item.done) {
        results.push(item.value);
        item = await provider.next();
      }
      provider.close();

      expect(results).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('handles file without trailing newline', async () => {
      const file = path.join(tmpDir, 'hosts.txt');
      await fs.writeFile(file, 'host1\nhost2');

      const provider = await createFileProvider(file, 'text');
      const results: string[] = [];
      let item = await provider.next();
      while (!item.done) {
        results.push(item.value);
        item = await provider.next();
      }
      provider.close();

      expect(results).toEqual(['host1', 'host2']);
    });

    it('skips empty lines', async () => {
      const file = path.join(tmpDir, 'data.txt');
      await fs.writeFile(file, 'a\n\nb\n\n');

      const provider = await createFileProvider(file, 'text');
      const results: string[] = [];
      let item = await provider.next();
      while (!item.done) {
        results.push(item.value);
        item = await provider.next();
      }
      provider.close();

      expect(results).toEqual(['a', 'b']);
    });

    it('returns done immediately for empty file', async () => {
      const file = path.join(tmpDir, 'empty.txt');
      await fs.writeFile(file, '');

      const provider = await createFileProvider(file, 'text');
      const item = await provider.next();
      expect(item.done).toBe(true);
      provider.close();
    });
  });

  describe('jsonl format', () => {
    it('streams JSON lines as raw strings', async () => {
      const file = path.join(tmpDir, 'data.jsonl');
      await fs.writeFile(file, '{"host":"a"}\n{"host":"b"}\n');

      const provider = await createFileProvider(file, 'jsonl');
      const results: string[] = [];
      let item = await provider.next();
      while (!item.done) {
        results.push(item.value);
        item = await provider.next();
      }
      provider.close();

      expect(results).toEqual(['{"host":"a"}', '{"host":"b"}']);
    });
  });

  describe('resume with skip', () => {
    it('skips to line N on creation', async () => {
      const file = path.join(tmpDir, 'data.txt');
      await fs.writeFile(file, 'line1\nline2\nline3\nline4\n');

      const provider = await createFileProvider(file, 'text', { skipLines: 2 });
      const item = await provider.next();
      expect(item.done).toBe(false);
      expect(item.value).toBe('line3');
      provider.close();
    });
  });
});

describe('computeFileSnapshot', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-snap-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('captures size and mtime', async () => {
    const file = path.join(tmpDir, 'data.txt');
    await fs.writeFile(file, 'hello\nworld\n');

    const snapshot = await computeFileSnapshot(file, 1);
    expect(snapshot.line).toBe(1);
    expect(snapshot.size).toBeGreaterThan(0);
    expect(snapshot.mtimeMs).toBeGreaterThan(0);
    expect(snapshot.fingerprint).toBeDefined();
  });
});

describe('validateFileSnapshot', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-val-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('passes for unchanged file', async () => {
    const file = path.join(tmpDir, 'data.txt');
    await fs.writeFile(file, 'content\n');

    const snapshot = await computeFileSnapshot(file, 1);
    await expect(validateFileSnapshot(file, snapshot)).resolves.not.toThrow();
  });

  it('fails when file content changes', async () => {
    const file = path.join(tmpDir, 'data.txt');
    await fs.writeFile(file, 'original\n');

    const snapshot = await computeFileSnapshot(file, 1);
    await fs.writeFile(file, 'modified\n');

    await expect(validateFileSnapshot(file, snapshot)).rejects.toThrow(/drift/i);
  });

  it('fails when file size changes', async () => {
    const file = path.join(tmpDir, 'data.txt');
    await fs.writeFile(file, 'short\n');

    const snapshot = await computeFileSnapshot(file, 1);
    await fs.writeFile(file, 'much longer content here\n');

    await expect(validateFileSnapshot(file, snapshot)).rejects.toThrow(/drift/i);
  });
});
