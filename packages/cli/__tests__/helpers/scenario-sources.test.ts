/**
 * Regression tests for the scenario-source directory walk.
 *
 * `getFilesSync` feeds both the executing harness (`scenario-runner.test.ts`) and
 * the static authoring lint (`scenario-authoring.test.ts`), so a walk that throws
 * on local filesystem detritus makes both suites environment-dependent, and a walk
 * that swallows a real I/O error makes them silently under-enforce. Both halves of
 * that contract are pinned here against a purpose-built tmpdir tree rather than the
 * repository, so the assertions do not depend on what happens to be checked out.
 */

import { afterEach, describe, expect, it } from '@jest/globals';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFilesSync } from './scenario-sources.js';

const created: string[] = [];

/**
 * Create an isolated temporary directory removed after the test.
 *
 * @returns Absolute path of the new directory
 */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scenario-sources-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir === undefined) continue;
    // Restore traversal rights before cleanup: the EACCES test strips them.
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Already removed or never restricted — cleanup below is authoritative.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('getFilesSync', () => {
  it('returns every nested file under the walked directory', () => {
    const root = makeTempDir();
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'top.runbook.md'), '');
    writeFileSync(join(root, 'nested', 'deep.scenario-suite.yaml'), '');

    expect(getFilesSync(root).sort()).toEqual(
      [join(root, 'nested', 'deep.scenario-suite.yaml'), join(root, 'top.runbook.md')].sort(),
    );
  });

  it('excludes .pnpm-store along with the other build and vendor directories', () => {
    const root = makeTempDir();
    // An in-repo content-addressed store: huge, irrelevant to scenario discovery,
    // and pruned mid-walk by a concurrent install.
    for (const excluded of ['.pnpm-store', 'node_modules', 'dist', '.stryker-tmp']) {
      mkdirSync(join(root, excluded));
      writeFileSync(join(root, excluded, 'decoy.scenario-suite.yaml'), '');
    }
    writeFileSync(join(root, 'real.scenario-suite.yaml'), '');

    expect(getFilesSync(root)).toEqual([join(root, 'real.scenario-suite.yaml')]);
  });

  it('skips a dangling symlink instead of failing the whole walk', () => {
    const root = makeTempDir();
    // e.g. a `logs/latest` pointer left behind by a cleaned run.
    symlinkSync(join(root, 'gone'), join(root, 'latest'));
    writeFileSync(join(root, 'real.scenario-suite.yaml'), '');

    expect(getFilesSync(root)).toEqual([join(root, 'real.scenario-suite.yaml')]);
  });

  it('rethrows a non-ENOENT stat failure rather than silently under-reporting', () => {
    const root = makeTempDir();
    const restricted = join(root, 'restricted');
    mkdirSync(restricted);
    writeFileSync(join(restricted, 'unreachable.scenario-suite.yaml'), '');
    // Readable but not traversable: readdir still lists the entry, stat on it
    // fails with EACCES. Root bypasses the permission check entirely.
    chmodSync(restricted, 0o600);
    created.push(restricted);

    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (isRoot) return;

    // A swallowed EACCES would drop real suite files from the lint's view, so the
    // ENOENT skip must stay narrow.
    expect(() => getFilesSync(root)).toThrow(expect.objectContaining({ code: 'EACCES' }));
  });
});
