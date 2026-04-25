import { describe, it, expect, jest } from '@jest/globals';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import {
  loadHelperModules,
  validateHelperPath,
  type HelperRegistry,
} from '../../src/services/helper-registry.js';

describe('validateHelperPath', () => {
  it('allows paths within the project root', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-test-'));
    const result = await validateHelperPath('.rundown/helpers/fmt.js', tmpDir, tmpDir);
    expect(typeof result).toBe('string');
    await fs.rm(tmpDir, { recursive: true });
  });

  it('rejects paths that escape the project root', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-test-'));
    const result = await validateHelperPath('../../evil.js', tmpDir, tmpDir);
    expect(result).toBeNull();
    await fs.rm(tmpDir, { recursive: true });
  });
});

describe('loadHelperModules', () => {
  it('returns empty registry when no paths given', async () => {
    const registry = await loadHelperModules([], process.cwd(), process.cwd());
    expect(registry.size).toBe(0);
  });

  it('rejects "path" as a helper name with a warning', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-helper-'));
    const helperFile = path.join(tmpDir, 'bad.mjs');
    await fs.writeFile(helperFile, 'export function path(v) { return v; }');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await loadHelperModules([helperFile], tmpDir, tmpDir);
    expect(registry.has('path')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"path" is reserved'));
    warnSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true });
  });

  it('skips non-function exports with a warning', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-helper-'));
    const helperFile = path.join(tmpDir, 'mixed.mjs');
    await fs.writeFile(
      helperFile,
      'export const notFn = 42;\nexport function realFn(v) { return v.toUpperCase(); }',
    );
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await loadHelperModules([helperFile], tmpDir, tmpDir);
    expect(registry.has('realFn')).toBe(true);
    expect(registry.has('notFn')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"notFn"'));
    warnSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true });
  });

  it('skips async function exports with a warning', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-helper-'));
    const helperFile = path.join(tmpDir, 'async.mjs');
    await fs.writeFile(helperFile, 'export async function fmt(v) { return v; }');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await loadHelperModules([helperFile], tmpDir, tmpDir);
    expect(registry.has('fmt')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('async'));
    warnSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true });
  });

  it('skips a module that fails to load, continues with others', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-helper-'));
    const goodFile = path.join(tmpDir, 'good.mjs');
    await fs.writeFile(goodFile, 'export function upper(v) { return v.toUpperCase(); }');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await loadHelperModules(['/nonexistent/path.mjs', goodFile], tmpDir, tmpDir);
    expect(registry.has('upper')).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load'));
    warnSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true });
  });
});
