// __tests__/session-lock.test.ts
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, readFile, rm, realpath, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginSessionLock, PluginSessionLockTimeoutError } from '../src/session-lock.js';

describe('PluginSessionLock', () => {
  let cwd: string;
  let lockFile: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'rd-plugin-lock-'));
    // The lock realpath-resolves the project root (macOS tmpdir is a symlink),
    // so the expected lock path must be computed from the resolved root too.
    const root = await realpath(cwd);
    lockFile = join(root, '.claude', 'session', 'locks', 'state.lock');
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('acquire creates a PID-stamped lock file under .claude/session/locks', async () => {
    const lock = new PluginSessionLock(cwd);
    await lock.acquire();
    const content = JSON.parse(await readFile(lockFile, 'utf-8')) as { pid: number };
    expect(content.pid).toBe(process.pid);
    await lock.release();
    await expect(stat(lockFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('scope() releases on await using disposal, including on throw', async () => {
    const lock = new PluginSessionLock(cwd);
    await expect(
      (async () => {
        await using _guard = await lock.scope();
        await expect(stat(lockFile)).resolves.toBeDefined();
        throw new Error('work failed');
      })(),
    ).rejects.toThrow('work failed');
    // Lock released despite the throw — no bare finally required (RD-102 policy).
    await expect(stat(lockFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('release is idempotent when the lock file is already gone', async () => {
    const lock = new PluginSessionLock(cwd);
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('reclaims a stale lock owned by a dead process', async () => {
    const root = await realpath(cwd);
    const lockDir = join(root, '.claude', 'session', 'locks');
    await mkdir(lockDir, { recursive: true });
    // Dead-pid simulation without spawning: PID 1 is init/launchd — kill(1, 0) from an
    // unprivileged test process raises EPERM, which isProcessAlive treats as
    // alive; instead use a PID from the far end of the space that cannot be a
    // live process on either platform runner. If this proves flaky, spawn and
    // reap a child to obtain a genuinely dead PID.
    await writeFile(
      join(lockDir, 'state.lock'),
      JSON.stringify({ pid: 2 ** 22 + 1, created_at: new Date().toISOString() }),
      'utf-8',
    );
    const lock = new PluginSessionLock(cwd);
    await lock.acquire();
    const content = JSON.parse(await readFile(lockFile, 'utf-8')) as { pid: number };
    expect(content.pid).toBe(process.pid);
    await lock.release();
  });

  it('maps the core timeout to PluginSessionLockTimeoutError when the holder is alive', async () => {
    jest.setTimeout(10_000);
    const root = await realpath(cwd);
    const lockDir = join(root, '.claude', 'session', 'locks');
    await mkdir(lockDir, { recursive: true });
    // A lock held by THIS live process is never reclaimed — acquire must
    // exhaust the 5s deadline and surface the typed subclass.
    await writeFile(
      join(lockDir, 'state.lock'),
      JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }),
      'utf-8',
    );
    const lock = new PluginSessionLock(cwd);
    await expect(lock.acquire()).rejects.toBeInstanceOf(PluginSessionLockTimeoutError);
  });

  it('serializes contending critical sections (no interleaving)', async () => {
    const events: string[] = [];
    const worker = async (id: string): Promise<void> => {
      const lock = new PluginSessionLock(cwd);
      await lock.acquire();
      await using _guard = lock.held();
      events.push(`${id}:enter`);
      await new Promise((resolve) => setTimeout(resolve, 25));
      events.push(`${id}:exit`);
    };
    await Promise.all([worker('a'), worker('b')]);
    expect(events).toHaveLength(4);
    // Every enter is immediately followed by the SAME worker's exit.
    expect(events[1]).toBe(events[0].replace(':enter', ':exit'));
    expect(events[3]).toBe(events[2].replace(':enter', ':exit'));
  });
});
