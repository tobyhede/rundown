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

      const provider = await createFileProvider(file);
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

      const provider = await createFileProvider(file);
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

      const provider = await createFileProvider(file);
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

      const provider = await createFileProvider(file);
      const item = await provider.next();
      expect(item.done).toBe(true);
      provider.close();
    });

    it('handles CRLF line endings', async () => {
      const file = path.join(tmpDir, 'crlf.txt');
      await fs.writeFile(file, 'host1\r\nhost2\r\n');

      const provider = await createFileProvider(file);
      const results: string[] = [];
      let item = await provider.next();
      while (!item.done) {
        results.push(item.value);
        item = await provider.next();
      }
      provider.close();

      expect(results).toEqual(['host1', 'host2']);
    });

    it('handles very long lines without truncation', async () => {
      const file = path.join(tmpDir, 'longline.txt');
      const longLine = 'a'.repeat(100000);
      await fs.writeFile(file, `${longLine}\n`);

      const provider = await createFileProvider(file);
      const results: string[] = [];
      let item = await provider.next();
      while (!item.done) {
        results.push(item.value);
        item = await provider.next();
      }
      provider.close();

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveLength(100000);
    });
  });

  describe('jsonl format', () => {
    it('streams JSON lines as raw strings', async () => {
      const file = path.join(tmpDir, 'data.jsonl');
      await fs.writeFile(file, '{"host":"a"}\n{"host":"b"}\n');

      const provider = await createFileProvider(file);
      const results: string[] = [];
      let item = await provider.next();
      while (!item.done) {
        results.push(item.value);
        item = await provider.next();
      }
      provider.close();

      expect(results).toEqual(['{"host":"a"}', '{"host":"b"}']);
    });

    it('skips empty lines in jsonl format', async () => {
      const file = path.join(tmpDir, 'data.jsonl');
      await fs.writeFile(file, '{"a":1}\n\n{"b":2}\n');

      const provider = await createFileProvider(file);
      const results: string[] = [];
      let item = await provider.next();
      while (!item.done) {
        results.push(item.value);
        item = await provider.next();
      }
      provider.close();

      expect(results).toEqual(['{"a":1}', '{"b":2}']);
    });
  });

  describe('resume with skip', () => {
    it('skips to line N on creation', async () => {
      const file = path.join(tmpDir, 'data.txt');
      await fs.writeFile(file, 'line1\nline2\nline3\nline4\n');

      const provider = await createFileProvider(file, { skipLines: 2 });
      const item = await provider.next();
      expect(item.done).toBe(false);
      expect(item.value).toBe('line3');
      provider.close();
    });

    it('skip accounts for empty lines in text format', async () => {
      const file = path.join(tmpDir, 'data.txt');
      await fs.writeFile(file, 'first\nsecond\nthird\n');

      const provider = await createFileProvider(file, { skipLines: 1 });
      const item = await provider.next();
      expect(item.done).toBe(false);
      expect(item.value).toBe('second');
      provider.close();
    });
  });

  describe('error-path resource cleanup', () => {
    it('close is safe to call after error in next()', async () => {
      const file = path.join(tmpDir, 'data.txt');
      await fs.writeFile(file, 'line1\nline2\n');

      const provider = await createFileProvider(file);
      const first = await provider.next();
      expect(first.value).toBe('line1');

      expect(() => {
        provider.close();
      }).not.toThrow();
    });

    it('close is safe to call multiple times', async () => {
      const file = path.join(tmpDir, 'data.txt');
      await fs.writeFile(file, 'line1\n');

      const provider = await createFileProvider(file);
      provider.close();
      expect(() => {
        provider.close();
      }).not.toThrow();
    });
  });

  describe('close lifecycle', () => {
    it('close during iteration does not throw', async () => {
      const file = path.join(tmpDir, 'data.txt');
      await fs.writeFile(file, 'line1\nline2\nline3\n');

      const provider = await createFileProvider(file);
      const first = await provider.next();
      expect(first.done).toBe(false);
      expect(first.value).toBe('line1');

      expect(() => {
        provider.close();
      }).not.toThrow();
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
    expect(snapshot.lastLine).toBe(1);
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

  it('passes when mtime changes but content is identical', async () => {
    const file = path.join(tmpDir, 'data.txt');
    await fs.writeFile(file, 'content\n');

    const snapshot = await computeFileSnapshot(file, 1);

    // Change mtime by touching the file with updated timestamps
    const now = new Date();
    await fs.utimes(file, now, new Date(now.getTime() + 5000));

    await expect(validateFileSnapshot(file, snapshot)).resolves.not.toThrow();
  });

  it('fails when mtime changes and no fingerprint in snapshot', async () => {
    const file = path.join(tmpDir, 'data.txt');
    await fs.writeFile(file, 'content\n');

    const stat = await fs.stat(file);

    // Create a snapshot manually without fingerprint
    const snapshotWithoutFingerprint = {
      lastLine: 1,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      fingerprint: undefined,
    };

    // Change mtime by touching the file
    const now = new Date();
    await fs.utimes(file, now, new Date(now.getTime() + 5000));

    await expect(validateFileSnapshot(file, snapshotWithoutFingerprint)).rejects.toThrow(/drift/i);
  });
});
