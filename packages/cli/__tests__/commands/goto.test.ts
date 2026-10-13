import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  parseConcatenatedJson,
  readRunbookState,
  requireOwnerToken,
  requireRunId,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { Command } from 'commander';
// Stryker static-import linkage (mutation testing): links this test file into
// Jest's static inverse-module graph so `--findRelatedTests src/commands/goto.ts`
// credits the behavioural tests below (which reach the command only via the
// dynamic `import('../cli.js')` seam in runCliInProcess).
import { registerGotoCommand } from '../../src/commands/goto.js';

describe('goto command wiring', () => {
  it('registers the goto command with its documented flags and descriptions', () => {
    const program = new Command();
    registerGotoCommand(program);

    const goto = program.commands.find((c) => c.name() === 'goto');
    expect(goto).toBeDefined();
    expect(goto?.description()).toBe('Jump to specific step (e.g., "3" or "3.1" for substep)');

    const byLong = new Map(goto!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()]).toEqual(expect.arrayContaining(['--index', '--token', '--text']));
    expect(byLong.get('--index')?.description).toBe('FOR loop iteration to target');
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

describe('goto command', () => {
  let workspace: TestWorkspace;
  let token: string;
  let runId: string;

  async function start(runbook: string): Promise<void> {
    const result = await runCliInProcess(`run --prompted ${runbook}`, workspace);
    expect(result.exitCode).toBe(0);
    token = requireOwnerToken(result.stdout);
    runId = requireRunId(result.stdout);
  }

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('step jump (goto N)', () => {
    beforeEach(async () => {
      await start('runbooks/goto.runbook.md');
    });

    it('jumps to specified step number', async () => {
      const result = await runCliInProcess(['goto', '3', '--token', token, '--text'], workspace);

      expect(result.exitCode).toBe(0);
      const state = await readRunbookState(workspace, runId);
      expect(state?.step).toBe('3');
    });

    it('resets retryCount on jump', async () => {
      await start('runbooks/retry.runbook.md');

      // Increment retry by failing on a FAIL: RETRY condition
      const failed = await runCliInProcess(['fail', '--token', token, '--step', '1'], workspace);
      expect(failed.exitCode).toBe(0);
      await runCliInProcess(['goto', '2', '--token', token, '--text'], workspace);

      const state = await readRunbookState(workspace, runId);
      expect(state?.retryCount).toBe(0);
    });

    it('clears stale lastResult without rewriting machine-owned GOTO lastAction', async () => {
      await start('runbooks/retry.runbook.md');
      await runCliInProcess(['fail', '--token', token, '--step', '1'], workspace);

      const result = await runCliInProcess(['goto', '2', '--token', token, '--text'], workspace);

      expect(result.exitCode).toBe(0);
      const state = await readRunbookState(workspace, runId);
      expect(state?.lastResult).toBeUndefined();
      expect(state?.lastAction).toEqual({ type: 'GOTO', origin: 'direct', target: '2' });
    });

    it('outputs jumped step info', async () => {
      const result = await runCliInProcess(['goto', '3', '--token', token, '--text'], workspace);

      expect(result.stdout).toContain('Action:   GOTO 3');
      expect(result.stdout).toContain('Jump target');
    });
  });

  describe('--token authority', () => {
    beforeEach(async () => {
      await start('runbooks/goto.runbook.md');
    });

    it('refuses a bare goto with TOKEN_REQUIRED and navigates nothing', async () => {
      const result = await runCliInProcess(['goto', '3'], workspace);

      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)?.code).toBe('TOKEN_REQUIRED');
      const state = await readRunbookState(workspace, runId);
      expect(state?.step).toBe('1');
    });

    it('refuses a well-formed token no run carries with UNKNOWN_TOKEN', async () => {
      const bogus = `rdo_${'A'.repeat(43)}`;

      const result = await runCliInProcess(['goto', '3', '--token', bogus], workspace);

      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)?.code).toBe('UNKNOWN_TOKEN');
      const state = await readRunbookState(workspace, runId);
      expect(state?.step).toBe('1');
    });

    it('refuses --run alongside --token with INVALID_SYNTAX', async () => {
      const result = await runCliInProcess(
        ['goto', '3', '--token', token, '--run', runId],
        workspace,
      );

      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)?.code).toBe('INVALID_SYNTAX');
    });

    it('refuses the token of a stopped run with RD-304', async () => {
      await runCliInProcess(['stop', '--token', token], workspace);

      const result = await runCliInProcess(['goto', '3', '--token', token], workspace);

      expect(result.exitCode).toBe(1);
      const envelope = errorEnvelope(result.stdout);
      expect(envelope?.code).toBe('RD-304');
      expect(envelope?.details).toMatchObject({ runId, lifecycle: 'stopped' });
    });
  });

  describe('error handling', () => {
    it('rejects invalid step numbers', async () => {
      await start('runbooks/goto.runbook.md');

      const result = await runCliInProcess(['goto', '999', '--token', token, '--text'], workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('STEP_NOT_FOUND');
    });

    it('requires step number argument', async () => {
      const result = await runCliInProcess('goto --text', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('missing required argument');
    });

    it('rejects AT on non-FOR step', async () => {
      await start('runbooks/goto.runbook.md');

      const result = await runCliInProcess(
        ['goto', '2 AT 5', '--token', token, '--text'],
        workspace,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('INVALID_AT_TARGET');
    });
  });
});
