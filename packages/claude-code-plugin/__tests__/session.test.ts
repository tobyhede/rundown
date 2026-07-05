// packages/claude-code-plugin/__tests__/session.test.ts
import { Session } from '../src/session.js';
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

describe('Session', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(join(tmpdir(), 'rundown-test-session-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    test('writes state file under .claude/session', async () => {
      const session = new Session(testDir);
      await session.set('active_command', '/execute');
      const expected = join(testDir, '.claude', 'session', 'state.json');
      const exists = await fs
        .access(expected)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('get/set', () => {
    test('set and get scalar value', async () => {
      const session = new Session(testDir);
      await session.set('active_command', '/execute');

      const value = await session.get('active_command');
      expect(value).toBe('/execute');
    });

    test('get returns null for unset values', async () => {
      const session = new Session(testDir);
      const value = await session.get('active_skill');
      expect(value).toBeNull();
    });

    test('set multiple values independently', async () => {
      const session = new Session(testDir);
      await session.set('active_command', '/execute');
      await session.set('active_skill', 'executing-plans');

      expect(await session.get('active_command')).toBe('/execute');
      expect(await session.get('active_skill')).toBe('executing-plans');
    });
  });

  describe('append/contains', () => {
    test('append adds value to array', async () => {
      const session = new Session(testDir);
      await session.append('edited_files', 'main.ts');
      await session.append('edited_files', 'lib.ts');

      const files = await session.get('edited_files');
      expect(files).toEqual(['main.ts', 'lib.ts']);
    });

    test('append deduplicates values', async () => {
      const session = new Session(testDir);
      await session.append('edited_files', 'main.ts');
      await session.append('edited_files', 'lib.ts');
      await session.append('edited_files', 'main.ts'); // Duplicate

      const files = await session.get('edited_files');
      expect(files).toEqual(['main.ts', 'lib.ts']);
    });

    test('contains returns true for existing value', async () => {
      const session = new Session(testDir);
      await session.append('file_extensions', 'ts');
      await session.append('file_extensions', 'js');

      expect(await session.contains('file_extensions', 'ts')).toBe(true);
      expect(await session.contains('file_extensions', 'js')).toBe(true);
    });

    test('contains returns false for missing value', async () => {
      const session = new Session(testDir);
      await session.append('file_extensions', 'ts');

      expect(await session.contains('file_extensions', 'rs')).toBe(false);
    });
  });

  describe('clear', () => {
    test('removes state file', async () => {
      const session = new Session(testDir);
      await session.set('active_command', '/execute');

      const stateFile = join(testDir, '.claude', 'session', 'state.json');
      const exists = await fs
        .access(stateFile)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      await session.clear();

      const existsAfter = await fs
        .access(stateFile)
        .then(() => true)
        .catch(() => false);
      expect(existsAfter).toBe(false);
    });

    test('is safe when file does not exist', async () => {
      const session = new Session(testDir);
      await expect(session.clear()).resolves.not.toThrow();
    });
  });

  describe('persistence', () => {
    test('state persists across Session instances', async () => {
      const session1 = new Session(testDir);
      await session1.set('active_command', '/plan');
      await session1.append('edited_files', 'main.ts');

      const session2 = new Session(testDir);
      expect(await session2.get('active_command')).toBe('/plan');
      expect(await session2.get('edited_files')).toEqual(['main.ts']);
    });
  });

  describe('atomic writes', () => {
    test('uses atomic rename', async () => {
      const session = new Session(testDir);
      await session.set('active_command', '/execute');

      const stateDir = join(testDir, '.claude', 'session');
      const files = await fs.readdir(stateDir);

      // Should only have state.json, no .tmp files
      expect(files).toContain('state.json');
      expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);

      // State file should exist
      const stateFile = join(stateDir, 'state.json');
      const stateExists = await fs
        .access(stateFile)
        .then(() => true)
        .catch(() => false);
      expect(stateExists).toBe(true);
    });
  });

  describe('error scenarios', () => {
    test('handles corrupted JSON gracefully', async () => {
      const session = new Session(testDir);
      const stateFile = join(testDir, '.claude', 'session', 'state.json');

      // Create directory and write corrupted JSON
      await fs.mkdir(dirname(stateFile), { recursive: true });
      await fs.writeFile(stateFile, '{invalid json', 'utf-8');

      // Should reinitialize state on corruption
      const value = await session.get('active_command');
      expect(value).toBeNull();
    });

    test('handles cross-process persistence', async () => {
      // Simulate separate process invocations
      const session1 = new Session(testDir);
      await session1.set('active_command', '/execute');
      await session1.append('edited_files', 'main.ts');

      // Create new session instance (simulates new process)
      const session2 = new Session(testDir);
      expect(await session2.get('active_command')).toBe('/execute');
      expect(await session2.get('edited_files')).toEqual(['main.ts']);
    });

    // NOTE (review-derived, collated warning): this pure-append all-survive
    // assertion is TIMING-DEPENDENT and is NOT the load-bearing defect-1 pin —
    // it can flake green against the buggy code. The deterministic guarantees
    // ride on: the missing-`update()` compile error, the cross-instance
    // interleaved-`update()` test below (fully serialized by the lock), and the
    // real-Session delegation-dispatch.concurrency.test.ts (Task 3). Keep this
    // as a corroborating signal only.
    test('concurrent appends all survive (no lost updates) (#470)', async () => {
      const session = new Session(testDir);

      await Promise.all([
        session.append('edited_files', 'file1.ts'),
        session.append('edited_files', 'file2.ts'),
        session.append('edited_files', 'file3.ts'),
      ]);

      const files = await session.get('edited_files');
      expect([...files].sort()).toEqual(['file1.ts', 'file2.ts', 'file3.ts']);
    });

    test('interleaved metadata updates across separate Session instances all survive (#470)', async () => {
      // Two instances over the same directory model two concurrent hook processes
      // (each hook invocation is a separate OS process sharing only the state file).
      const a = new Session(testDir);
      const b = new Session(testDir);
      const agents = ['agent-1', 'agent-2', 'agent-3', 'agent-4'];

      await Promise.all(
        agents.map((id, i) =>
          (i % 2 === 0 ? a : b).update('metadata', (meta) => ({
            commit: true,
            value: { ...meta, [id]: `token-${id}` },
            result: undefined,
          })),
        ),
      );

      const meta = await a.get('metadata');
      expect(Object.keys(meta).sort()).toEqual(agents);
    });

    test('clear serializes against an in-flight update (#470)', async () => {
      const a = new Session(testDir);
      const b = new Session(testDir);

      let releaseUpdate: () => void;
      const updateMayFinish = new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
      let updateStarted: () => void;
      const updateHasLock = new Promise<void>((resolve) => {
        updateStarted = resolve;
      });

      const update = a.update('metadata', async (meta) => {
        updateStarted();
        await updateMayFinish;
        return {
          commit: true,
          value: { ...meta, agent: 'recorded' },
          result: undefined,
        };
      });

      await updateHasLock;
      const clear = b.clear();
      releaseUpdate!();
      await Promise.all([update, clear]);

      expect(await a.get('metadata')).toEqual({});
    });

    describe('update', () => {
      test('commit: true persists the new value and returns result', async () => {
        const session = new Session(testDir);
        const result = await session.update('metadata', (meta) => ({
          commit: true,
          value: { ...meta, key: 'value' },
          result: 'committed' as const,
        }));
        expect(result).toBe('committed');
        expect(await session.get('metadata')).toEqual({ key: 'value' });
      });

      test('commit: false leaves persisted state untouched and returns result', async () => {
        const session = new Session(testDir);
        await session.set('metadata', { existing: true });
        const result = await session.update('metadata', () => ({
          commit: false,
          result: 'read-only' as const,
        }));
        expect(result).toBe('read-only');
        expect(await session.get('metadata')).toEqual({ existing: true });
      });

      test('updater throw propagates and does not persist', async () => {
        const session = new Session(testDir);
        await session.set('metadata', { existing: true });
        await expect(
          session.update('metadata', () => {
            throw new Error('updater failed');
          }),
        ).rejects.toThrow('updater failed');
        expect(await session.get('metadata')).toEqual({ existing: true });
        // Lock must have been released on the throw path: the next update succeeds.
        await expect(
          session.update('metadata', (meta) => ({ commit: true, value: meta, result: 'ok' })),
        ).resolves.toBe('ok');
      });
    });
  });

  describe('load error handling', () => {
    it('initializes silently for missing file', async () => {
      const session = new Session(testDir);
      const value = await session.get('active_command');
      expect(value).toBeNull();
    });

    it('logs warning for corrupted JSON', async () => {
      const session = new Session(testDir);
      const stateFile = join(testDir, '.claude', 'session', 'state.json');
      await fs.mkdir(dirname(stateFile), { recursive: true });
      await fs.writeFile(stateFile, '{invalid json}', 'utf-8');

      const value = await session.get('active_command');
      expect(value).toBeNull(); // Should recover
    });

    it('merges partial state with defaults', async () => {
      const session = new Session(testDir);
      const stateFile = join(testDir, '.claude', 'session', 'state.json');
      await fs.mkdir(dirname(stateFile), { recursive: true });
      await fs.writeFile(
        stateFile,
        JSON.stringify({
          session_id: 'existing-123',
          active_command: '/execute',
        }),
        'utf-8',
      );

      const command = await session.get('active_command');
      expect(command).toBe('/execute');

      const files = await session.get('edited_files');
      expect(files).toEqual([]); // Default applied
    });
  });
});
