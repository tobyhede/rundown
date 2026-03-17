import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageDir = path.resolve(__dirname, '..');

describe('rdpath find integration', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rdpath-find-int-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const runRdpath = (
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    return new Promise((resolve, reject) => {
      const proc = spawn('node', ['dist/rdpath.js', ...args], {
        cwd: packageDir,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 0 });
      });

      proc.on('error', reject);
    });
  };

  it('outputs one matching path per line', async () => {
    await fs.writeFile(path.join(testDir, '2026-03-17-pass1.md'), '');
    await fs.writeFile(path.join(testDir, '2026-03-17-pass2.md'), '');
    await fs.writeFile(path.join(testDir, '2026-03-17-fail.md'), '');

    const result = await runRdpath(['find', '--dir', testDir, '*-pass*.md']);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('pass1.md');
    expect(lines[1]).toContain('pass2.md');
  });

  it('exits 0 with no output when nothing matches', async () => {
    const result = await runRdpath(['find', '--dir', testDir, '*.md']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exits 1 with error to stderr for invalid pattern', async () => {
    const result = await runRdpath(['find', '--dir', testDir, '../*.md']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('error:');
  });

  it('exits 1 with error to stderr for nonexistent directory', async () => {
    const result = await runRdpath(['find', '--dir', path.join(testDir, 'nope'), '*.md']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Directory not found');
  });

  it('supports ctx scoping', async () => {
    const ctxDir = path.join(testDir, '.rd-myctx');
    await fs.mkdir(ctxDir);
    await fs.writeFile(path.join(ctxDir, 'found.md'), '');

    const result = await runRdpath(['find', '--dir', testDir, '--ctx', 'myctx', '*.md']);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('.rd-myctx');
    expect(lines[0]).toContain('found.md');
  });

  describe('backward compatibility', () => {
    it('rdpath --dir still works as default path subcommand', async () => {
      const result = await runRdpath(['--dir', '.work']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('.work');
    });

    it('rdpath --dir --ctx still works', async () => {
      const result = await runRdpath(['--dir', '.work', '--ctx', 'abc123']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(path.join('.work', '.rd-abc123'));
    });
  });
});
