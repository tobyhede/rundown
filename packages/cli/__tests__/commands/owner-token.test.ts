/**
 * The Owner Token command seam (#901, ADR 0005), driven through the
 * in-process CLI runner in JSON mode.
 *
 * One writer per run: `rundown run` prints the run's Owner Token exactly
 * once, every mutating command names its run by that token, and status is
 * read-only and token-free.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OwnerTokenSchema,
  RunbookActorService,
  RunbookLifecycleCommandService,
  RunbookStateManager,
} from '@rundown-org/core';
import { parseRunbookDocument } from '@rundown-org/parser';
import {
  createTestWorkspace,
  parseConcatenatedJson,
  requireOwnerToken,
  requireRunId,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

const MANUAL_RUNBOOK = [
  '---',
  'name: manual',
  '---',
  '# Manual',
  '',
  '## 1. First',
  '',
  '- PASS CONTINUE',
  '- FAIL STOP',
  '',
  'Do one.',
  '',
  '## 2. Second',
  '',
  '- PASS COMPLETE',
  '- FAIL STOP',
  '',
  'Do two.',
  '',
].join('\n');

const SUBSTEP_RUNBOOK = [
  '# Substeps',
  '',
  '## 1. Parent',
  '',
  '- PASS ALL COMPLETE',
  '- FAIL ANY STOP',
  '',
  'Has substeps.',
  '',
  '### 1.1 Child one',
  '',
  '- PASS CONTINUE',
  '- FAIL STOP',
  '',
  'Do the first child.',
  '',
  '### 1.2 Child two',
  '',
  '- PASS DEFER',
  '- FAIL DEFER',
  '',
  'Do the second child.',
  '',
].join('\n');

const INLINE_RUNBOOK = [
  '# Inline',
  '',
  '## 1. Parent',
  '',
  '- PASS ALL CONTINUE',
  '- FAIL ANY STOP',
  '',
  '- child.runbook.md',
  '',
  '## 2. After',
  '',
  '- PASS COMPLETE',
  '- FAIL STOP',
  '',
  'Finish.',
  '',
].join('\n');

const CHILD_RUNBOOK = [
  '# Child',
  '',
  '## Check',
  '',
  '- PASS COMPLETE',
  '- FAIL STOP',
  '',
  'Check by hand.',
  '',
].join('\n');

// One substep listing two runbooks: each substep composes one child.
const PAIRED_RUNBOOK = [
  '# Paired',
  '',
  '## 1. Parent',
  '',
  '- PASS ALL COMPLETE',
  '- FAIL ANY STOP',
  '',
  '### 1.1 Both',
  '',
  '- DELEGATE',
  '- child.runbook.md',
  '- child.runbook.md',
  '',
].join('\n');

const UNKNOWN_TOKEN = 'rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function envelopes(stdout: string): Record<string, unknown>[] {
  return parseConcatenatedJson(stdout).filter(
    (value): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value),
  );
}

function errorEnvelope(stdout: string): Record<string, unknown> | undefined {
  return envelopes(stdout).find((document) => document.kind === 'error');
}

describe('owner token command seam (#901)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'manual.runbook.md'), MANUAL_RUNBOOK);
    await writeFile(join(workspace.cwd, 'manual-substeps.runbook.md'), SUBSTEP_RUNBOOK);
    await writeFile(join(workspace.cwd, 'inline.runbook.md'), INLINE_RUNBOOK);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), CHILD_RUNBOOK);
    await writeFile(join(workspace.cwd, 'paired.runbook.md'), PAIRED_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function startManual(): Promise<{ token: string; runId: string; stdout: string }> {
    const start = await runCliInProcess('run manual.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    return {
      token: requireOwnerToken(start.stdout),
      runId: requireRunId(start.stdout),
      stdout: start.stdout,
    };
  }

  describe('rundown run', () => {
    it('prints owner_token on runbook_started exactly once, and nowhere else', async () => {
      const { token, stdout } = await startManual();
      expect(OwnerTokenSchema.safeParse(token).success).toBe(true);
      const carriers = envelopes(stdout).filter((document) => 'owner_token' in document);
      expect(carriers).toHaveLength(1);
      expect(carriers[0]?.type).toBe('runbook_started');
      expect(stdout.match(/rdo_[A-Za-z0-9_-]{43}/g)).toHaveLength(1);
      expect(stdout).not.toContain('claim_id');
    });

    it('prints one "Owner token:" line in text mode', async () => {
      const start = await runCliInProcess('run manual.runbook.md --text', workspace);
      expect(start.exitCode).toBe(0);
      const tokenLines = start.stdout
        .split('\n')
        .filter((line) => line.startsWith('Owner token: '));
      expect(tokenLines).toHaveLength(1);
      expect(OwnerTokenSchema.safeParse(tokenLines[0]?.slice('Owner token: '.length)).success).toBe(
        true,
      );
    });

    it('refuses a substep listing two runbooks as RUNBOOK_COMPOSITION_UNSUPPORTED', async () => {
      const result = await runCliInProcess('run paired.runbook.md', workspace);
      expect(result.exitCode).toBe(1);
      const error = errorEnvelope(result.stdout);
      expect(error?.code).toBe('RUNBOOK_COMPOSITION_UNSUPPORTED');
      expect(error?.details).toEqual({ runbook: 'paired.runbook.md', substeps: ['1.1'] });
      // Refused by core before any row is written, and no token is printed.
      expect(result.stdout).not.toMatch(/rdo_/);
      expect(await new RunbookStateManager(workspace.cwd).listRunIds()).toEqual([]);
    });
  });

  describe('inline children on the parent token (#903)', () => {
    async function startInline(): Promise<{ token: string; root: string; child: string }> {
      const start = await runCliInProcess('run inline.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      const started = envelopes(start.stdout).filter((event) => event.type === 'runbook_started');
      expect(started).toHaveLength(2);
      // The child's start carries no token: its parent's Owner Token authorizes it.
      expect(started[1]).not.toHaveProperty('owner_token');
      return {
        token: requireOwnerToken(start.stdout),
        root: String(started[0]?.runbookId),
        child: String(started[1]?.runbookId),
      };
    }

    it('launches the inline child at run and shows the chain root → child in status, with no secret', async () => {
      const { root, child } = await startInline();

      const list = await runCliInProcess('status', workspace);
      const runs = (envelopes(list.stdout)[0]?.runs ?? []) as Record<string, unknown>[];
      expect(runs.find((run) => run.id === child)).toMatchObject({
        status: 'running',
        parent: { runId: root, step: '1.1', kind: 'inline' },
      });
      expect(runs.find((run) => run.id === root)).not.toHaveProperty('parent');

      const rootDetail = await runCliInProcess(`status --run ${root}`, workspace);
      expect(envelopes(rootDetail.stdout)[0]?.child).toEqual({
        runId: child,
        kind: 'inline',
        status: 'running',
      });
      const childDetail = await runCliInProcess(`status --run ${child}`, workspace);
      expect(envelopes(childDetail.stdout)[0]?.parent).toEqual({
        runId: root,
        step: '1.1',
        kind: 'inline',
      });
      for (const output of [list.stdout, rootDetail.stdout, childDetail.stdout]) {
        expect(output).not.toMatch(/rdo_|rdt_/);
      }
    });

    it("refuses pass --step naming the parent's step while the inline child runs, naming the child", async () => {
      const { token, child } = await startInline();

      const result = await runCliInProcess(`pass --token ${token} --step 1.1`, workspace);

      expect(result.exitCode).toBe(1);
      const error = errorEnvelope(result.stdout);
      expect(error?.code).toBe('INVALID_STEP');
      expect(String(error?.error)).toContain(`inline child ${child}`);
    });

    it('drives the child by the root token and Collects it into the parent in the same command', async () => {
      const { token, root, child } = await startInline();

      const result = await runCliInProcess(`pass --token ${token} --step Check`, workspace);

      expect(result.exitCode).toBe(0);
      const manager = new RunbookStateManager(workspace.cwd);
      expect((await manager.load(child))?.lifecycle).toBe('completed');
      expect((await manager.load(root))?.step).toBe('2');
    });

    it("Collects a terminal child its parent's crashed command left uncollected, before applying the next command", async () => {
      const { token, root, child } = await startInline();
      // The child reaches its terminal in a command whose process dies before
      // the implicit Collect: commit the child's pass through core directly
      // and never activate progression.
      const manager = new RunbookStateManager(workspace.cwd);
      const seam = new RunbookLifecycleCommandService({
        manager,
        actorService: new RunbookActorService(manager),
        loadSteps: (state) => parseRunbookDocument(state.runbookSrc ?? '').runbook.steps as never,
      });
      const owned = await manager.loadWithVersion(child);
      if (owned === null) throw new Error('child missing');
      const applied = await seam.runTransition({
        command: 'pass',
        run: owned,
        target: { stepId: 'Check' },
      });
      expect(applied.kind).toBe('applied');
      expect((await manager.load(root))?.step).toBe('1');

      // The parent's next command Collects first, then applies to step 2.
      const result = await runCliInProcess(`pass --token ${token} --step 2`, workspace);

      expect(result.exitCode).toBe(0);
      expect((await manager.load(root))?.lifecycle).toBe('completed');
    });
  });

  describe('--token on mutating commands', () => {
    it.each(['pass --step 1', 'fail --step 1', 'goto 2', 'stop', 'complete'])(
      'refuses a bare `%s` with TOKEN_REQUIRED naming owner_token from runbook_started',
      async (command) => {
        await startManual();
        const result = await runCliInProcess(command, workspace);
        expect(result.exitCode).toBe(1);
        const error = errorEnvelope(result.stdout);
        expect(error?.code).toBe('TOKEN_REQUIRED');
        expect(String(error?.error)).toContain('owner_token');
        expect(String(error?.error)).toContain('runbook_started');
      },
    );

    it('refuses a well-formed token no run carries with UNKNOWN_TOKEN', async () => {
      await startManual();
      const result = await runCliInProcess(`pass --token ${UNKNOWN_TOKEN} --step 1`, workspace);
      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)?.code).toBe('UNKNOWN_TOKEN');
    });

    it('refuses a malformed token with INVALID_SYNTAX without echoing it', async () => {
      await startManual();
      const result = await runCliInProcess('pass --token not-a-token --step 1', workspace);
      expect(result.exitCode).toBe(1);
      const error = errorEnvelope(result.stdout);
      expect(error?.code).toBe('INVALID_SYNTAX');
      expect(String(error?.error)).not.toContain('not-a-token');
    });

    it('refuses --run alongside --token with INVALID_SYNTAX', async () => {
      const { token, runId } = await startManual();
      const result = await runCliInProcess(
        `pass --token ${token} --run ${runId} --step 1`,
        workspace,
      );
      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)?.code).toBe('INVALID_SYNTAX');
    });

    it('refuses the token of a completed run with RD-303 naming the lifecycle', async () => {
      const { token } = await startManual();
      expect((await runCliInProcess(`pass --token ${token} --step 1`, workspace)).exitCode).toBe(0);
      expect((await runCliInProcess(`pass --token ${token} --step 2`, workspace)).exitCode).toBe(0);
      const late = await runCliInProcess(`pass --token ${token} --step 2`, workspace);
      expect(late.exitCode).toBe(1);
      const error = errorEnvelope(late.stdout);
      expect(error?.code).toBe('RD-303');
      expect(error?.details).toMatchObject({ lifecycle: 'completed' });
    });

    it('refuses the token of a stopped run with RD-304 naming the lifecycle', async () => {
      const { token } = await startManual();
      const stop = await runCliInProcess(`stop --token ${token}`, workspace);
      expect(stop.exitCode).toBe(1);
      const late = await runCliInProcess(`complete --token ${token}`, workspace);
      expect(late.exitCode).toBe(1);
      const error = errorEnvelope(late.stdout);
      expect(error?.code).toBe('RD-304');
      expect(error?.details).toMatchObject({ lifecycle: 'stopped' });
    });
  });

  describe('--step contract', () => {
    it('accepts --step naming the current top-level step', async () => {
      const { token } = await startManual();
      const result = await runCliInProcess(`pass --token ${token} --step 1`, workspace);
      expect(result.exitCode).toBe(0);
      const action = envelopes(result.stdout).find((document) => document.kind === 'action');
      expect(action).toMatchObject({ action: 'CONTINUE', from: '1', at: '2', stepResult: 'PASS' });
    });

    it('refuses a missing --step with INVALID_STEP naming the current position', async () => {
      const { token } = await startManual();
      const result = await runCliInProcess(`pass --token ${token}`, workspace);
      expect(result.exitCode).toBe(1);
      const error = errorEnvelope(result.stdout);
      expect(error?.code).toBe('INVALID_STEP');
      expect(String(error?.error)).toContain('--step is required');
      expect(String(error?.error)).toContain('the current position is 1');
    });

    it('refuses --step naming a later step with INVALID_STEP and writes nothing', async () => {
      const { token, runId } = await startManual();
      const result = await runCliInProcess(`pass --token ${token} --step 2`, workspace);
      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)?.code).toBe('INVALID_STEP');
      const status = await runCliInProcess(`status --run ${runId}`, workspace);
      const detail = envelopes(status.stdout).find((document) => document.kind === 'status');
      expect(detail?.position).toMatchObject({ current: '1' });
    });

    it('requires the substep id at a substep and accepts it', async () => {
      const start = await runCliInProcess('run manual-substeps.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      const token = requireOwnerToken(start.stdout);
      const bare = await runCliInProcess(`pass --token ${token} --step 1`, workspace);
      expect(bare.exitCode).toBe(1);
      const error = errorEnvelope(bare.stdout);
      expect(error?.code).toBe('INVALID_STEP');
      expect(String(error?.error)).toContain('1.1');
      const first = await runCliInProcess(`pass --token ${token} --step 1.1`, workspace);
      expect(first.exitCode).toBe(0);
      const second = await runCliInProcess(`pass --token ${token} --step 1.2`, workspace);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain('runbook_completed');
    });
  });

  describe('aliases', () => {
    it('yes/ok/no take the same --token and --step', async () => {
      const { token } = await startManual();
      const yes = await runCliInProcess(`yes --token ${token} --step 1`, workspace);
      expect(yes.exitCode).toBe(0);
      const no = await runCliInProcess(`no --token ${token} --step 2`, workspace);
      expect(no.exitCode).toBe(1);
      const stopped = envelopes(no.stdout).find((document) => document.kind === 'action');
      expect(stopped).toMatchObject({ stopped: true, stepResult: 'FAIL', from: '2' });
      const bare = await runCliInProcess('ok --step 1', workspace);
      expect(errorEnvelope(bare.stdout)?.code).toBe('TOKEN_REQUIRED');
    });
  });

  describe('status', () => {
    it('lists every run bare, with id, runbook, lifecycle and position, and never a token', async () => {
      const { runId } = await startManual();
      const status = await runCliInProcess('status', workspace);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).not.toContain('rdo_');
      const detail = envelopes(status.stdout).find((document) => document.kind === 'status');
      expect(detail?.runs).toEqual([
        expect.objectContaining({
          id: runId,
          runbook: 'manual.runbook.md',
          status: 'running',
          step: '1',
          total: 2,
        }),
      ]);
    });

    it('shows one run with --run and never a token', async () => {
      const { runId } = await startManual();
      const status = await runCliInProcess(`status --run ${runId}`, workspace);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).not.toContain('rdo_');
      const detail = envelopes(status.stdout).find((document) => document.kind === 'status');
      expect(detail).toMatchObject({ active: true, runId, position: { current: '1', total: 2 } });
    });

    it('refuses an unknown --run with RUN_TARGET_UNAVAILABLE', async () => {
      const status = await runCliInProcess(
        'status --run rd_00000000000000000000000000000000',
        workspace,
      );
      expect(status.exitCode).toBe(1);
      expect(errorEnvelope(status.stdout)?.code).toBe('RUN_TARGET_UNAVAILABLE');
    });
  });

  describe('prune', () => {
    it('retains a running run without a token and reports why', async () => {
      const { runId } = await startManual();
      const prune = await runCliInProcess('prune --active', workspace);
      expect(prune.exitCode).toBe(0);
      const rows = parseConcatenatedJson(prune.stdout).flat() as Record<string, unknown>[];
      expect(rows).toEqual([
        expect.objectContaining({ id: runId, status: 'running', retained: 'token required' }),
      ]);
      const status = await runCliInProcess('status', workspace);
      const detail = envelopes(status.stdout).find((document) => document.kind === 'status');
      expect(detail?.runs).toHaveLength(1);
    });

    it('deletes the one running run its --token names', async () => {
      const { token, runId } = await startManual();
      const prune = await runCliInProcess(`prune --token ${token}`, workspace);
      expect(prune.exitCode).toBe(0);
      const rows = parseConcatenatedJson(prune.stdout).flat() as Record<string, unknown>[];
      expect(rows).toEqual([expect.objectContaining({ id: runId, status: 'running' })]);
      expect(rows[0]).not.toHaveProperty('retained');
      const status = await runCliInProcess('status', workspace);
      const detail = envelopes(status.stdout).find((document) => document.kind === 'status');
      expect(detail?.runs).toEqual([]);
    });

    it('refuses an unknown --token with UNKNOWN_TOKEN', async () => {
      await startManual();
      const prune = await runCliInProcess(`prune --token ${UNKNOWN_TOKEN}`, workspace);
      expect(prune.exitCode).toBe(1);
      expect(errorEnvelope(prune.stdout)?.code).toBe('UNKNOWN_TOKEN');
    });
  });
});
