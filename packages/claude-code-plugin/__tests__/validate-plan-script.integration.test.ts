import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const scriptPath = path.join(__dirname, '..', 'scripts', 'validate-plan.js');
const fixturesDir = path.join(__dirname, 'fixtures', 'plans');

function runScript(file: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('node', [scriptPath, file], {
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? 1,
  };
}

describe('validate-plan.js', () => {
  it('exits 0 for valid plan', () => {
    const result = runScript(path.join(fixturesDir, 'health-check-plan.json'));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('exits 1 for plan with structural errors', () => {
    const result = runScript(path.join(fixturesDir, 'health-check-plan-issues.json'));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('FAIL');
    expect(result.stderr).toContain('commit-file-consistency');
    expect(result.stderr).toContain('no-line-numbers');
    expect(result.stderr).toContain('file-consistency');
  });

  it('exits 0 for multi-task plan with warnings only', () => {
    const result = runScript(path.join(fixturesDir, 'multi-task-plan.json'));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS');
    expect(result.stdout).toContain('warning');
    expect(result.stderr).toContain('WARN');
  });

  it('exits 1 for missing file', () => {
    const result = runScript('/nonexistent/plan.json');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('cannot read file');
  });

  it('exits 1 for invalid JSON', () => {
    const tmpFile = path.join(os.tmpdir(), `bad-plan-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, '{ not valid json }');
    try {
      const result = runScript(tmpFile);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('invalid JSON');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('exits 1 for schema-invalid plan', () => {
    const tmpFile = path.join(os.tmpdir(), `incomplete-plan-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ name: 'Incomplete' }));
    try {
      const result = runScript(tmpFile);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('schema validation failed');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('prints no arguments usage message', () => {
    const result = spawnSync('node', [scriptPath], {
      encoding: 'utf-8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage');
  });
});
