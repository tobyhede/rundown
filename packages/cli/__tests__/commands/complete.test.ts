import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunbookActorService } from '@rundown-org/core';
import {
  createTestWorkspace,
  runCliInProcess,
  readRunbookState,
  parseConcatenatedJson,
  parseFinalCliJsonObject,
  requireOwnerToken,
  requireRunId,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import {
  FOREIGN_SCHEMA_VERSION,
  patchPersistedRunState,
  readPersistedRunState,
} from '@rundown-org/core/testing/run-fixtures';
import { Command } from 'commander';
// Stryker static-import linkage (mutation testing): links this test file into
// Jest's static inverse-module graph so `--findRelatedTests src/commands/complete.ts`
// credits the behavioural tests below (which reach the command only via the
// dynamic `import('../cli.js')` seam in runCliInProcess).
import { registerCompleteCommand } from '../../src/commands/complete.js';

describe('complete command wiring', () => {
  it('registers the complete command with its documented flags and descriptions', () => {
    const program = new Command();
    registerCompleteCommand(program);

    const complete = program.commands.find((c) => c.name() === 'complete');
    expect(complete).toBeDefined();
    expect(complete?.description()).toBe(
      'Force early completion of a running runbook (runbooks auto-complete on final step)',
    );

    const byLong = new Map(complete!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()]).toEqual(expect.arrayContaining(['--token', '--text']));
    expect(byLong.get('--token')?.description).toBe(
      'Owner token of the run to mutate (owner_token from runbook_started)',
    );
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
    // `--run` is accepted only so the combination can be refused INVALID_SYNTAX.
    expect(byLong.get('--run')?.hidden).toBe(true);
  });
});

function errorEnvelope(stdout: string): Record<string, unknown> | undefined {
  return parseConcatenatedJson(stdout).find(
    (document): document is Record<string, unknown> =>
      typeof document === 'object' &&
      document !== null &&
      (document as Record<string, unknown>).kind === 'error',
  );
}

describe('complete command', () => {
  let workspace: TestWorkspace;
  let token: string;
  let runId: string;

  /** Start a prompted run in JSON mode and capture its Owner Token and id. */
  async function start(runbook: string, ...extra: string[]): Promise<void> {
    const result = await runCliInProcess(['run', '--prompted', runbook, ...extra], workspace);
    expect(result.exitCode).toBe(0);
    token = requireOwnerToken(result.stdout);
    runId = requireRunId(result.stdout);
  }

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await workspace.cleanup();
  });

  describe('--token authority', () => {
    beforeEach(async () => {
      await start('runbooks/simple.runbook.md');
    });

    it('refuses a bare complete with TOKEN_REQUIRED and leaves the run running', async () => {
      const result = await runCliInProcess('complete', workspace);

      expect(result.exitCode).toBe(1);
      const envelope = errorEnvelope(result.stdout);
      expect(envelope?.code).toBe('TOKEN_REQUIRED');
      expect(envelope?.command).toBe('complete');
      expect(String(envelope?.error)).toContain('runbook_started');
      expect((await readRunbookState(workspace, runId))?.lifecycle).toBe('running');
    });

    it('refuses --run alongside --token with INVALID_SYNTAX', async () => {
      const result = await runCliInProcess(
        ['complete', '--token', token, '--run', runId],
        workspace,
      );

      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)?.code).toBe('INVALID_SYNTAX');
      expect((await readRunbookState(workspace, runId))?.lifecycle).toBe('running');
    });

    it('refuses a well-formed but unknown token with UNKNOWN_TOKEN', async () => {
      const bogus = `rdo_${'A'.repeat(43)}`;

      const result = await runCliInProcess(['complete', '--token', bogus], workspace);

      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)?.code).toBe('UNKNOWN_TOKEN');
      expect((await readRunbookState(workspace, runId))?.lifecycle).toBe('running');
    });

    it('refuses the token of an already-completed run with RD-303', async () => {
      expect((await runCliInProcess(['complete', '--token', token], workspace)).exitCode).toBe(0);

      const late = await runCliInProcess(['complete', '--token', token], workspace);

      expect(late.exitCode).toBe(1);
      const envelope = errorEnvelope(late.stdout);
      expect(envelope?.code).toBe('RD-303');
      expect(envelope?.details).toMatchObject({ runId, lifecycle: 'completed' });
      // The idempotent-no-op path is gone: a finished run is told how it finished.
      expect(late.stdout).not.toContain('RUNBOOK_NOT_RUNNING');
    });

    it('refuses the token of a stopped run with RD-304', async () => {
      expect((await runCliInProcess(['stop', '--token', token], workspace)).exitCode).toBe(1);

      const late = await runCliInProcess(['complete', '--token', token], workspace);

      expect(late.exitCode).toBe(1);
      const envelope = errorEnvelope(late.stdout);
      expect(envelope?.code).toBe('RD-304');
      expect(envelope?.details).toMatchObject({ runId, lifecycle: 'stopped' });
    });
  });

  it('completes through the machine and persists frontmatter finalVars', async () => {
    const runbook = `---
outputs:
  - Result
---
# Forced Complete Outputs

## 1. Work
- PASS CONTINUE
- FAIL STOP

The result is {{ Result }}.

## 2. Later
- PASS COMPLETE
- FAIL STOP

This step should not become the persisted cursor.
`;
    await writeFile(join(workspace.cwd, 'forced-complete-output.runbook.md'), runbook);
    await start('forced-complete-output.runbook.md', '--input', 'Result=complete-final');
    expect((await readRunbookState(workspace, runId))?.step).toBe('1');

    const result = await runCliInProcess(
      ['complete', 'Enough evidence collected', '--token', token, '--text'],
      workspace,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('COMPLETE');

    const stateAfter = await readRunbookState(workspace, runId);
    expect(stateAfter!.step).toBe('1');
    expect(stateAfter!.lifecycle).toBe('completed');
    expect(stateAfter!.lastAction).toEqual({ type: 'COMPLETE', origin: 'direct' });
    expect(stateAfter!.finalVars).toEqual({ Result: 'complete-final' });
    expect(JSON.stringify(stateAfter!.snapshot)).toContain('Enough evidence collected');

    const status = await runCliInProcess('status', workspace);
    const detail = parseConcatenatedJson(status.stdout).at(-1) as Record<string, unknown>;
    expect(detail.runs).toEqual([expect.objectContaining({ id: runId, status: 'complete' })]);
  });

  it('prepares FORCE_COMPLETE with the operator message through the actor seam', async () => {
    const prepareSpy = jest.spyOn(RunbookActorService.prototype, 'prepareActorMutation');

    const runbook = `# Complete Null Sync

## 1. Work
- PASS COMPLETE
- FAIL STOP
`;
    await writeFile(join(workspace.cwd, 'complete-null-sync.runbook.md'), runbook);
    await start('complete-null-sync.runbook.md');

    const result = await runCliInProcess(
      ['complete', 'race', '--token', token, '--text'],
      workspace,
    );

    expect(result.exitCode).toBe(0);
    const forceCompleteCall = prepareSpy.mock.calls.find(
      (call) => (call[3] as { type: string }).type === 'FORCE_COMPLETE',
    );
    expect(forceCompleteCall?.[3]).toEqual({
      type: 'FORCE_COMPLETE',
      message: 'race',
    });
  });

  it('completes only the run its token names when several are running', async () => {
    await start('runbooks/simple.runbook.md');
    const first = runId;
    const firstToken = token;
    await start('runbooks/retry.runbook.md');

    const result = await runCliInProcess(['complete', '--token', firstToken], workspace);

    expect(result.exitCode).toBe(0);
    expect((await readRunbookState(workspace, first))?.lifecycle).toBe('completed');
    expect((await readRunbookState(workspace, runId))?.lifecycle).toBe('running');
  });

  it('renders the complete action with metadata in JSON and never the token', async () => {
    await start('runbooks/simple.runbook.md');

    const result = await runCliInProcess(['complete', '--token', token], workspace);

    expect(result.exitCode).toBe(0);
    const output = parseFinalCliJsonObject(result.stdout);
    expect(output.action).toBe('complete');
    expect(output.file).toBe('runbooks/simple.runbook.md');
    expect(output.runId).toBe(runId);
    expect(result.stdout).not.toContain('rdo_');
  });

  it('on an inline child (#903), ends with the complete action object naming the child and carrying --message', async () => {
    await writeFile(
      join(workspace.cwd, 'inline.runbook.md'),
      [
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
      ].join('\n'),
    );
    await writeFile(
      join(workspace.cwd, 'child.runbook.md'),
      ['# Child', '', '## Check', '', '- PASS COMPLETE', '- FAIL STOP', '', 'Check.', ''].join(
        '\n',
      ),
    );
    const started = await runCliInProcess('run inline.runbook.md', workspace);
    expect(started.exitCode).toBe(0);
    token = requireOwnerToken(started.stdout);
    runId = requireRunId(started.stdout);
    const child = String(
      (
        parseConcatenatedJson(started.stdout).filter(
          (document) => (document as Record<string, unknown>).type === 'runbook_started',
        )[1] as Record<string, unknown> | undefined
      )?.runbookId,
    );

    const result = await runCliInProcess(['complete', 'Child done', '--token', token], workspace);

    // The parent Collects the completed child as PASS and rests waiting at step 2.
    expect(result.exitCode).toBe(0);
    expect(parseFinalCliJsonObject(result.stdout)).toMatchObject({
      kind: 'action',
      action: 'complete',
      complete: true,
      runId: child,
      message: 'Child done',
    });
    expect((await readRunbookState(workspace, child))?.lifecycle).toBe('completed');
    expect((await readRunbookState(workspace, runId))?.step).toBe('2');
  });

  it('fails closed on a foreign schemaVersion instead of migrating or deleting it', async () => {
    await start('runbooks/simple.runbook.md');
    await patchPersistedRunState(workspace.cwd, runId, {
      schemaVersion: FOREIGN_SCHEMA_VERSION,
    });

    const result = await runCliInProcess(['complete', '--token', token], workspace);

    expect(result.exitCode).toBe(1);
    expect(errorEnvelope(result.stdout)?.code).toBe('RD-309');
    const reloaded = (await readPersistedRunState(workspace.cwd, runId)) as {
      schemaVersion?: unknown;
    } | null;
    expect(reloaded?.schemaVersion).toBe(FOREIGN_SCHEMA_VERSION);
  });
});
