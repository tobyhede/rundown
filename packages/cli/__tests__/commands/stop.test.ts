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
// Jest's static inverse-module graph so `--findRelatedTests src/commands/stop.ts`
// credits the behavioural tests below (which reach the command only via the
// dynamic `import('../cli.js')` seam in runCliInProcess).
import { registerStopCommand } from '../../src/commands/stop.js';

describe('stop command wiring', () => {
  it('registers the stop command with its documented flags and descriptions', () => {
    const program = new Command();
    registerStopCommand(program);

    const stop = program.commands.find((c) => c.name() === 'stop');
    expect(stop).toBeDefined();
    expect(stop?.description()).toBe('Abort a running runbook');

    const byLong = new Map(stop!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()]).toEqual(expect.arrayContaining(['--token', '--run', '--text']));
    expect(byLong.get('--token')?.description).toBe(
      'Owner token of the run to mutate (owner_token from runbook_started)',
    );
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
    // `--run` is the human escape hatch (#906), so it is documented, as human-only.
    expect(byLong.get('--run')?.hidden).toBe(false);
    expect(byLong.get('--run')?.description).toContain('Human escape hatch for a lost owner token');
    expect(byLong.get('--run')?.description).toContain('never for agents');
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

describe('stop command', () => {
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

    it('refuses a bare stop with TOKEN_REQUIRED and leaves the run running', async () => {
      const result = await runCliInProcess('stop', workspace);

      expect(result.exitCode).toBe(1);
      const envelope = errorEnvelope(result.stdout);
      expect(envelope?.code).toBe('TOKEN_REQUIRED');
      expect(envelope?.command).toBe('stop');
      expect(String(envelope?.error)).toContain('owner_token');
      expect((await readRunbookState(workspace, runId))?.lifecycle).toBe('running');
    });

    it('refuses --run alongside --token with INVALID_SYNTAX', async () => {
      const result = await runCliInProcess(['stop', '--token', token, '--run', runId], workspace);

      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)?.code).toBe('INVALID_SYNTAX');
      expect((await readRunbookState(workspace, runId))?.lifecycle).toBe('running');
    });

    it('refuses a well-formed but unknown token with UNKNOWN_TOKEN', async () => {
      const bogus = `rdo_${'A'.repeat(43)}`;

      const result = await runCliInProcess(['stop', '--token', bogus], workspace);

      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)?.code).toBe('UNKNOWN_TOKEN');
      expect((await readRunbookState(workspace, runId))?.lifecycle).toBe('running');
    });

    it('refuses a malformed token with INVALID_SYNTAX', async () => {
      const result = await runCliInProcess(['stop', '--token', 'nope'], workspace);

      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)?.code).toBe('INVALID_SYNTAX');
    });

    it('refuses the token of an already-stopped run with RD-304', async () => {
      expect((await runCliInProcess(['stop', '--token', token], workspace)).exitCode).toBe(1);

      const late = await runCliInProcess(['stop', '--token', token], workspace);

      expect(late.exitCode).toBe(1);
      const envelope = errorEnvelope(late.stdout);
      expect(envelope?.code).toBe('RD-304');
      expect(envelope?.details).toMatchObject({ runId, lifecycle: 'stopped' });
    });

    it('refuses the token of a completed run with RD-303', async () => {
      expect((await runCliInProcess(['complete', '--token', token], workspace)).exitCode).toBe(0);

      const late = await runCliInProcess(['stop', '--token', token], workspace);

      expect(late.exitCode).toBe(1);
      const envelope = errorEnvelope(late.stdout);
      expect(envelope?.code).toBe('RD-303');
      expect(envelope?.details).toMatchObject({ runId, lifecycle: 'completed' });
    });
  });

  describe('basic stop', () => {
    beforeEach(async () => {
      await start('runbooks/simple.runbook.md');
    });

    it('aborts the run its token names', async () => {
      const result = await runCliInProcess(['stop', '--token', token, '--text'], workspace);

      // Stop is a force terminal (failure terminal) and exits 1.
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('STOP');

      const status = await runCliInProcess('status', workspace);
      const detail = parseConcatenatedJson(status.stdout).at(-1) as Record<string, unknown>;
      expect(detail.runs).toEqual([expect.objectContaining({ id: runId, status: 'stopped' })]);
    });

    it('persists stopped state with STOP action metadata', async () => {
      await runCliInProcess(['stop', '--token', token, '--text'], workspace);

      // State should be preserved (not deleted)
      const stateAfter = await readRunbookState(workspace, runId);
      expect(stateAfter).not.toBeNull();
      expect(stateAfter!.lastAction).toEqual({ type: 'STOP', origin: 'direct' });
      expect(stateAfter!.lastResult).toBeUndefined();
      expect(stateAfter!.lifecycle).toBe('stopped');
    });

    it('stops through the machine and persists frontmatter finalVars', async () => {
      const runbook = `---
outputs:
  - Result
---
# Forced Stop Outputs

## 1. Work
- PASS CONTINUE
- FAIL STOP

The result is {{ Result }}.
`;
      await writeFile(join(workspace.cwd, 'forced-stop-output.runbook.md'), runbook);
      await start('forced-stop-output.runbook.md', '--input', 'Result=stop-final');

      const result = await runCliInProcess(
        ['stop', 'Cancelled after review', '--token', token, '--text'],
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const stateAfter = await readRunbookState(workspace, runId);
      expect(stateAfter!.lifecycle).toBe('stopped');
      expect(stateAfter!.lastAction).toEqual({ type: 'STOP', origin: 'direct' });
      expect(stateAfter!.lastResult).toBeUndefined();
      expect(stateAfter!.finalVars).toEqual({ Result: 'stop-final' });
      expect(JSON.stringify(stateAfter!.snapshot)).toContain('Cancelled after review');
    });

    it('prepares FORCE_STOP with the operator message through the actor seam', async () => {
      const prepareSpy = jest.spyOn(RunbookActorService.prototype, 'prepareActorMutation');

      const runbook = `# Stop Null Sync

## 1. Work
- PASS COMPLETE
- FAIL STOP
`;
      await writeFile(join(workspace.cwd, 'stop-null-sync.runbook.md'), runbook);
      await start('stop-null-sync.runbook.md');

      const result = await runCliInProcess(['stop', 'race', '--token', token, '--text'], workspace);

      expect(result.exitCode).toBe(1);
      const forceStopCall = prepareSpy.mock.calls.find((call) => call[3].type === 'FORCE_STOP');
      expect(forceStopCall?.[3]).toEqual({
        type: 'FORCE_STOP',
        message: 'race',
      });
    });

    it('stops only the run its token names when several are running', async () => {
      const first = runId;
      const firstToken = token;
      await start('runbooks/retry.runbook.md');

      const result = await runCliInProcess(['stop', '--token', firstToken], workspace);

      expect(result.exitCode).toBe(1);
      expect((await readRunbookState(workspace, first))?.lifecycle).toBe('stopped');
      expect((await readRunbookState(workspace, runId))?.lifecycle).toBe('running');
    });
  });

  describe('invalid persisted state', () => {
    beforeEach(async () => {
      await start('runbooks/simple.runbook.md');
    });

    it('fails closed on a foreign schemaVersion instead of migrating or deleting it', async () => {
      await patchPersistedRunState(workspace.cwd, runId, {
        schemaVersion: FOREIGN_SCHEMA_VERSION,
      });

      const result = await runCliInProcess(['stop', '--token', token], workspace);

      expect(result.exitCode).toBe(1);
      const envelope = errorEnvelope(result.stdout);
      expect(envelope?.code).toBe('RD-309');
      const reloaded = (await readPersistedRunState(workspace.cwd, runId)) as {
        schemaVersion?: unknown;
      } | null;
      expect(reloaded?.schemaVersion).toBe(FOREIGN_SCHEMA_VERSION);
    });
  });

  describe('stop with message', () => {
    beforeEach(async () => {
      await start('runbooks/simple.runbook.md');
    });

    it('includes custom message in output', async () => {
      const result = await runCliInProcess(
        ['stop', 'User cancelled', '--token', token, '--text'],
        workspace,
      );

      expect(result.exitCode).toBe(1);
      // Text renderer discards the message; just check for STOP
      expect(result.stdout).toContain('STOP');
    });
  });

  describe('on an inline child (#903)', () => {
    /** Parent whose inline substep 1.1 runs child.runbook.md; FAIL takes `failAction`. */
    async function startInline(failAction: 'STOP' | 'CONTINUE'): Promise<string> {
      await writeFile(
        join(workspace.cwd, 'inline.runbook.md'),
        [
          '# Inline',
          '',
          '## 1. Parent',
          '',
          '- PASS ALL CONTINUE',
          `- FAIL ANY ${failAction}`,
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
      const result = await runCliInProcess('run inline.runbook.md', workspace);
      expect(result.exitCode).toBe(0);
      token = requireOwnerToken(result.stdout);
      runId = requireRunId(result.stdout);
      const started = parseConcatenatedJson(result.stdout).filter(
        (document) => (document as Record<string, unknown>).type === 'runbook_started',
      ) as Record<string, unknown>[];
      expect(started).toHaveLength(2);
      return String(started[1]?.runbookId);
    }

    it('ends with the stop action object naming the child and carrying --message, after the progression events', async () => {
      const child = await startInline('STOP');

      const result = await runCliInProcess(['stop', 'Abandon child', '--token', token], workspace);

      // The parent Collects the stopped child as FAIL and its FAIL ANY STOP
      // stops it: the command exits by where progression rests.
      expect(result.exitCode).toBe(1);
      const lines = parseConcatenatedJson(result.stdout) as Record<string, unknown>[];
      expect(
        lines.some((line) => line.type === 'runbook_stopped' && line.runbookId === runId),
      ).toBe(true);
      expect(parseFinalCliJsonObject(result.stdout)).toMatchObject({
        kind: 'action',
        action: 'stop',
        stopped: true,
        runId: child,
        message: 'Abandon child',
      });
      expect((await readRunbookState(workspace, child))?.lifecycle).toBe('stopped');
    });

    it('still ends with the stop action object when the parent continues, exiting clean', async () => {
      const child = await startInline('CONTINUE');

      const result = await runCliInProcess(['stop', '--token', token], workspace);

      // FAIL ANY CONTINUE: the parent moves on and rests waiting at step 2.
      expect(result.exitCode).toBe(0);
      expect(parseFinalCliJsonObject(result.stdout)).toMatchObject({
        kind: 'action',
        action: 'stop',
        stopped: true,
        runId: child,
      });
      expect((await readRunbookState(workspace, runId))?.step).toBe('2');
    });
  });

  describe('JSON output', () => {
    beforeEach(async () => {
      await start('runbooks/simple.runbook.md');
    });

    it('outputs JSON by default', async () => {
      const result = await runCliInProcess(['stop', '--token', token], workspace);

      // Stop is a failure terminal and exits non-zero. It streams a
      // runbook_stopped observation before the final action object, so parse
      // the final newline-delimited JSON object.
      expect(result.exitCode).toBe(1);

      const output = parseFinalCliJsonObject(result.stdout);
      expect(output.action).toBe('stop');
    });

    it('includes metadata in JSON output and never the token', async () => {
      const result = await runCliInProcess(['stop', '--token', token], workspace);

      const output = parseFinalCliJsonObject(result.stdout);
      expect(output.file).toBeDefined();
      expect(output.file).toBe('runbooks/simple.runbook.md');
      expect(output.runId).toBe(runId);
      expect(result.stdout).not.toContain('rdo_');
    });
  });
});
