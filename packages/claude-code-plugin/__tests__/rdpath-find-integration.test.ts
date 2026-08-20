/**
 * Integration coverage for `rdpath`'s directory/context scope resolution.
 *
 * Fixture policy: every "there is (or is not) an active runbook" condition is
 * staged through the SQLite run store, via `@rundown-org/core/testing/*`.
 * `.rundown/session.json` is inert — no build reads or writes it — so a fixture
 * that writes one stages NOTHING: the store opens empty, `rdpath` falls through
 * to `RD_WORK_PATH`, and every assertion about the failure path passes without
 * that path ever being entered. Do not reintroduce one.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  patchPersistedRunState,
  seedActiveRun,
  writeRawRunJson,
} from '@rundown-org/core/testing/session-fixtures';

import { CURRENT_SCHEMA_VERSION } from '@rundown-org/core';

/**
 * A schema version no build writes, so a row carrying it is refused by the
 * version gate rather than parsed.
 *
 * Derived rather than hard-coded, which is the whole of #775: a literal
 * "foreign" version that {@link CURRENT_SCHEMA_VERSION} later catches up to
 * plants VALID state, and the refusal this fixture exists to provoke stops
 * happening with nothing failing to say so.
 */
const FOREIGN_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION + 1;

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

  const ACTIVE_RUNBOOK_MARKDOWN = `# Active Runbook

## 1. Active step

- PASS COMPLETE
- FAIL STOP

Active step.
`;

  /**
   * Seed a real active run through the core session fixtures, which drive the
   * SQLite store the same way `rundown run` does. `variables` is what
   * `readActiveRunScope` reads back as WorkPath / ContextId.
   *
   * @param cwd - Project root receiving the run.
   * @param vars - WorkPath / ContextId the active run should carry.
   * @returns The seeded run id.
   */
  async function setupActiveRunbook(
    cwd: string,
    vars: { WorkPath: string; ContextId: string },
  ): Promise<string> {
    const { runId } = await seedActiveRun(cwd, {
      markdown: ACTIVE_RUNBOOK_MARKDOWN,
      runbookRef: { source: 'project', path: 'active.runbook.md' },
      runbookPath: 'active.runbook.md',
      prompted: true,
      variables: vars,
    });
    return runId;
  }

  /**
   * Open `.rundown/rundown.db` out of band and run `work` against it.
   *
   * Three of the fixtures below need the store to hold bytes this build cannot
   * read — an incompatible `PRAGMA user_version`, session columns that fail
   * `SessionDataSchema`, and a malformed `session_stack` run id. Core's testing
   * fixtures deliberately expose no "corrupt the store" seam for any of them,
   * so these reach for SQLite directly. Everything else goes through the
   * fixtures.
   *
   * `PRAGMA foreign_keys = ON` mirrors the driver constructor
   * (`native-sqlite-driver.ts`), and it is load-bearing rather than decorative:
   * SQLite defaults foreign keys OFF per connection, so without it a fixture
   * could stage a state the product can never reach and the test would prove
   * nothing. Every tamper below is therefore only as damaging as the real
   * schema permits.
   *
   * @param cwd - Project root whose store is opened.
   * @param work - Statements to run against the open database.
   */
  function tamperWithStore(cwd: string, work: (db: DatabaseSync) => void): void {
    const db = new DatabaseSync(path.join(cwd, '.rundown', 'rundown.db'));
    db.exec('PRAGMA foreign_keys = ON');
    try {
      work(db);
    } finally {
      db.close();
    }
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
    /**
     * A project whose active-run lookup FAILS, staged through the SQLite store.
     *
     * Every case here is produced the way the store can actually reach it —
     * `.rundown/session.json` is not read or written by any build that owns this
     * file, so seeding one stages nothing at all: the store opens empty, rdpath
     * falls through to RD_WORK_PATH, and the soft-fail assertion passes without
     * the guard ever running.
     */
    interface UnreadableActiveState {
      /** Names the persisted condition; interpolated into the test titles. */
      readonly what: string;
      /** Puts a fresh project into that condition. */
      readonly seed: (cwd: string) => Promise<void>;
      /**
       * A fragment of the error the lookup REALLY throws for {@link seed}.
       *
       * Asserted on the mandatory-lookup path, where rdpath deliberately does
       * not apply its recoverable-error guard. That pairing is what keeps these
       * cases honest: a fixture that stopped making the lookup throw would still
       * satisfy the soft-fail assertion (there is nothing left to recover from),
       * but it cannot satisfy this one.
       */
      readonly realError: string;
    }

    /**
     * Seed a healthy active run, then break it.
     *
     * The run always carries `ContextId: state-ctx`, so the soft-fail assertions
     * discriminate: a readable run puts a `.rd-state-ctx` segment in the output
     * (see the control test above), and its absence is what proves the lookup
     * was skipped rather than merely satisfied.
     *
     * @param breakIt - Applies the damage to the seeded run.
     * @returns A seeder for {@link UnreadableActiveState.seed}.
     */
    const brokenRun =
      (breakIt: (cwd: string, runId: string) => Promise<void>) =>
      async (cwd: string): Promise<void> => {
        const runId = await setupActiveRunbook(cwd, {
          WorkPath: '.rundown/work',
          ContextId: 'state-ctx',
        });
        await breakIt(cwd, runId);
      };

    /**
     * A run id that no `rundown` write path can produce.
     *
     * `setStack` takes `readonly RunId[]` and `SessionDataSchema.defaultStack`
     * is `z.array(RunIdSchema)`, so this reaches `session_stack` only through
     * out-of-band corruption — the same reachability class as every other
     * `tamperWithStore` fixture here, and exactly the class `rdpath` must
     * tolerate rather than exit non-zero on.
     */
    const MALFORMED_RUN_ID = 'not-a-run-id';

    /**
     * A well-formed run id that is NOT the claim's `controlled_run`.
     *
     * Well-formed on purpose: the point is a row that clears every shape check
     * and fails only the column-against-descriptor mirror.
     */
    const FOREIGN_CHILD_RUN_ID = `rd_${'a'.repeat(32)}`;

    const UNREADABLE_ACTIVE_STATES: readonly UnreadableActiveState[] = [
      {
        what: 'the run state is not valid JSON',
        seed: brokenRun(async (cwd, runId) => {
          await writeRawRunJson(cwd, runId, '{ this is not : valid json');
        }),
        realError: 'persisted state is not valid JSON',
      },
      {
        what: 'the run carries an unsupported schemaVersion',
        seed: brokenRun(async (cwd, runId) => {
          await patchPersistedRunState(cwd, runId, { schemaVersion: FOREIGN_SCHEMA_VERSION });
        }),
        realError: 'invalid schemaVersion',
      },
      {
        what: 'the run is missing templateVars',
        seed: brokenRun(async (cwd, runId) => {
          await patchPersistedRunState(cwd, runId, (current) => {
            const { templateVars: _dropped, ...rest } = current;
            return rest;
          });
        }),
        realError: 'missing templateVars',
      },
      {
        what: 'the run state fails schema validation',
        seed: brokenRun(async (cwd, runId) => {
          await patchPersistedRunState(cwd, runId, { step: 12345 });
        }),
        realError: 'schema validation failed',
      },
      {
        what: 'the run carries a legacy dynamic-step snapshot',
        seed: brokenRun(async (cwd, runId) => {
          await patchPersistedRunState(cwd, runId, { lastAction: { type: 'GOTO_NEXT' } });
        }),
        realError: 'dynamic-step snapshots',
      },
      {
        what: 'the session carries claim data this build cannot read',
        seed: brokenRun(async (cwd) => {
          tamperWithStore(cwd, (db) => {
            db.prepare(`UPDATE claims SET grants_json = '[{"bogus":true}]'`).run();
          });
        }),
        realError: 'Session data is invalid for this runbook schema',
      },
      {
        what: 'a claim row contradicts its own delegation linkage',
        seed: brokenRun(async (cwd) => {
          tamperWithStore(cwd, (db) => {
            // #755. The columns and the blob are written from one value, so only
            // out-of-band corruption separates them — and core rejects the row at
            // the store's edge, BEFORE `SessionDataSchema` sees it. That is why
            // this needs its own `instanceof` arm: the child half used to land on
            // the "Session data is invalid" fixture above and no longer does.
            db.prepare('UPDATE claims SET delegation_json = :json').run({
              json: JSON.stringify({
                childRunId: FOREIGN_CHILD_RUN_ID,
                parentRunId: `rd_${'b'.repeat(32)}`,
                parentStepId: '1',
                parentStep: '1',
                parentFrameKey: '1|0',
                parentEntry: 1,
                tokenHash: `sha256:${'c'.repeat(64)}`,
              }),
            });
          });
        }),
        // The id from the blob, which appears only in the typed refusal's
        // message — proof the abort came from the column/descriptor mirror and
        // not from some earlier shape check that would pass on a repaired row.
        realError: FOREIGN_CHILD_RUN_ID,
      },
      {
        what: 'the session stack carries a malformed run id',
        seed: brokenRun(async (cwd, runId) => {
          tamperWithStore(cwd, (db) => {
            // `session_stack`'s foreign key forbids a DANGLING run id, not a
            // MALFORMED one — `runs.id` is `TEXT PRIMARY KEY NOT NULL` with no
            // format CHECK. Inserting a `runs` row that CARRIES the malformed
            // id satisfies the key (`PRAGMA foreign_key_check` reports nothing,
            // and this connection has foreign keys ON), so the session read
            // reaches `assertRunId` and fails on branding instead of on
            // referential integrity. Pointing the stack at an id with no `runs`
            // row would instead be refused by SQLite, which is why the row is
            // cloned first.
            db.prepare(
              `INSERT INTO runs (id, state_version, claim_generation, lifecycle,
                                 state_json, created_at, updated_at)
               SELECT :malformed, state_version, claim_generation, lifecycle,
                      state_json, created_at, updated_at
                 FROM runs WHERE id = :runId`,
            ).run({ malformed: MALFORMED_RUN_ID, runId });
            db.prepare('UPDATE session_stack SET run_id = :malformed').run({
              malformed: MALFORMED_RUN_ID,
            });
          });
        }),
        // The offending value itself, which ONLY the typed `InvalidRunIdError`
        // carries — the bare `Error` this replaced said just "Invalid run id:
        // expected rd_<32 lowercase hex chars>" with no id in it. Asserting the
        // value here is what stops this fixture from passing against a
        // reinstated message-fragment match.
        realError: MALFORMED_RUN_ID,
      },
      {
        what: 'the database carries an incompatible schema version',
        seed: brokenRun(async (cwd) => {
          tamperWithStore(cwd, (db) => {
            db.exec('PRAGMA user_version = 9');
          });
        }),
        realError: 'Incompatible runbook database schema',
      },
      {
        what: 'the database file is not a database',
        seed: async (cwd) => {
          await fs.mkdir(path.join(cwd, '.rundown'), { recursive: true });
          await fs.writeFile(path.join(cwd, '.rundown', 'rundown.db'), 'not a database at all');
        },
        realError: 'file is not a database',
      },
      {
        what: '.rundown is a regular file',
        seed: async (cwd) => {
          await fs.writeFile(path.join(cwd, '.rundown'), 'not a directory');
        },
        realError: 'EEXIST',
      },
    ];

    describe.each(UNREADABLE_ACTIVE_STATES)(
      'unreadable active state: $what',
      ({ seed, realError }: UnreadableActiveState) => {
        it('surfaces the real error when the active-state lookup is mandatory', async () => {
          // No --dir and no RD_WORK_PATH: the lookup is the only source of a base
          // directory, so rdpath runs it OUTSIDE the recoverable-error guard and
          // the user sees the real cause.
          await seed(testDir);

          const result = await runRdpath(
            ['--file', 'plan.json'],
            {
              RD_WORK_PATH: undefined,
              RD_CONTEXT_ID: undefined,
            },
            testDir,
          );

          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain('error:');
          expect(result.stderr).toContain(realError);
        });

        it('soft-fails the best-effort ContextId lookup when RD_WORK_PATH is set', async () => {
          // Asymmetric case: dir is known, only ctx is missing. The lookup is
          // best-effort, so the unreadable state is skipped and the path
          // assembles without a context segment.
          await seed(testDir);

          const result = await runRdpath(
            ['--file', 'plan.json'],
            {
              RD_WORK_PATH: '.work',
              RD_CONTEXT_ID: undefined,
            },
            testDir,
          );

          expect(result.exitCode).toBe(0);
          expect(normalizeOutputPath(result.stdout)).toMatch(
            /^\.work\/\d{4}-\d{2}-\d{2}-plan\.json$/,
          );
          expect(result.stderr).toBe('');
        });
      },
    );

    const seedUnreadableRun = UNREADABLE_ACTIVE_STATES[0].seed;

    it('soft-fails the best-effort ContextId lookup when --dir is supplied', async () => {
      // --dir is the flag counterpart of the RD_WORK_PATH case above.
      await seedUnreadableRun(testDir);

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

    it('find subcommand soft-fails the best-effort ContextId lookup', async () => {
      // The soft-fail lives in shared scope resolution, so it must hold for
      // `find` and not only for the default path-assembly command.
      await seedUnreadableRun(testDir);
      const workDir = path.join(testDir, 'work');
      await fs.mkdir(workDir, { recursive: true });
      await fs.writeFile(path.join(workDir, 'result.json'), '{}');

      const result = await runRdpath(
        ['find', '*.json'],
        {
          RD_WORK_PATH: workDir,
          RD_CONTEXT_ID: undefined,
        },
        testDir,
      );

      // Matches without a context segment - no 'error:' on stderr.
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(path.join(workDir, 'result.json'));
      expect(result.stderr).toBe('');
    });
  });
});
