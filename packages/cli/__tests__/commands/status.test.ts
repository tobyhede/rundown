import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createTestWorkspace,
  runCliInProcess,
  requireOwnerToken,
  requireRunId,
  parseFinalCliJsonObject,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { validateStatusOutput } from '../helpers/schema-validator.js';
import {
  FOREIGN_SCHEMA_VERSION,
  patchPersistedRunState,
} from '@rundown-org/core/testing/run-fixtures';
import { Command } from 'commander';
// Stryker static-import linkage (mutation testing): links this test file into
// Jest's static inverse-module graph so `--findRelatedTests src/commands/status.ts`
// credits the behavioural tests below (which reach the command only via the
// dynamic `import('../cli.js')` seam in runCliInProcess).
import { registerStatusCommand } from '../../src/commands/status.js';

describe('status command wiring', () => {
  it('registers the status command with its documented flags and descriptions', () => {
    const program = new Command();
    registerStatusCommand(program);

    const status = program.commands.find((c) => c.name() === 'status');
    expect(status).toBeDefined();
    expect(status?.description()).toBe('Show run state (all runs, or one run with --run)');

    const byLong = new Map(status!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()].sort()).toEqual(['--run', '--text']);
    expect(byLong.get('--run')?.description).toBe('Show one run in detail');
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
    // Status is read-only: it never takes a token.
    expect(byLong.has('--token')).toBe(false);
  });
});

async function startPrompted(
  workspace: TestWorkspace,
  runbook = 'runbooks/simple.runbook.md',
  extra = '',
): Promise<{ runId: string; token: string }> {
  const start = await runCliInProcess(`run --prompted ${runbook}${extra}`, workspace);
  expect(start.exitCode).toBe(0);
  return { runId: requireRunId(start.stdout), token: requireOwnerToken(start.stdout) };
}

describe('status command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('displays current step info for one run', async () => {
    const { runId } = await startPrompted(workspace);

    const result = await runCliInProcess(`status --run ${runId} --text`, workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## 1.');
    expect(result.stdout).toContain('First step');
  });

  it('shows runbook file path', async () => {
    const { runId } = await startPrompted(workspace);

    const result = await runCliInProcess(`status --run ${runId} --text`, workspace);

    expect(result.stdout).toContain('File:');
    expect(result.stdout).toContain('simple.runbook.md');
  });

  it('shows runbook ID', async () => {
    const { runId } = await startPrompted(workspace);

    const result = await runCliInProcess(`status --run ${runId} --text`, workspace);

    expect(result.stdout).toContain('State:');
    expect(result.stdout).toContain(runId);
  });

  it('never prints the owner token', async () => {
    const { runId, token } = await startPrompted(workspace);

    const detail = await runCliInProcess(`status --run ${runId}`, workspace);
    const list = await runCliInProcess('status', workspace);
    const text = await runCliInProcess(`status --run ${runId} --text`, workspace);

    for (const result of [detail, list, text]) {
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain(token);
      expect(result.stdout).not.toContain('rdo_');
    }
  });

  it('lists every run bare with id, runbook, lifecycle and position', async () => {
    const first = await startPrompted(workspace);
    const second = await startPrompted(workspace, 'runbooks/retry.runbook.md');
    const stop = await runCliInProcess(`stop --token ${second.token}`, workspace);
    expect(stop.exitCode).toBe(1);

    const result = await runCliInProcess('status', workspace);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(validateStatusOutput(output)).toEqual({ valid: true, errors: [] });
    expect(output.kind).toBe('status');
    expect(output.active).toBe(false);
    expect(output.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.runId,
          runbook: 'runbooks/simple.runbook.md',
          status: 'running',
          step: '1',
        }),
        expect.objectContaining({
          id: second.runId,
          runbook: 'runbooks/retry.runbook.md',
          status: 'stopped',
        }),
      ]),
    );
    expect(output.runs).toHaveLength(2);
  });

  it('still lists every run when one run cannot be rendered, omitting only its total', async () => {
    // R6: the list must not re-render every run's source to count steps, and
    // one row whose stored source is unusable must degrade that row rather
    // than take down the whole listing.
    await writeFile(
      join(workspace.cwd, 'for-bound.runbook.md'),
      `# For Bound

## 1. Loop
- FOR item IN 1 TO {{N}}

### 1.1 Handle
Handle {{item}}.

## 2. Done
Finish.
`,
    );
    const healthy = await startPrompted(workspace);
    const missingSrc = await startPrompted(workspace, 'runbooks/retry.runbook.md');
    const badBound = await startPrompted(workspace, 'for-bound.runbook.md', ' --input N=2');

    await patchPersistedRunState(workspace.cwd, missingSrc.runId, (current) => {
      const { runbookSrc: _dropped, ...rest } = current;
      return rest;
    });
    // A FOR bound that no longer resolves makes rendering throw; counting the
    // numbered steps needs only the parse.
    await patchPersistedRunState(workspace.cwd, badBound.runId, (current) => ({
      ...current,
      templateVars: { ...(current.templateVars as Record<string, unknown>), N: 'not-a-number' },
    }));

    const result = await runCliInProcess('status', workspace);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(validateStatusOutput(output)).toEqual({ valid: true, errors: [] });
    expect(output.runs).toHaveLength(3);
    const byId = new Map(
      (output.runs as { id: string }[]).map((run) => [run.id, run as Record<string, unknown>]),
    );
    expect(byId.get(healthy.runId)).toMatchObject({ status: 'running', step: '1', total: 2 });
    expect(byId.get(missingSrc.runId)).toMatchObject({
      runbook: 'runbooks/retry.runbook.md',
      status: 'running',
      step: '1',
    });
    expect(byId.get(missingSrc.runId)).not.toHaveProperty('total');
    expect(byId.get(badBound.runId)).toMatchObject({ status: 'running', step: '1.1', total: 2 });
  });

  it('reports a finished run as inactive with its lifecycle in detail form', async () => {
    const { runId, token } = await startPrompted(workspace);
    const complete = await runCliInProcess(`complete --token ${token}`, workspace);
    expect(complete.exitCode).toBe(0);

    const result = await runCliInProcess(`status --run ${runId}`, workspace);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(validateStatusOutput(output)).toEqual({ valid: true, errors: [] });
    expect(output.active).toBe(false);
    expect(output.status).toBe('completed');
    expect(output.runId).toBe(runId);
  });

  it('refuses an unknown --run with RUN_TARGET_UNAVAILABLE', async () => {
    const result = await runCliInProcess(
      'status --run rd_00000000000000000000000000000000',
      workspace,
    );

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.kind).toBe('error');
    expect(output.code).toBe('RUN_TARGET_UNAVAILABLE');
  });

  it('refuses a malformed --run with INVALID_RUN_ID', async () => {
    const result = await runCliInProcess('status --run not-a-run', workspace);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).code).toBe('INVALID_RUN_ID');
  });

  // CLAUDE.md § State Persistence: "The CLI should detect invalid state (via
  // schema version or structural guard) and prompt the user to finish or prune
  // — never silently adapt".
  it('reports invalid persisted state as RD-309 with finish/stop/prune guidance', async () => {
    const { runId } = await startPrompted(workspace);

    await patchPersistedRunState(workspace.cwd, runId, {
      schemaVersion: FOREIGN_SCHEMA_VERSION,
    });

    const result = await runCliInProcess(`status --run ${runId}`, workspace);

    expect(result.exitCode).not.toBe(0);

    const output = result.stderr.trim() || result.stdout.trim();
    const error = JSON.parse(output) as {
      kind?: string;
      error?: string;
      code?: string;
      details?: { title?: string };
    };

    expect(error.kind).toBe('error');
    expect(error.code).toBe('RD-309');
    expect(error.details?.title).not.toBe('Unknown error');
    // The diagnosed cause survives …
    expect(error.error).toMatch(/invalid schemaVersion/i);
    // … alongside the recovery, in the default JSON envelope rather than only
    // in the `--text --verbose` description.
    expect(error.error).toMatch(/rundown prune/);
  });

  // The recovery the envelope names must actually work on the state that
  // produced it, or the instruction is worse than none.
  it('accepts the prune recovery the RD-309 envelope names', async () => {
    const { runId } = await startPrompted(workspace);

    await patchPersistedRunState(workspace.cwd, runId, {
      schemaVersion: FOREIGN_SCHEMA_VERSION,
    });

    const pruned = await runCliInProcess('prune --inactive', workspace);
    expect(pruned.exitCode).toBe(0);
    expect(JSON.parse(pruned.stdout)).toEqual([
      expect.objectContaining({ id: runId, status: 'invalid' }),
    ]);

    const result = await runCliInProcess('status', workspace);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).runs).toEqual([]);
  });

  describe('incompatible database schema (RD-305)', () => {
    // A schema version this build cannot read (neither 0/fresh nor the current
    // SCHEMA_VERSION). Seed the store as the FIRST open in this process:
    // `ensureSchema` runs in `openRunbookDriver` on that first open and rejects
    // the version before any query, so both read-only and mutating commands
    // surface RD-305. (Seeding via a prior `run` would cache the store and skip
    // the re-check.)
    const INCOMPATIBLE_VERSION = 99;

    async function seedIncompatibleDatabase(): Promise<void> {
      await mkdir(join(workspace.cwd, '.rundown'), { recursive: true });
      const db = new DatabaseSync(join(workspace.cwd, '.rundown', 'rundown.db'));
      db.exec(`PRAGMA user_version = ${String(INCOMPATIBLE_VERSION)}`);
      db.close();
    }

    type ErrorEnvelope = {
      kind?: string;
      code?: string;
      error?: string;
      details?: { category?: string; context?: Record<string, unknown> };
    };

    function parseError(result: { stdout: string; stderr: string }): ErrorEnvelope {
      return JSON.parse(result.stderr.trim() || result.stdout.trim()) as ErrorEnvelope;
    }

    it('refuses a read-only command with a typed RD-305 envelope naming the database file', async () => {
      await seedIncompatibleDatabase();

      const result = await runCliInProcess('status', workspace);

      expect(result.exitCode).not.toBe(0);
      const error = parseError(result);
      expect(error.kind).toBe('error');
      expect(error.code).toBe('RD-305');
      expect(error.code).not.toBe('RD-999');
      expect(error.details?.category).toBe('STATE');
      expect(error.details?.context).toMatchObject({ foundVersion: INCOMPATIBLE_VERSION });
      expect(error.error).toMatch(/\.rundown\/rundown\.db/);
    });

    it('refuses a mutating command with the same RD-305 envelope', async () => {
      await seedIncompatibleDatabase();

      const result = await runCliInProcess(
        'pass --token rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA --step 1',
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      const error = parseError(result);
      expect(error.code).toBe('RD-305');
      expect(error.details?.category).toBe('STATE');
    });
  });

  it('outputs "No runs." in text mode when there are none', async () => {
    const result = await runCliInProcess('status --text', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No runs.');
  });

  it('outputs an empty run list in JSON when there are none', async () => {
    const result = await runCliInProcess('status', workspace);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(validateStatusOutput(output)).toEqual({ valid: true, errors: [] });
    expect(output).toEqual({ kind: 'status', active: false, runs: [] });
  });

  it('renders the run list as a table in text mode', async () => {
    const { runId } = await startPrompted(workspace);

    const result = await runCliInProcess('status --text', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ID');
    expect(result.stdout).toContain('STATUS');
    expect(result.stdout).toContain(runId);
    expect(result.stdout).toContain('running');
    expect(result.stdout).toContain('simple.runbook.md');
  });
});

describe('JSON lastAction.result semantics', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function lastActionAfter(
    runbook: string,
    transition: 'pass' | 'fail',
  ): Promise<{ action: string; result: string }> {
    const { runId, token } = await startPrompted(workspace, runbook);
    const applied = await runCliInProcess(`${transition} --token ${token} --step 1`, workspace);
    expect(applied.exitCode).toBe(0);

    const result = await runCliInProcess(`status --run ${runId}`, workspace);
    const output = JSON.parse(result.stdout);
    expect(output.lastAction).toBeDefined();
    return output.lastAction as { action: string; result: string };
  }

  it('reports lastAction.result PASS after successful pass', async () => {
    const lastAction = await lastActionAfter('runbooks/simple.runbook.md', 'pass');
    expect(lastAction.result).toBe('PASS');
    expect(lastAction.action).toBe('CONTINUE');
  });

  it('reports lastAction.result FAIL after fail triggers RETRY', async () => {
    const lastAction = await lastActionAfter('runbooks/retry.runbook.md', 'fail');
    expect(lastAction.result).toBe('FAIL');
    expect(lastAction.action).toMatch(/^RETRY/);
  });

  it('reports lastAction.result PASS after pass triggers GOTO', async () => {
    const lastAction = await lastActionAfter('runbooks/goto.runbook.md', 'pass');
    expect(lastAction.result).toBe('PASS');
    expect(lastAction.action).toMatch(/^GOTO/);
  });

  it('reports lastAction.result FAIL after fail triggers GOTO', async () => {
    const lastAction = await lastActionAfter('runbooks/fail-goto.runbook.md', 'fail');
    expect(lastAction.result).toBe('FAIL');
    expect(lastAction.action).toMatch(/^GOTO/);
  });
});

describe('complete command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('marks the run as complete', async () => {
    const { runId, token } = await startPrompted(workspace);

    const result = await runCliInProcess(`complete --token ${token} --text`, workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('COMPLETE');

    const status = await runCliInProcess(`status --run ${runId}`, workspace);
    expect(JSON.parse(status.stdout).status).toBe('completed');
  });

  it('includes message in JSON output', async () => {
    const { token } = await startPrompted(workspace);

    const result = await runCliInProcess(
      ['complete', '--token', token, 'Early exit - tests passed'],
      workspace,
    );

    // complete streams a runbook_completed observation before the final
    // action object, so parse the final newline-delimited JSON object.
    const output = parseFinalCliJsonObject(result.stdout);
    expect(output.message).toBe('Early exit - tests passed');
  });

  it('uses default message when none provided', async () => {
    const { token } = await startPrompted(workspace);

    const result = await runCliInProcess(`complete --token ${token}`, workspace);

    const output = parseFinalCliJsonObject(result.stdout);
    expect(output.message).toBe('Runbook completed successfully');
  });
});

describe('status with runbookSrc', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('should compute step total from runbookSrc', async () => {
    // Create a runbook with variable
    const runbookContent = `# Test Runbook

## 1. First Step
- PASS CONTINUE

\`\`\`bash
rd echo {{message}}
\`\`\`

## 2. Second Step
- PASS COMPLETE

\`\`\`bash
rd echo done
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    // Run with variable to store runbookSrc
    const { runId } = await startPrompted(workspace, 'test.runbook.md', ' --input message=hello');

    // Delete the source file to prove we're using runbookSrc, not disk
    await rm(join(workspace.cwd, 'test.runbook.md'));

    // Status should work using runbookSrc (not disk fallback)
    const result = await runCliInProcess(`status --run ${runId}`, workspace);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.position.total).toBe(2);
  });
});
