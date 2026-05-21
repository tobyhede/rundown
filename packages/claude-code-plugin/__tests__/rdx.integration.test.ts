import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, 'fixtures', 'rdx');

const runRdx = (args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['dist/rdx.js', ...args], {
      cwd: path.resolve(__dirname, '..'),
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

describe('rdx --validate', () => {
  test('--validate without schema errors', async () => {
    const result = await runRdx(['--validate', path.join(fixturesDir, 'no-schema.json')]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--validate requires a schema');
  });

  test('valid plan with $schema field prints Valid', async () => {
    const result = await runRdx(['--validate', path.join(fixturesDir, 'valid-plan.json')]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Valid.\n');
  });

  test('--validate with --output ignores output flag', async () => {
    const result = await runRdx([
      '--validate',
      '--output',
      'ignored.out',
      path.join(fixturesDir, 'valid-plan.json'),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Valid.\n');
    expect(result.stderr).not.toContain('error:');
  });

  test('invalid JSON syntax prints error with filename', async () => {
    const result = await runRdx(['--validate', path.join(fixturesDir, 'invalid-json.txt')]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid JSON in');
    expect(result.stderr).toContain('invalid-json.txt');
  });

  test('missing file prints file-not-found error', async () => {
    const result = await runRdx(['--validate', path.join(fixturesDir, 'nonexistent.json')]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('file not found');
    expect(result.stderr).toContain('nonexistent.json');
  });

  test('valid JSON failing schema prints validation errors and exits 1', async () => {
    const result = await runRdx(['--validate', path.join(fixturesDir, 'invalid-plan.json')]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('schema validation failed');
    expect(result.stderr).toContain('plan');
  });

  test('--schema flag overrides $schema field', async () => {
    // valid-plan.json has $schema: "plan", but --schema nonexistent should fail
    const result = await runRdx([
      '--validate',
      '--schema',
      'nonexistent',
      path.join(fixturesDir, 'valid-plan.json'),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown schema: nonexistent');
  });

  test('unrecognized $schema URI prints error and exits 1', async () => {
    const result = await runRdx(['--validate', path.join(fixturesDir, 'unknown-schema.json')]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unrecognized schema');
  });

  test('--schema flag validates file without $schema field', async () => {
    // no-schema.json has no $schema, but --schema plan should validate (and fail)
    const result = await runRdx([
      '--validate',
      '--schema',
      'plan',
      path.join(fixturesDir, 'no-schema.json'),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('schema validation failed');
  });

  test('--check is not accepted', async () => {
    const result = await runRdx(['--check', path.join(fixturesDir, 'valid-plan.json')]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown option');
  });
});

describe('rdx render', () => {
  test('valid JSON with $schema renders Markdown without $schema in output', async () => {
    const result = await runRdx([path.join(fixturesDir, 'valid-plan.json')]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('# Test Plan');
    expect(result.stdout).not.toContain('$schema');
  });

  test('invalid JSON with $schema prints errors and exits 1', async () => {
    const result = await runRdx([path.join(fixturesDir, 'invalid-plan.json')]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('schema validation failed');
  });

  test('no schema renders with warning', async () => {
    const result = await runRdx([path.join(fixturesDir, 'no-schema.json')]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('# Simple Doc');
    expect(result.stdout).toContain('A plain JSON document with no schema');
    expect(result.stderr).toContain('warning: no schema found');
  });

  test('missing file prints file-not-found error', async () => {
    const result = await runRdx([path.join(fixturesDir, 'nonexistent.json')]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('file not found');
    expect(result.stderr).toContain('nonexistent.json');
  });

  test('--output writes to file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rdx-test-'));
    const outPath = path.join(tmpDir, 'output.md');
    try {
      const result = await runRdx([path.join(fixturesDir, 'valid-plan.json'), '-o', outPath]);
      expect(result.exitCode).toBe(0);
      const content = await fs.readFile(outPath, 'utf-8');
      expect(content).toContain('# Test Plan');
      expect(content).not.toContain('$schema');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
