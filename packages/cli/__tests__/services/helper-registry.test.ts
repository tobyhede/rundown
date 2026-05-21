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
import { createTestWorkspace, runCliInProcess } from '../helpers/test-utils.js';

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

  it('rejects "artifact" as a helper name with a warning', async () => {
    const helperFile = path.join(tmpDir, 'bad-artifact.mjs');
    await fs.writeFile(helperFile, 'export function artifact(v) { return v; }');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await loadHelperModules([helperFile], tmpDir, tmpDir);
    expect(registry.has('artifact')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"artifact" is reserved'));
    warnSpy.mockRestore();
  });

  it('rejects "validateSchema" as a helper name with a warning', async () => {
    const helperFile = path.join(tmpDir, 'bad-validate-schema.mjs');
    await fs.writeFile(helperFile, 'export function validateSchema(v) { return v; }');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await loadHelperModules([helperFile], tmpDir, tmpDir);
    expect(registry.has('validateSchema')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"validateSchema" is reserved'));
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

  it('skips a class export with a warning', async () => {
    const helperFile = path.join(tmpDir, 'class.mjs');
    await fs.writeFile(helperFile, 'export class Fmt { run(v) { return v; } }');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await loadHelperModules([helperFile], tmpDir, tmpDir);
    expect(registry.has('Fmt')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('class'));
    warnSpy.mockRestore();
  });

  it('registers sync functions that return a Promise (validated at call time, not load time)', async () => {
    // Pre-PR-235 behavior probed each helper with `('')` at registration to
    // catch sync-but-Promise-returning helpers. That probe ran user code at
    // CLI startup and was removed. The "returns Promise" failure mode is now
    // surfaced by `invokeHelperSafely` at the call site instead, so the
    // registry no longer rejects this shape — it just registers it.
    const helperFile = path.join(tmpDir, 'sync-promise.mjs');
    await fs.writeFile(
      helperFile,
      'export function fmt(v) { return Promise.resolve(v.toUpperCase()); }',
    );
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await loadHelperModules([helperFile], tmpDir, tmpDir);
    expect(registry.has('fmt')).toBe(true);
    // Critically: registration must NOT have invoked the helper.
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not invoke helpers at registration time (no side effects)', async () => {
    // Item 10 (PR #235): the load-time probe called the helper with '' to
    // detect bad shapes, executing arbitrary user code during CLI startup.
    // After the fix, registration must be a pure load — no invocation.
    const sentinel = path.join(tmpDir, 'invoked.flag');
    const helperFile = path.join(tmpDir, 'side-effect.mjs');
    // The helper writes a sentinel file when invoked. After registration, the
    // sentinel must not exist.
    await fs.writeFile(
      helperFile,
      `import { writeFileSync } from 'node:fs';\n` +
        `export function recorder(v) { writeFileSync(${JSON.stringify(sentinel)}, 'invoked'); return v.toUpperCase(); }`,
    );
    const registry = await loadHelperModules([helperFile], tmpDir, tmpDir);
    expect(registry.has('recorder')).toBe(true);
    await expect(fs.access(sentinel)).rejects.toThrow();
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

/**
 * Regression test for PR #235 review item 8.
 *
 * `createProgram()`'s `preSubcommand` hook is the only place the helper
 * registries get installed. Earlier code gated the install behind
 * `if (allHelperPaths.length > 0)`, so a second in-process invocation with no
 * helpers configured would inherit stale helpers from the first invocation —
 * a real concern for tests and any host that boots the CLI more than once
 * within a single process.
 *
 * The fix removes the gate: when no helpers are configured, the CLI-side
 * singleton is explicitly reset to an empty Map.
 */
describe('createProgram preSubcommand: helper registry reset on re-entry', () => {
  let workspace: Awaited<ReturnType<typeof createTestWorkspace>>;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    resetHelperRegistry();
    await workspace.cleanup();
  });

  it('clears stale helpers when a subsequent createProgram invocation has no helpers configured', async () => {
    // Simulate the residue from a prior CLI invocation that registered helpers.
    const stale: HelperRegistry = new Map([['upper', (v: string) => v.toUpperCase()]]);
    setHelperRegistry(stale);

    expect(getHelperRegistry().size).toBe(1);

    // Run any subcommand through the in-process CLI. The workspace has no
    // .rundownrc and no --helpers flag, so the preSubcommand hook should
    // install an empty registry — overwriting the stale one above.
    const result = await runCliInProcess('status', workspace);
    expect(result.exitCode).toBe(0);

    expect(getHelperRegistry().size).toBe(0);
  });
});
