// packages/core/__tests__/project-root.test.ts

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { resolveProjectRoot, resolveProjectRootWith } from '../src/project-root.js';

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

  it('resolves to the git root when no .rundown/ lies between the start and it', () => {
    // A fresh repository: .git at base, no .rundown/ anywhere. The first
    // `rundown run` from a subdirectory must create the store at the git
    // root, where a later command from the root (or any other
    // subdirectory) finds it.
    const sub = join(base, 'a', 'b');
    mkdirSync(sub, { recursive: true });

    expect(resolveProjectRoot(sub)).toBe(base);
  });

  it('ignores a .rundown that is a file, not a directory', () => {
    const a = join(base, 'a');
    const sub = join(a, 'b');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(a, '.rundown'), '');

    // Walks past a/ to the git root.
    expect(resolveProjectRoot(sub)).toBe(base);
  });

  it('stops at a git boundary: an outer .rundown/ does not capture a repository below it, whose root is the git root', () => {
    // base holds .rundown/ and a .git marker; the repository below it is a
    // separate project (a git worktree nested in a checkout, say).
    mkdirSync(join(base, '.rundown'));
    const repo = join(base, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, '.git'), 'gitdir: /dev/null\n');
    const sub = join(repo, 'src');
    mkdirSync(sub);

    expect(resolveProjectRoot(sub)).toBe(repo);
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

  it('treats a .rundown that cannot be stat-ed (a self-referential link) as absent', () => {
    // .rundown -> .rundown: stat fails with ELOOP, not ENOENT.
    const a = join(base, 'a');
    const sub = join(a, 'b');
    mkdirSync(sub, { recursive: true });
    symlinkSync('.rundown', join(a, '.rundown'));

    // Walks past a/ to the git root.
    expect(resolveProjectRoot(sub)).toBe(base);
  });

  describe('home boundary', () => {
    // A fake home below base. base's .git marker stops the walk above it
    // either way; each test puts its .rundown/ below that marker.
    let outer: string;
    let home: string;

    beforeEach(() => {
      outer = join(base, 'outer');
      home = join(outer, 'home');
      mkdirSync(home, { recursive: true });
    });

    it('a stray .rundown/ in home does not capture a non-git directory below it', () => {
      mkdirSync(join(home, '.rundown'));
      const sub = join(home, 'scratch', 'x');
      mkdirSync(sub, { recursive: true });

      expect(resolveProjectRootWith(sub, { homeDir: home })).toBe(sub);
    });

    it('outside git, falls back to the start directory when no .rundown/ is found', () => {
      // The walk ends at outer, an ancestor of home, having passed no .git.
      const sub = join(outer, 'elsewhere', 'x');
      mkdirSync(sub, { recursive: true });

      expect(resolveProjectRootWith(sub, { homeDir: home })).toBe(sub);
    });

    it('a home that is a git root is a project: its .rundown/ is found from below', () => {
      // A dotfiles repository in ~, or a container with HOME=/app.
      writeFileSync(join(home, '.git'), 'gitdir: /dev/null\n');
      mkdirSync(join(home, '.rundown'));
      const sub = join(home, 'src', 'x');
      mkdirSync(sub, { recursive: true });

      expect(resolveProjectRootWith(sub, { homeDir: home })).toBe(home);
    });

    it('a home that is a git root with no .rundown/ is the git root; its ancestors stay unread', () => {
      writeFileSync(join(home, '.git'), 'gitdir: /dev/null\n');
      mkdirSync(join(outer, '.rundown'));
      const sub = join(home, 'src');
      mkdirSync(sub);

      expect(resolveProjectRootWith(sub, { homeDir: home })).toBe(home);
    });

    it("starting at home uses home's own .rundown/", () => {
      mkdirSync(join(home, '.rundown'));

      expect(resolveProjectRootWith(home, { homeDir: home })).toBe(home);
    });

    it('never uses a .rundown/ in an ancestor of home, from below home', () => {
      mkdirSync(join(outer, '.rundown'));
      const sub = join(home, 'scratch');
      mkdirSync(sub);

      expect(resolveProjectRootWith(sub, { homeDir: home })).toBe(sub);
    });

    it('never uses a .rundown/ in an ancestor of home, from outside home', () => {
      // base is an ancestor of home; elsewhere/x is not below home.
      mkdirSync(join(base, '.rundown'));
      const sub = join(base, 'elsewhere', 'x');
      mkdirSync(sub, { recursive: true });

      expect(resolveProjectRootWith(sub, { homeDir: home })).toBe(sub);
    });

    it('still walks up outside home, short of its ancestors', () => {
      const elsewhere = join(base, 'elsewhere');
      mkdirSync(join(elsewhere, '.rundown'), { recursive: true });
      const sub = join(elsewhere, 'x');
      mkdirSync(sub);

      expect(resolveProjectRootWith(sub, { homeDir: home })).toBe(elsewhere);
    });

    it('compares canonical paths: a home given through a symlink still bounds the walk', () => {
      mkdirSync(join(home, '.rundown'));
      const link = join(base, 'home-link');
      symlinkSync(home, link);
      const sub = join(home, 'scratch');
      mkdirSync(sub);

      expect(resolveProjectRootWith(sub, { homeDir: link })).toBe(sub);
    });
  });
});
