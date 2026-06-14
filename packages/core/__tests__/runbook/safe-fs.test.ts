import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { PathLike } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const actualFs = await import('node:fs');
const { isNodeErrorCode } = await import('../../src/errors.js');

// afterLstat fires after every realpathSync/statSync-style lstat the guard
// performs, letting a test swap the path mid-flight to exercise the
// symlink-swap (TOCTOU) re-stat. Modelled on artifact-manifest-toctou.test.ts.
let afterRealpath: ((filePath: string) => void) | undefined;

jest.unstable_mockModule('node:fs', () => ({
  ...actualFs,
  realpathSync: jest.fn((filePath: PathLike, ...rest: unknown[]) => {
    const resolved = (actualFs.realpathSync as (p: PathLike, ...r: unknown[]) => string)(
      filePath,
      ...rest,
    );
    afterRealpath?.(String(filePath));
    return resolved;
  }),
}));

const {
  noFollowFlag,
  directoryFlag,
  sameFile,
  assertContained,
  validateOpenedPathInsideRoot,
  validateOpenedPathInsideRootAsync,
  openVerifiedRegularFile,
  openVerifiedRegularFileSync,
  readVerifiedUtf8File,
  readVerifiedUtf8FileSync,
  UnsafeFileError,
} = await import('../../src/runbook/safe-fs.js');

let tempDirs: string[] = [];

afterEach(async () => {
  afterRealpath = undefined;
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { force: true, recursive: true })));
  tempDirs = [];
  jest.clearAllMocks();
});

async function tempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'safe-fs-'));
  tempDirs.push(dir);
  return dir;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return isNodeErrorCode(error, code);
}

describe('flag helpers', () => {
  it('noFollowFlag returns a numeric flag (O_NOFOLLOW when defined, else 0)', () => {
    const flag = noFollowFlag();
    expect(typeof flag).toBe('number');
    if ('O_NOFOLLOW' in actualFs.constants) {
      expect(flag).toBe(actualFs.constants.O_NOFOLLOW);
    } else {
      expect(flag).toBe(0);
    }
  });

  it('directoryFlag returns a numeric flag (O_DIRECTORY when defined, else 0)', () => {
    const flag = directoryFlag();
    expect(typeof flag).toBe('number');
    if ('O_DIRECTORY' in actualFs.constants) {
      expect(flag).toBe(actualFs.constants.O_DIRECTORY);
    } else {
      expect(flag).toBe(0);
    }
  });
});

describe('sameFile', () => {
  it('is true for identical dev/ino, false otherwise', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'a.txt');
    await fsp.writeFile(filePath, 'x');
    const a = actualFs.statSync(filePath);
    const b = actualFs.statSync(filePath);
    expect(sameFile(a, b)).toBe(true);

    const otherPath = path.join(dir, 'b.txt');
    await fsp.writeFile(otherPath, 'y');
    const c = actualFs.statSync(otherPath);
    expect(sameFile(a, c)).toBe(false);
  });
});

describe('assertContained', () => {
  it('accepts equal and nested paths', () => {
    expect(() => {
      assertContained('/root', '/root');
    }).not.toThrow();
    expect(() => {
      assertContained('/root', '/root/child/leaf');
    }).not.toThrow();
  });

  it('throws UnsafeFileError(escaped-root) for an escaping path', () => {
    try {
      assertContained('/root', '/root/../elsewhere');
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeFileError);
      expect((error as InstanceType<typeof UnsafeFileError>).reason).toBe('escaped-root');
    }
  });
});

describe('openVerifiedRegularFileSync', () => {
  it('opens a regular file and returns a readable fd', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'file.txt');
    await fsp.writeFile(filePath, 'hello');
    const fd = openVerifiedRegularFileSync(filePath, actualFs.constants.O_RDONLY);
    try {
      expect(actualFs.readFileSync(fd, 'utf8')).toBe('hello');
    } finally {
      actualFs.closeSync(fd);
    }
  });

  it('rejects a symlink with ELOOP (O_NOFOLLOW always ORed in)', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'target.txt');
    const link = path.join(dir, 'link.txt');
    await fsp.writeFile(target, 'data');
    await fsp.symlink(target, link);
    try {
      openVerifiedRegularFileSync(link, actualFs.constants.O_RDONLY);
      throw new Error('expected throw');
    } catch (error) {
      expect(isErrnoCode(error, 'ELOOP')).toBe(true);
    }
  });

  it('rejects a directory with UnsafeFileError(not-regular-file)', async () => {
    const dir = await tempDir();
    const subdir = path.join(dir, 'subdir');
    await fsp.mkdir(subdir);
    try {
      openVerifiedRegularFileSync(subdir, actualFs.constants.O_RDONLY);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeFileError);
      expect((error as InstanceType<typeof UnsafeFileError>).reason).toBe('not-regular-file');
    }
  });

  it('propagates ENOENT for a missing file (not swallowed)', async () => {
    const dir = await tempDir();
    const missing = path.join(dir, 'missing.txt');
    try {
      openVerifiedRegularFileSync(missing, actualFs.constants.O_RDONLY);
      throw new Error('expected throw');
    } catch (error) {
      expect(isErrnoCode(error, 'ENOENT')).toBe(true);
    }
  });

  describe('containment ON', () => {
    it('accepts a file contained under the root', async () => {
      const dir = await tempDir();
      const filePath = path.join(dir, 'inside.txt');
      await fsp.writeFile(filePath, 'ok');
      const fd = openVerifiedRegularFileSync(filePath, actualFs.constants.O_RDONLY, dir);
      actualFs.closeSync(fd);
    });

    it('rejects a file whose realpath escapes the root', async () => {
      const root = await tempDir();
      const outside = await tempDir();
      const outsideFile = path.join(outside, 'secret.txt');
      await fsp.writeFile(outsideFile, 'leak');
      // A symlink inside root pointing outside would be caught at open by
      // O_NOFOLLOW; to exercise the realpath escape check we make the root
      // itself a symlink whose realpath differs, and target a sibling file.
      try {
        openVerifiedRegularFileSync(outsideFile, actualFs.constants.O_RDONLY, root);
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(UnsafeFileError);
        expect((error as InstanceType<typeof UnsafeFileError>).reason).toBe('escaped-root');
      }
    });

    it('rejects a symlink-swap (dev/ino mismatch) with symlink-swapped', async () => {
      const root = await tempDir();
      const outside = await tempDir();
      const filePath = path.join(root, 'file.txt');
      const replacement = path.join(outside, 'replacement.txt');
      await fsp.writeFile(filePath, 'original');
      await fsp.writeFile(replacement, 'swapped');

      // After the guard resolves realpath(filePath), swap the path so the
      // re-stat sees a different inode than the opened fd.
      let swapped = false;
      afterRealpath = (resolved) => {
        if (swapped || path.resolve(resolved) !== path.resolve(filePath)) {
          return;
        }
        swapped = true;
        actualFs.rmSync(filePath);
        actualFs.symlinkSync(replacement, filePath);
      };

      try {
        openVerifiedRegularFileSync(filePath, actualFs.constants.O_RDONLY, root);
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(UnsafeFileError);
        expect((error as InstanceType<typeof UnsafeFileError>).reason).toBe('symlink-swapped');
      }
    });
  });

  describe('containment OFF', () => {
    it('does not perform any realpath re-stat when containedRoot is omitted', async () => {
      const dir = await tempDir();
      const filePath = path.join(dir, 'file.txt');
      await fsp.writeFile(filePath, 'data');
      let realpathCalls = 0;
      afterRealpath = () => {
        realpathCalls += 1;
      };
      const fd = openVerifiedRegularFileSync(filePath, actualFs.constants.O_RDONLY);
      actualFs.closeSync(fd);
      // Containment OFF must not trigger the realpath/dev-ino re-stat — this
      // pins that output-channels (which omits containedRoot) gains no new
      // behaviour from the convergence.
      expect(realpathCalls).toBe(0);
    });
  });
});

describe('readVerifiedUtf8FileSync', () => {
  it('reads the whole file as UTF-8', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'file.txt');
    await fsp.writeFile(filePath, 'utf8-content');
    expect(readVerifiedUtf8FileSync(filePath)).toBe('utf8-content');
  });

  it('reads with containment enforced', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'file.txt');
    await fsp.writeFile(filePath, 'contained');
    expect(readVerifiedUtf8FileSync(filePath, dir)).toBe('contained');
  });
});

describe('openVerifiedRegularFile (async)', () => {
  it('opens a regular file and returns a readable handle', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'file.txt');
    await fsp.writeFile(filePath, 'hello-async');
    const handle = await openVerifiedRegularFile(filePath, actualFs.constants.O_RDONLY);
    try {
      expect(await handle.readFile('utf8')).toBe('hello-async');
    } finally {
      await handle.close();
    }
  });

  it('rejects a symlink with ELOOP', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'target.txt');
    const link = path.join(dir, 'link.txt');
    await fsp.writeFile(target, 'data');
    await fsp.symlink(target, link);
    const error = await openVerifiedRegularFile(link, actualFs.constants.O_RDONLY).then(
      (handle) => {
        void handle.close();
        return undefined;
      },
      (err: unknown) => err,
    );
    expect(isErrnoCode(error, 'ELOOP')).toBe(true);
  });

  it('rejects a directory with UnsafeFileError(not-regular-file)', async () => {
    const dir = await tempDir();
    const subdir = path.join(dir, 'subdir');
    await fsp.mkdir(subdir);
    await expect(
      openVerifiedRegularFile(subdir, actualFs.constants.O_RDONLY),
    ).rejects.toBeInstanceOf(UnsafeFileError);
  });

  it('propagates ENOENT for a missing file', async () => {
    const dir = await tempDir();
    const missing = path.join(dir, 'missing.txt');
    const error = await openVerifiedRegularFile(missing, actualFs.constants.O_RDONLY).then(
      (handle) => {
        void handle.close();
        return undefined;
      },
      (err: unknown) => err,
    );
    expect(isErrnoCode(error, 'ENOENT')).toBe(true);
  });

  it('creates a file with O_CREAT and applies the mode', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'created.txt');
    const handle = await openVerifiedRegularFile(
      filePath,
      actualFs.constants.O_WRONLY | actualFs.constants.O_CREAT | actualFs.constants.O_TRUNC,
      0o600,
    );
    try {
      await handle.write('written');
    } finally {
      await handle.close();
    }
    expect(await fsp.readFile(filePath, 'utf8')).toBe('written');
  });

  it('applies containment when containedRoot is provided', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'file.txt');
    await fsp.writeFile(filePath, 'contained');
    const handle = await openVerifiedRegularFile(
      filePath,
      actualFs.constants.O_RDONLY,
      undefined,
      dir,
    );
    await handle.close();
  });
});

describe('readVerifiedUtf8File (async)', () => {
  it('reads the whole file as UTF-8', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'file.txt');
    await fsp.writeFile(filePath, 'async-utf8');
    await expect(readVerifiedUtf8File(filePath)).resolves.toBe('async-utf8');
  });
});

describe('validateOpenedPathInsideRoot', () => {
  it('passes for a contained file that was not swapped', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'file.txt');
    await fsp.writeFile(filePath, 'x');
    const stat = actualFs.statSync(filePath);
    expect(() => {
      validateOpenedPathInsideRoot(dir, filePath, stat);
    }).not.toThrow();
  });

  it('throws symlink-swapped when the opened stat does not match the current inode', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'file.txt');
    const otherPath = path.join(dir, 'other.txt');
    await fsp.writeFile(filePath, 'x');
    await fsp.writeFile(otherPath, 'y');
    // Pass a stat from a *different* file as the "opened" stat to simulate a
    // post-open swap: dev/ino will not match the current path's stat.
    const mismatchedStat = actualFs.statSync(otherPath);
    try {
      validateOpenedPathInsideRoot(dir, filePath, mismatchedStat);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeFileError);
      expect((error as InstanceType<typeof UnsafeFileError>).reason).toBe('symlink-swapped');
    }
  });
});

describe('validateOpenedPathInsideRootAsync', () => {
  it('passes for a contained file that was not swapped', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'file.txt');
    await fsp.writeFile(filePath, 'x');
    const stat = actualFs.statSync(filePath);
    await expect(validateOpenedPathInsideRootAsync(dir, filePath, stat)).resolves.toBeUndefined();
  });

  it('rejects escaped-root when the realpath leaves the containment root', async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    const target = path.join(outside, 'secret.txt');
    await fsp.writeFile(target, 'x');
    const stat = actualFs.statSync(target);
    const error = await validateOpenedPathInsideRootAsync(dir, target, stat).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnsafeFileError);
    expect((error as InstanceType<typeof UnsafeFileError>).reason).toBe('escaped-root');
  });

  it('throws symlink-swapped when the opened stat does not match the current inode', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'file.txt');
    const otherPath = path.join(dir, 'other.txt');
    await fsp.writeFile(filePath, 'x');
    await fsp.writeFile(otherPath, 'y');
    // A stat from a *different* file stands in for the "opened" stat, so the
    // dev/ino re-stat of the real path will not match — the swap signal.
    const mismatchedStat = actualFs.statSync(otherPath);
    const error = await validateOpenedPathInsideRootAsync(dir, filePath, mismatchedStat).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnsafeFileError);
    expect((error as InstanceType<typeof UnsafeFileError>).reason).toBe('symlink-swapped');
  });
});
