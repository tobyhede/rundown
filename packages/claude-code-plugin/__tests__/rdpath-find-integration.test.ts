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
    env?: Record<string, string | undefined>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    return new Promise((resolve, reject) => {
      const merged = env ? { ...process.env, ...env } : process.env;
      const spawnEnv = Object.fromEntries(
        Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      const proc = spawn('node', ['dist/rdpath.js', ...args], {
        cwd: packageDir,
        env: spawnEnv,
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
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      proc.on('error', reject);
    });
  };

  it('outputs one matching path per line', async () => {
    await fs.writeFile(path.join(testDir, '2026-03-17-pass1.md'), '');
    await fs.writeFile(path.join(testDir, '2026-03-17-pass2.md'), '');
    await fs.writeFile(path.join(testDir, '2026-03-17-fail.md'), '');

    const result = await runRdpath(['--dir', testDir, 'find', '*-pass*.md']);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('pass1.md');
    expect(lines[1]).toContain('pass2.md');
  });

  it('exits 1 with empty stdout and empty stderr when nothing matches', async () => {
    // `rdpath find` is purpose-built for runbook flow control; the default
    // treats an empty match set as a negative answer. Stderr stays empty so
    // callers can distinguish "no matches" from a real error (which writes
    // `error:` to stderr).
    const result = await runRdpath(['--dir', testDir, 'find', '*.md']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('exits 0 with no output when nothing matches and --allow-empty is set', async () => {
    const result = await runRdpath(['--dir', testDir, 'find', '--allow-empty', '*.md']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('--allow-empty still exits 0 when matches are present', async () => {
    await fs.writeFile(path.join(testDir, 'has-match.md'), '');

    const result = await runRdpath(['--dir', testDir, 'find', '--allow-empty', '*.md']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('has-match.md');
  });

  it('exits 1 with error to stderr for invalid pattern', async () => {
    const result = await runRdpath(['--dir', testDir, 'find', '../*.md']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('error:');
  });

  it('exits 1 with error to stderr for nonexistent directory', async () => {
    const result = await runRdpath(['--dir', path.join(testDir, 'nope'), 'find', '*.md']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Directory not found');
  });

  it('supports ctx scoping', async () => {
    const ctxDir = path.join(testDir, '.rd-test-ctx');
    await fs.mkdir(ctxDir);
    await fs.writeFile(path.join(ctxDir, 'found.md'), '');

    const result = await runRdpath(['--dir', testDir, '--ctx', 'test-ctx', 'find', '*.md']);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('.rd-test-ctx');
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

  describe('env var fallback (RD_WORK_PATH, RD_CONTEXT_ID)', () => {
    it('uses RD_WORK_PATH when --dir is omitted', async () => {
      await fs.writeFile(path.join(testDir, '2026-03-17-test.md'), '');

      const result = await runRdpath(['find', '*.md'], { RD_WORK_PATH: testDir });

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('test.md');
    });

    it('uses RD_CONTEXT_ID when --ctx is omitted', async () => {
      const ctxDir = path.join(testDir, '.rd-env-ctx');
      await fs.mkdir(ctxDir);
      await fs.writeFile(path.join(ctxDir, 'found.md'), '');

      const result = await runRdpath(['find', '*.md'], {
        RD_WORK_PATH: testDir,
        RD_CONTEXT_ID: 'env-ctx',
      });

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('.rd-env-ctx');
    });

    it('prefers --dir flag over RD_WORK_PATH env var', async () => {
      const altDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rdpath-alt-'));
      try {
        await fs.writeFile(path.join(altDir, 'alt.md'), '');

        const result = await runRdpath(['--dir', altDir, 'find', '*.md'], {
          RD_WORK_PATH: testDir,
        });

        expect(result.exitCode).toBe(0);
        const lines = result.stdout.trim().split('\n');
        expect(lines[0]).toContain('alt.md');
      } finally {
        await fs.rm(altDir, { recursive: true, force: true });
      }
    });

    it('exits with error when --dir and RD_WORK_PATH are both absent', async () => {
      const result = await runRdpath(['find', '*.md'], {
        RD_WORK_PATH: undefined,
        RD_CONTEXT_ID: undefined,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('RD_WORK_PATH');
    });
  });
});
