import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunbookStateManager, SessionService, parseRunbook, type Runbook } from '@rundown-org/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageDir = path.resolve(__dirname, '..');
const rdpathScript = path.join(packageDir, 'dist', 'rdpath.js');

describe('rdpath find integration', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rdpath-find-int-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const runRdpath = (
    args: string[],
    env?: Record<string, string | undefined>,
    cwd = packageDir,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    return new Promise((resolve, reject) => {
      // Strip rundown-injected vars from inherited host env so a developer or
      // CI shell with RD_WORK_PATH / RD_CONTEXT_ID exported can't mask the
      // assertions in this file. Callers reintroduce them via `env` when the
      // test specifically needs them.
      const sanitizedHost = { ...process.env };
      delete sanitizedHost.RD_WORK_PATH;
      delete sanitizedHost.RD_CONTEXT_ID;
      delete sanitizedHost.RD_RUN_ID;
      const merged = env ? { ...sanitizedHost, ...env } : sanitizedHost;
      const spawnEnv = Object.fromEntries(
        Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      const proc = spawn('node', [rdpathScript, ...args], {
        cwd,
        env: spawnEnv,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      proc.on('error', reject);
    });
  };

  const normalizeOutputPath = (value: string): string => value.trim().replaceAll('\\', '/');

  async function setupActiveRunbook(
    cwd: string,
    vars: { WorkPath: string; ContextId: string },
  ): Promise<void> {
    const manager = new RunbookStateManager(cwd);
    const sessionService = new SessionService(manager);
    const steps = parseRunbook(`## 1. Active step

- PASS COMPLETE
- FAIL STOP

Active step.
`);
    const runbook: Runbook = {
      title: 'Active Runbook',
      steps,
    };

    const state = await manager.create({ source: 'project', path: 'active.runbook.md' }, runbook, {
      runbookPath: 'active.runbook.md',
      prompted: true,
      templateVars: vars,
    });
    await sessionService.pushRunbook(state.id);
  }

  async function setupStaleActiveRunbook(cwd: string): Promise<void> {
    const runId = 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const runsDir = path.join(cwd, '.rundown', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.rundown', 'session.json'),
      JSON.stringify({ defaultStack: [runId] }, null, 2),
    );
    await fs.writeFile(
      path.join(runsDir, `${runId}.json`),
      JSON.stringify({ schemaVersion: 1 }, null, 2),
    );
  }

  async function setupActiveRunbookWithInvalidId(cwd: string): Promise<void> {
    await fs.mkdir(path.join(cwd, '.rundown'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.rundown', 'session.json'),
      JSON.stringify({ defaultStack: ['../outside'] }, null, 2),
    );
  }

  it('outputs one matching path per line', async () => {
    await fs.writeFile(path.join(testDir, '2026-03-17-pass1.md'), '');
    await fs.writeFile(path.join(testDir, '2026-03-17-pass2.md'), '');
    await fs.writeFile(path.join(testDir, '2026-03-17-fail.md'), '');

    const result = await runRdpath(['--dir', testDir, 'find', '*-pass*.md']);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('pass1.md');
    expect(lines[1]).toContain('pass2.md');
  });

  it('exits 1 with empty stdout and empty stderr when nothing matches', async () => {
    // `rdpath find` is purpose-built for runbook flow control; the default
    // treats an empty match set as a negative answer. Stderr stays empty so
    // callers can distinguish "no matches" from a real error (which writes
    // `error:` to stderr).
    const result = await runRdpath(['--dir', testDir, 'find', '*.md']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('exits 0 with no output when nothing matches and --allow-empty is set', async () => {
    const result = await runRdpath(['--dir', testDir, 'find', '--allow-empty', '*.md']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('--allow-empty still exits 0 when matches are present', async () => {
    await fs.writeFile(path.join(testDir, 'has-match.md'), '');

    const result = await runRdpath(['--dir', testDir, 'find', '--allow-empty', '*.md']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('has-match.md');
  });

  it('exits 1 with error to stderr for invalid pattern', async () => {
    const result = await runRdpath(['--dir', testDir, 'find', '../*.md']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('error:');
  });

  it('exits 1 with error to stderr for nonexistent directory', async () => {
    const result = await runRdpath(['--dir', path.join(testDir, 'nope'), 'find', '*.md']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Directory not found');
  });

  it('supports ctx scoping', async () => {
    const ctxDir = path.join(testDir, '.rd-test-ctx');
    await fs.mkdir(ctxDir);
    await fs.writeFile(path.join(ctxDir, 'found.md'), '');

    const result = await runRdpath(['--dir', testDir, '--ctx', 'test-ctx', 'find', '*.md']);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('.rd-test-ctx');
    expect(lines[0]).toContain('found.md');
  });

  describe('backward compatibility', () => {
    it('rdpath --dir still works as default path subcommand', async () => {
      const result = await runRdpath(['--dir', '.work']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('.work');
    });

    it('rdpath --dir --ctx still works', async () => {
      const result = await runRdpath(['--dir', '.work', '--ctx', 'abc123']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(path.join('.work', '.rd-abc123'));
    });
  });

  describe('env var fallback (RD_WORK_PATH, RD_CONTEXT_ID)', () => {
    it('uses RD_WORK_PATH when --dir is omitted', async () => {
      await fs.writeFile(path.join(testDir, '2026-03-17-test.md'), '');

      const result = await runRdpath(['find', '*.md'], {
        RD_WORK_PATH: testDir,
        RD_CONTEXT_ID: undefined,
      });

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('test.md');
    });

    it('uses RD_CONTEXT_ID when --ctx is omitted', async () => {
      const ctxDir = path.join(testDir, '.rd-env-ctx');
      await fs.mkdir(ctxDir);
      await fs.writeFile(path.join(ctxDir, 'found.md'), '');

      const result = await runRdpath(['find', '*.md'], {
        RD_WORK_PATH: testDir,
        RD_CONTEXT_ID: 'env-ctx',
      });

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('.rd-env-ctx');
    });

    it('prefers --dir flag over RD_WORK_PATH env var', async () => {
      const altDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rdpath-alt-'));
      try {
        await fs.writeFile(path.join(altDir, 'alt.md'), '');

        const result = await runRdpath(['--dir', altDir, 'find', '*.md'], {
          RD_WORK_PATH: testDir,
          RD_CONTEXT_ID: undefined,
        });

        expect(result.exitCode).toBe(0);
        const lines = result.stdout.trim().split('\n');
        expect(lines[0]).toContain('alt.md');
      } finally {
        await fs.rm(altDir, { recursive: true, force: true });
      }
    });

    it('exits with error when --dir and RD_WORK_PATH are both absent', async () => {
      const result = await runRdpath(['find', '*.md'], {
        RD_WORK_PATH: undefined,
        RD_CONTEXT_ID: undefined,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('RD_WORK_PATH');
    });
  });

  describe('active runbook state fallback', () => {
    it('exits with the standard missing-dir error when no runbook is active', async () => {
      const result = await runRdpath(
        ['--file', 'plan.json'],
        {
          RD_WORK_PATH: undefined,
          RD_CONTEXT_ID: undefined,
        },
        testDir,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('RD_WORK_PATH');
    });

    it('uses active WorkPath and ContextId when flags and env vars are omitted', async () => {
      await setupActiveRunbook(testDir, {
        WorkPath: '.rundown/work',
        ContextId: 'state-ctx',
      });

      const result = await runRdpath(
        ['--file', 'plan.json'],
        {
          RD_WORK_PATH: undefined,
          RD_CONTEXT_ID: undefined,
        },
        testDir,
      );

      expect(result.exitCode).toBe(0);
      expect(normalizeOutputPath(result.stdout)).toMatch(
        /^\.rundown\/work\/\.rd-state-ctx\/\d{4}-\d{2}-\d{2}-plan\.json$/,
      );
    });

    it('uses active WorkPath and ContextId for find when flags and env vars are omitted', async () => {
      await setupActiveRunbook(testDir, {
        WorkPath: '.rundown/work',
        ContextId: 'state-ctx',
      });
      const ctxDir = path.join(testDir, '.rundown', 'work', '.rd-state-ctx');
      await fs.mkdir(ctxDir, { recursive: true });
      await fs.writeFile(path.join(ctxDir, 'found.json'), '');

      const result = await runRdpath(
        ['find', '*.json'],
        {
          RD_WORK_PATH: undefined,
          RD_CONTEXT_ID: undefined,
        },
        testDir,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(
        path.join('.rundown', 'work', '.rd-state-ctx', 'found.json'),
      );
    });

    it('prefers explicit --dir over active WorkPath', async () => {
      await setupActiveRunbook(testDir, {
        WorkPath: '.rundown/work',
        ContextId: 'state-ctx',
      });
      const altDir = path.join(testDir, 'alt-work');
      const altCtxDir = path.join(altDir, '.rd-alt-ctx');
      await fs.mkdir(altCtxDir, { recursive: true });
      await fs.writeFile(path.join(altCtxDir, 'alt.json'), '');

      const result = await runRdpath(
        ['--dir', altDir, '--ctx', 'alt-ctx', 'find', '*.json'],
        {
          RD_WORK_PATH: undefined,
          RD_CONTEXT_ID: undefined,
        },
        testDir,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(path.join(altDir, '.rd-alt-ctx', 'alt.json'));
    });

    it('prefers RD_WORK_PATH over active WorkPath', async () => {
      await setupActiveRunbook(testDir, {
        WorkPath: '.rundown/work',
        ContextId: 'state-ctx',
      });
      const envDir = path.join(testDir, 'env-work');
      const envCtxDir = path.join(envDir, '.rd-env-ctx');
      await fs.mkdir(envCtxDir, { recursive: true });
      await fs.writeFile(path.join(envCtxDir, 'env.json'), '');

      const result = await runRdpath(
        ['find', '*.json'],
        {
          RD_WORK_PATH: envDir,
          RD_CONTEXT_ID: 'env-ctx',
        },
        testDir,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(path.join(envDir, '.rd-env-ctx', 'env.json'));
    });

    it('uses active WorkPath when RD_CONTEXT_ID is set and RD_WORK_PATH is omitted', async () => {
      await setupActiveRunbook(testDir, {
        WorkPath: '.rundown/work',
        ContextId: 'state-ctx',
      });
      const envCtxDir = path.join(testDir, '.rundown', 'work', '.rd-env-ctx');
      await fs.mkdir(envCtxDir, { recursive: true });
      await fs.writeFile(path.join(envCtxDir, 'env-context.json'), '');

      const result = await runRdpath(
        ['find', '*.json'],
        {
          RD_WORK_PATH: undefined,
          RD_CONTEXT_ID: 'env-ctx',
        },
        testDir,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(
        path.join('.rundown', 'work', '.rd-env-ctx', 'env-context.json'),
      );
    });

    it('does not fail on stale active state when --dir is supplied', async () => {
      await setupStaleActiveRunbook(testDir);

      const result = await runRdpath(
        ['--dir', '.work'],
        {
          RD_WORK_PATH: undefined,
          RD_CONTEXT_ID: undefined,
        },
        testDir,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('.work');
      expect(result.stderr).toBe('');
    });

    it('uses active ContextId when RD_WORK_PATH is set and RD_CONTEXT_ID is omitted', async () => {
      await setupActiveRunbook(testDir, {
        WorkPath: '.rundown/work',
        ContextId: 'state-ctx',
      });
      const envDir = path.join(testDir, 'env-work');
      const ctxDir = path.join(envDir, '.rd-state-ctx');
      await fs.mkdir(ctxDir, { recursive: true });
      await fs.writeFile(path.join(ctxDir, 'state-context.json'), '');

      const result = await runRdpath(
        ['find', '*.json'],
        {
          RD_WORK_PATH: envDir,
          RD_CONTEXT_ID: undefined,
        },
        testDir,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(path.join(envDir, '.rd-state-ctx', 'state-context.json'));
    });

    it('soft-fails active-state lookup when RD_WORK_PATH is set with stale state', async () => {
      // Asymmetric case: dir is known via RD_WORK_PATH; ctx lookup hits stale
      // state. The lookup must not propagate the stale-state error — the path
      // assembles without a context segment and exits 0.
      await setupStaleActiveRunbook(testDir);

      const result = await runRdpath(
        ['--file', 'plan.json'],
        {
          RD_WORK_PATH: '.work',
          RD_CONTEXT_ID: undefined,
        },
        testDir,
      );

      expect(result.exitCode).toBe(0);
      expect(normalizeOutputPath(result.stdout)).toMatch(/^\.work\/\d{4}-\d{2}-\d{2}-plan\.json$/);
      expect(result.stderr).toBe('');
    });

    it('soft-fails invalid active-state lookup when RD_WORK_PATH is set', async () => {
      await setupActiveRunbookWithInvalidId(testDir);

      const result = await runRdpath(
        ['--file', 'plan.json'],
        {
          RD_WORK_PATH: '.work',
          RD_CONTEXT_ID: undefined,
        },
        testDir,
      );

      expect(result.exitCode).toBe(0);
      expect(normalizeOutputPath(result.stdout)).toMatch(/^\.work\/\d{4}-\d{2}-\d{2}-plan\.json$/);
      expect(result.stderr).not.toContain('Invalid id');
    });

    it('soft-fails legacy session ownership format when RD_WORK_PATH is set', async () => {
      // SessionService.loadSession throws 'Legacy session ownership format
      // detected' when session.json contains 'ownedRunbooks' (or
      // 'stashedRunbookOwnership'). isRecoverableActiveStateLookupError must
      // recognize this so rdpath assembles a path without a context segment.
      await fs.mkdir(path.join(testDir, '.rundown'), { recursive: true });
      await fs.writeFile(
        path.join(testDir, '.rundown', 'session.json'),
        JSON.stringify({ ownedRunbooks: { 'wf-old-run': { runbookPath: 'foo.md' } } }, null, 2),
      );

      const result = await runRdpath(
        ['--file', 'plan.json'],
        {
          RD_WORK_PATH: '.work',
          RD_CONTEXT_ID: undefined,
        },
        testDir,
      );

      expect(result.exitCode).toBe(0);
      expect(normalizeOutputPath(result.stdout)).toMatch(/^\.work\/\d{4}-\d{2}-\d{2}-plan\.json$/);
      expect(result.stderr).toBe('');
    });

    it('soft-fails legacy stacks session format when RD_WORK_PATH is set', async () => {
      // Second variant of the legacy ownership branch: 'stacks' key triggers
      // the same recoverable error path.
      await fs.mkdir(path.join(testDir, '.rundown'), { recursive: true });
      await fs.writeFile(
        path.join(testDir, '.rundown', 'session.json'),
        JSON.stringify({ stacks: { default: [] } }, null, 2),
      );

      const result = await runRdpath(
        ['--file', 'plan.json'],
        {
          RD_WORK_PATH: '.work',
          RD_CONTEXT_ID: undefined,
        },
        testDir,
      );

      expect(result.exitCode).toBe(0);
      expect(normalizeOutputPath(result.stdout)).toMatch(/^\.work\/\d{4}-\d{2}-\d{2}-plan\.json$/);
      expect(result.stderr).toBe('');
    });

    it('soft-fails session.json that fails schema validation when RD_WORK_PATH is set', async () => {
      // 'Session file contains invalid runbook targeting data' is thrown when
      // session.json parses as JSON but fails SessionDataSchema validation.
      await fs.mkdir(path.join(testDir, '.rundown'), { recursive: true });
      await fs.writeFile(
        path.join(testDir, '.rundown', 'session.json'),
        JSON.stringify({ defaultStack: [{ not: 'a-string' }] }, null, 2),
      );

      const result = await runRdpath(
        ['--file', 'plan.json'],
        {
          RD_WORK_PATH: '.work',
          RD_CONTEXT_ID: undefined,
        },
        testDir,
      );

      expect(result.exitCode).toBe(0);
      expect(normalizeOutputPath(result.stdout)).toMatch(/^\.work\/\d{4}-\d{2}-\d{2}-plan\.json$/);
      expect(result.stderr).toBe('');
    });
  });
});
