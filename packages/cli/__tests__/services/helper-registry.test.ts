import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import {
  loadHelperModules,
  validateHelperPath,
  setHelperRegistry,
  getHelperRegistry,
  resetHelperRegistry,
  detectHelperCollisions,
  type HelperRegistry,
} from '../../src/services/helper-registry.js';

describe('validateHelperPath', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('allows paths within the project root', async () => {
    const result = await validateHelperPath('.rundown/helpers/fmt.js', tmpDir, tmpDir);
    expect(typeof result).toBe('string');
  });

  it('rejects paths that escape the project root', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await validateHelperPath('../../evil.js', tmpDir, tmpDir);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('escapes project directory'));
    warnSpy.mockRestore();
  });

  it('rejects an absolute path that escapes the project root', async () => {
    // /tmp itself is outside tmpDir, so using os.tmpdir() as the absolute path
    // is guaranteed to escape the project root (tmpDir is a subdirectory of tmpdir).
    const escapingAbsolute = os.tmpdir();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await validateHelperPath(escapingAbsolute, tmpDir, tmpDir);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('escapes project directory'));
    warnSpy.mockRestore();
  });
});

describe('loadHelperModules', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-helper-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty registry when no paths given', async () => {
    const registry = await loadHelperModules([], process.cwd(), process.cwd());
    expect(registry.size).toBe(0);
  });

  it('rejects "path" as a helper name with a warning', async () => {
    const helperFile = path.join(tmpDir, 'bad.mjs');
    await fs.writeFile(helperFile, 'export function path(v) { return v; }');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await loadHelperModules([helperFile], tmpDir, tmpDir);
    expect(registry.has('path')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"path" is reserved'));
    warnSpy.mockRestore();
  });

  it('skips non-function exports with a warning', async () => {
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
  });

  it('skips async function exports with a warning', async () => {
    const helperFile = path.join(tmpDir, 'async.mjs');
    await fs.writeFile(helperFile, 'export async function fmt(v) { return v; }');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await loadHelperModules([helperFile], tmpDir, tmpDir);
    expect(registry.has('fmt')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('async'));
    warnSpy.mockRestore();
  });

  it('skips a module that fails to load, continues with others', async () => {
    const goodFile = path.join(tmpDir, 'good.mjs');
    // This path is inside tmpDir but does not exist — will pass traversal check then fail at import.
    const missingFile = path.join(tmpDir, 'nonexistent.mjs');
    await fs.writeFile(goodFile, 'export function upper(v) { return v.toUpperCase(); }');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await loadHelperModules([missingFile, goodFile], tmpDir, tmpDir);
    expect(registry.has('upper')).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load'));
    warnSpy.mockRestore();
  });

  it('returns empty registry for a module that only exports default', async () => {
    const helperFile = path.join(tmpDir, 'default-only.mjs');
    await fs.writeFile(helperFile, 'export default function fmt(v) { return v; }');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await loadHelperModules([helperFile], tmpDir, tmpDir);
    expect(registry.size).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('detectHelperCollisions', () => {
  it('returns colliding names when variable names match helper names', () => {
    const registry: HelperRegistry = new Map([
      ['upper', (v: string) => v.toUpperCase()],
      ['slug', (v: string) => v],
    ]);
    const variables = { upper: 'some value', other: 'fine' };
    expect(detectHelperCollisions(registry, variables)).toEqual(['upper']);
  });

  it('returns empty array when no collisions', () => {
    const registry: HelperRegistry = new Map([['upper', (v: string) => v.toUpperCase()]]);
    const variables = { name: 'Alice' };
    expect(detectHelperCollisions(registry, variables)).toEqual([]);
  });

  it('returns empty array when registry is empty', () => {
    expect(detectHelperCollisions(new Map(), { name: 'Alice' })).toEqual([]);
  });
});

describe('singleton accessor functions', () => {
  beforeEach(() => {
    resetHelperRegistry();
  });

  it('getHelperRegistry returns an empty Map before any set', () => {
    const registry = getHelperRegistry();
    expect(registry.size).toBe(0);
  });

  it('getHelperRegistry returns the Map installed by setHelperRegistry', () => {
    const myMap: HelperRegistry = new Map([['upper', (v: string) => v.toUpperCase()]]);
    setHelperRegistry(myMap);
    expect(getHelperRegistry()).toBe(myMap);
  });

  it('getHelperRegistry returns an empty Map after resetHelperRegistry', () => {
    const myMap: HelperRegistry = new Map([['upper', (v: string) => v.toUpperCase()]]);
    setHelperRegistry(myMap);
    resetHelperRegistry();
    const registry = getHelperRegistry();
    expect(registry.size).toBe(0);
    expect(registry).not.toBe(myMap);
  });
});
