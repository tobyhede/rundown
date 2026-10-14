// packages/core/__tests__/project-root.test.ts

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { resolveProjectRoot } from '../src/project-root.js';

describe('resolveProjectRoot', () => {
  let base: string;

  beforeEach(() => {
    // realpath: macOS tmpdir is a /var -> /private/var symlink; the resolver
    // works on the path it is given, so compare like with like.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'rd-project-root-')));
    // A git boundary at the base keeps the walk off whatever lies above the
    // system temp directory.
    writeFileSync(join(base, '.git'), 'gitdir: /dev/null\n');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('returns the start directory when it holds .rundown/', () => {
    mkdirSync(join(base, '.rundown'));

    expect(resolveProjectRoot(base)).toBe(base);
  });

  it('walks up from a subdirectory to the nearest .rundown/', () => {
    mkdirSync(join(base, '.rundown'));
    const sub = join(base, 'a', 'b');
    mkdirSync(sub, { recursive: true });

    expect(resolveProjectRoot(sub)).toBe(base);
  });

  it('lets a nested .rundown/ shadow an outer one', () => {
    mkdirSync(join(base, '.rundown'));
    const nested = join(base, 'nested');
    mkdirSync(join(nested, '.rundown'), { recursive: true });
    const sub = join(nested, 'deeper');
    mkdirSync(sub);

    expect(resolveProjectRoot(sub)).toBe(nested);
  });

  it('falls back to the start directory when no .rundown/ is found', () => {
    const sub = join(base, 'a', 'b');
    mkdirSync(sub, { recursive: true });

    expect(resolveProjectRoot(sub)).toBe(sub);
  });

  it('ignores a .rundown that is a file, not a directory', () => {
    writeFileSync(join(base, '.rundown'), '');
    const sub = join(base, 'a');
    mkdirSync(sub);

    expect(resolveProjectRoot(sub)).toBe(sub);
  });

  it('stops at a git boundary: an outer .rundown/ does not capture a repository below it', () => {
    // base holds .rundown/ and a .git marker; the repository below it is a
    // separate project (a git worktree nested in a checkout, say).
    mkdirSync(join(base, '.rundown'));
    const repo = join(base, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, '.git'), 'gitdir: /dev/null\n');
    const sub = join(repo, 'src');
    mkdirSync(sub);

    expect(resolveProjectRoot(sub)).toBe(sub);
  });

  it('finds .rundown/ at the git boundary directory itself', () => {
    const repo = join(base, 'repo');
    mkdirSync(join(repo, '.rundown'), { recursive: true });
    writeFileSync(join(repo, '.git'), 'gitdir: /dev/null\n');
    const sub = join(repo, 'src');
    mkdirSync(sub);

    expect(resolveProjectRoot(sub)).toBe(repo);
  });

  it('terminates at the filesystem root', () => {
    const fsRoot = parse(base).root;

    expect(resolveProjectRoot(fsRoot)).toBe(fsRoot);
  });
});
